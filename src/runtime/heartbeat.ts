/**
 * Heartbeat monitor for agent health tracking.
 *
 * In local mode, the orchestrator owns agent loops directly, so
 * heartbeat is mainly about detecting stuck agents (infinite loops,
 * API timeouts). Each agent loop iteration implicitly beats.
 */

/** Callback invoked when an agent is considered dead. */
export type DeadAgentHandler = (agentName: string) => void | Promise<void>;

export class HeartbeatMonitor {
  private beats = new Map<string, number>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onDead: DeadAgentHandler;
  private timeoutMs: number;

  constructor(timeoutMs: number, onDead: DeadAgentHandler) {
    this.timeoutMs = timeoutMs;
    this.onDead = onDead;
  }

  /** Register an agent to monitor. */
  register(agentName: string): void {
    this.beats.set(agentName, Date.now());
  }

  /** Record a heartbeat for an agent. */
  beat(agentName: string): void {
    this.beats.set(agentName, Date.now());
  }

  /** Remove an agent from monitoring. */
  unregister(agentName: string): void {
    this.beats.delete(agentName);
  }

  /** Start the monitoring loop. */
  start(): void {
    if (this.intervalId) return;

    // Check every 30 seconds
    const checkInterval = Math.min(30_000, this.timeoutMs / 2);

    this.intervalId = setInterval(() => {
      this.check();
    }, checkInterval);
  }

  /** Stop the monitoring loop. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Get the age (ms since last beat) for each agent. */
  ages(): Map<string, number> {
    const now = Date.now();
    const result = new Map<string, number>();
    for (const [name, lastBeat] of this.beats) {
      result.set(name, now - lastBeat);
    }
    return result;
  }

  /** Run a single check for dead agents. */
  private check(): void {
    const now = Date.now();
    for (const [name, lastBeat] of this.beats) {
      if (now - lastBeat > this.timeoutMs) {
        this.onDead(name);
      }
    }
  }
}
