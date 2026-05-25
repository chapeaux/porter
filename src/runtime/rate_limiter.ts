/**
 * Coordinated rate limit handling for multi-agent orchestration.
 *
 * When multiple agents share the same API key, a 429 from one agent
 * means the others will hit it too.  The RateLimitCoordinator:
 *
 * 1. Gates every API call through `acquire()` so agents block during
 *    a global cooldown instead of each independently discovering the
 *    rate limit.
 * 2. Staggers retries so agents resume one at a time rather than in
 *    a thundering herd.
 * 3. Adds jitter to all backoff delays to decorrelate retry times.
 */

import type { CancelSignal } from "./agent.ts";

/** Snapshot of the coordinator's cooldown state (for bus relay). */
export interface RateLimitState {
  /** Milliseconds remaining in the current cooldown (0 = none). */
  cooldownRemainingMs: number;
}

/**
 * Centralized rate-limit gate shared by all agents in a process.
 *
 * Every agent calls `acquire()` before making an API request.  When
 * any agent reports a 429, a global cooldown is set and all subsequent
 * `acquire()` calls block until it expires, then agents are released
 * one at a time with a stagger interval.
 */
export class RateLimitCoordinator {
  /** Absolute timestamp (ms) when the current cooldown ends.  0 = no cooldown. */
  private cooldownUntil = 0;

  /** Agents waiting for the cooldown to expire + staggered release. */
  private queue: Array<{ agentName: string; resolve: () => void; cancel?: CancelSignal }> = [];

  /** Whether the drain loop is currently running. */
  private draining = false;

  /** Minimum ms between consecutive agent releases after cooldown. */
  private staggerMs: number;

  /** Optional callback fired when a cooldown is set (for bus broadcast). */
  onCooldown: ((state: RateLimitState) => void) | null = null;

  constructor(options?: { staggerMs?: number }) {
    this.staggerMs = options?.staggerMs ?? 2_000;
  }

  /**
   * Acquire a slot before making an API call.
   *
   * - Returns immediately if no cooldown is active and the queue is empty.
   * - Blocks until cooldown expires + staggered release otherwise.
   * - Throws if `cancel.cancelled` becomes true while waiting.
   */
  async acquire(agentName: string, cancel?: CancelSignal): Promise<void> {
    // Fast path: no cooldown, nobody queued, not draining.
    const now = Date.now();
    if (now >= this.cooldownUntil && this.queue.length === 0 && !this.draining) {
      return;
    }

    // Slow path: wait for cooldown + stagger.
    return new Promise<void>((resolve, reject) => {
      // Check cancel before enqueuing.
      if (cancel?.cancelled) {
        reject(new Error("Cancelled"));
        return;
      }

      this.queue.push({
        agentName,
        cancel,
        resolve: () => {
          if (cancel?.cancelled) {
            reject(new Error("Cancelled"));
          } else {
            resolve();
          }
        },
      });

      // Kick off the drain loop if it isn't running.
      this.scheduleDrain();
    });
  }

  /**
   * Report a rate-limit error.  Sets a global cooldown so that all
   * agents block on their next `acquire()` call.
   */
  reportRateLimit(agentName: string, retryAfterMs: number): void {
    const until = Date.now() + retryAfterMs;
    this.cooldownUntil = Math.max(this.cooldownUntil, until);

    // Notify the bus relay (orchestrator broadcasts to remote workers).
    if (this.onCooldown) {
      const remaining = this.cooldownUntil - Date.now();
      this.onCooldown({ cooldownRemainingMs: Math.max(0, remaining) });
    }

    // If agents are already queued, the running drain loop will
    // re-check cooldownUntil before releasing them.  If nothing is
    // draining yet, we don't need to start -- the next acquire() will.
  }

  /**
   * Apply cooldown state received from a remote coordinator (bus relay).
   * Uses a relative duration to avoid clock-skew issues between pods.
   */
  applyRemoteState(cooldownRemainingMs: number): void {
    if (cooldownRemainingMs <= 0) return;
    const until = Date.now() + cooldownRemainingMs;
    this.cooldownUntil = Math.max(this.cooldownUntil, until);

    // Kick drain in case agents are already queued locally.
    this.scheduleDrain();
  }

  /**
   * Add jitter to a base delay.
   * Returns `delay + random(0, delay * fraction)`.
   */
  static addJitter(delayMs: number, fraction = 0.5): number {
    return delayMs + Math.random() * delayMs * fraction;
  }

  /** Current cooldown state snapshot. */
  getState(): RateLimitState {
    const remaining = this.cooldownUntil - Date.now();
    return { cooldownRemainingMs: Math.max(0, remaining) };
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.cooldownUntil = 0;
    // Resolve any waiting agents so they don't hang.
    for (const entry of this.queue) {
      entry.resolve();
    }
    this.queue = [];
    this.draining = false;
  }

  // -----------------------------------------------------------------------
  // Internal drain loop
  // -----------------------------------------------------------------------

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.doDrain();
  }

  private async doDrain(): Promise<void> {
    // Sleep in chunks so the drain loop stays responsive to cancellations
    // and new cooldown extensions.
    const POLL_MS = 500;

    try {
      // Wait until cooldown expires.
      while (true) {
        const remaining = this.cooldownUntil - Date.now();
        if (remaining <= 0) break;
        // Drop cancelled entries while waiting.
        this.pruneCancelled();
        if (this.queue.length === 0) return;
        await sleep(Math.min(remaining, POLL_MS));
      }

      // Release queued agents one at a time with stagger.
      while (this.queue.length > 0) {
        // Re-check cooldown -- another reportRateLimit may have arrived.
        const remaining = this.cooldownUntil - Date.now();
        if (remaining > 0) {
          await sleep(Math.min(remaining, POLL_MS));
          continue;
        }

        // Skip cancelled entries.
        this.pruneCancelled();
        if (this.queue.length === 0) break;

        const entry = this.queue.shift()!;
        entry.resolve();

        if (this.queue.length > 0) {
          // Stagger with jitter before releasing the next agent.
          await sleep(RateLimitCoordinator.addJitter(this.staggerMs, 0.5));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Remove queue entries whose cancel signal has fired. */
  private pruneCancelled(): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (entry.cancel?.cancelled) {
        // Trigger rejection via the resolve wrapper.
        entry.resolve();
      } else {
        kept.push(entry);
      }
    }
    this.queue = kept;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _coordinator: RateLimitCoordinator | null = null;

/** Get (or create) the process-wide RateLimitCoordinator. */
export function getCoordinator(): RateLimitCoordinator {
  if (!_coordinator) {
    _coordinator = new RateLimitCoordinator();
  }
  return _coordinator;
}

/**
 * Override the global coordinator singleton.
 * Used by isolate workers to inject a CoordinatorProxy.
 */
export function setCoordinator(coordinator: RateLimitCoordinator): void {
  _coordinator = coordinator;
}

/** Reset the singleton (for testing). */
export function resetCoordinator(): void {
  _coordinator?.reset();
  _coordinator = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
