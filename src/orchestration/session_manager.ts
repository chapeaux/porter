/**
 * Session Manager — manages multiple concurrent Porter sessions.
 *
 * Each session has its own MessageBus, BusServer, RateLimitCoordinator,
 * GraphStore, and agent Worker isolates. Sessions are created/stopped
 * dynamically via the UI API.
 *
 * The global bus/graph-store singletons (getBus(), initGraphStore()) are NOT
 * used here — every session receives its own freshly-constructed instances
 * so that agent mailboxes, subscriptions, relay lists, and memory are fully
 * isolated between sessions.
 */

import type { PorterConfig } from "../core/config.ts";
import { type Porter, start } from "./orchestrator.ts";
import { MessageBus, BusServer } from "../runtime/bus.ts";
import { RateLimitCoordinator } from "../runtime/rate_limiter.ts";
import { GraphStore } from "../graph/store.ts";
import { snapshotPath } from "../runtime/snapshot.ts";
import {
  registerSession,
  unregisterSession,
} from "./registry.ts";
import { NullTransport } from "./transport.ts";

/**
 * Find a port that is actually free at the OS level.
 *
 * Attempts to bind each port starting from `start`; closes the test
 * listener immediately on success and returns that port number. This
 * catches ports that are still held by a not-yet-closed BusServer even
 * though the registry entry has already been removed — a scenario that
 * `findAvailablePort()` (registry-only) cannot detect.
 *
 * Tries up to 100 consecutive ports before giving up.
 */
async function findUsablePort(start: number): Promise<number> {
  let port = start;
  for (let attempts = 0; attempts < 100; attempts++) {
    try {
      const listener = Deno.listen({ port, hostname: "0.0.0.0" });
      listener.close();
      return port;
    } catch {
      port++;
    }
  }
  throw new Error(`No available port found starting from ${start}`);
}

/** A managed session with its own bus and agents. */
export interface ManagedSession {
  /** Session name. */
  name: string;
  /** The running Porter instance. */
  porter: Porter;
  /** Session config. */
  config: PorterConfig;
  /** In-memory message bus for this session. */
  bus: MessageBus;
  /** Bus server for this session. */
  busServer: BusServer;
  /** Bus port allocated for this session. */
  busPort: number;
  /** Memory graph for this session (not the global singleton — see module doc). */
  graphStore: GraphStore;
  /** Stable team identity (config.session before any per-launch uniquified override). Keys durable memory. */
  teamName: string;
  /** ISO timestamp when the session was created. */
  startedAt: string;
  /** Current lifecycle status. */
  status: "running" | "stopping" | "stopped";
  /** User ID of the session owner. Undefined for legacy/local-mode sessions. */
  ownerId?: string;
}

/**
 * Manages multiple concurrent Porter sessions within a single process.
 *
 * Each call to `createSession()` allocates a fresh MessageBus, BusServer,
 * and RateLimitCoordinator so sessions are fully isolated from one another.
 * Bus ports are assigned dynamically starting from 8788 (8787 is reserved
 * for the admin/cross-session bus used by Phase E).
 */
export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private defaultSandbox: boolean;

  constructor(options?: { defaultSandbox?: boolean }) {
    this.defaultSandbox = options?.defaultSandbox ?? false;
  }

  /**
   * Create and start a new session from a config object.
   *
   * Allocates a bus port, constructs isolated bus + coordinator instances,
   * starts the BusServer, and launches the orchestrator with NullTransport
   * (headless — no tmux required).
   *
   * Throws if a session with the same name is already running.
   */
  async createSession(
    config: PorterConfig,
    options?: { restoreFrom?: string; sessionName?: string; ownerId?: string },
  ): Promise<ManagedSession> {
    // config.session is the stable team identity (as saved via /api/teams);
    // options.sessionName, when given, is a per-launch uniquified override
    // (so the same team can be launched more than once concurrently). Capture
    // the original before it's overwritten — durable memory is keyed by team
    // identity, not by the disposable per-launch session name.
    const teamName = config.session;

    const effectiveConfig = options?.sessionName
      ? { ...config, session: options.sessionName }
      : config;

    if (this.sessions.has(effectiveConfig.session)) {
      throw new Error(`Session '${effectiveConfig.session}' already exists`);
    }

    config = effectiveConfig;

    if (this.defaultSandbox && !config.sandbox) {
      config.sandbox = { enabled: true };
    }

    // Workspace directory: respect user-specified paths, otherwise generate
    // a unique directory to prevent cross-run contamination.
    const wsBase = Deno.env.get("PORTER_WORKSPACE_DIR") ??
      `${Deno.env.get("HOME") ?? Deno.cwd()}/.porter/workspaces`;
    const userSpecifiedDir = config.working_dir && config.working_dir !== "." && !config.working_dir.startsWith(wsBase);
    if (!userSpecifiedDir) {
      const restoring = !!options?.restoreFrom;
      if (!restoring || !config.working_dir?.startsWith(wsBase)) {
        const suffix = Date.now().toString(36);
        config.working_dir = `${wsBase}/${config.session}-${suffix}`;
      }
      if (!config.working_dir) {
        config.working_dir = `${wsBase}/${config.session}`;
      }
    }

    // Probe the OS for a free port — 8787 is reserved for the admin bus (Phase E).
    // findUsablePort() does an actual bind test, catching ports still held by
    // a not-yet-closed BusServer that the file registry wouldn't know about.
    const busPort = await findUsablePort(8788);

    // Per-session bus: fully isolated from other sessions and from the global singleton
    const bus = new MessageBus();
    const busServer = new BusServer(bus);
    busServer.start(busPort);

    // Per-session rate limiter with a cooldown callback that broadcasts to
    // remote workers connected to this session's BusServer
    const coordinator = new RateLimitCoordinator();
    coordinator.onCooldown = (state) => {
      busServer.broadcast({
        type: "rate_limit",
        cooldownRemainingMs: state.cooldownRemainingMs,
      });
    };

    // Per-session memory graph: fully isolated from other sessions and from
    // the global singleton, same reasoning as the bus/coordinator above.
    const graphStore = await GraphStore.create();

    try {
      // Launch the orchestrator, injecting the per-session bus, coordinator,
      // and graph store so that all agent subscriptions, publishes,
      // rate-limit coordination, and memory are scoped to this session only.
      const porter = await start(config, {
        transport: new NullTransport(),
        bus,
        coordinator,
        graphStore,
        teamName,
        restoreFrom: options?.restoreFrom,
      });

      // Register agent roster as a sticky message so that UI clients which
      // connect after session creation still receive the full agent list.
      // orchestrator.start() already publishes the roster to the in-memory bus
      // (for agents currently connected), but the BusServer replays sticky
      // messages to every new WebSocket subscriber — essential for the UI.
      // This mirrors the pattern used in cli.ts cmdStart().
      const roster = config.agents.map((a) => ({
        name: a.name,
        role: a.role,
        model: a.model ?? config.model,
        tools: a.tools,
        subscribe: a.subscribe,
      }));
      busServer.addStickyMessage(
        "activity",
        JSON.stringify({ event: "roster", agents: roster }),
        "porter",
      );

      const startedAt = new Date().toISOString();

      // Register in global registry so `porter sessions` and the UI's
      // /api/sessions endpoint can discover this session
      await registerSession({
        session: config.session,
        configPath: "(dynamic)",
        workingDir: config.working_dir ?? "/workspace",
        repoUrl: config.repo?.url,
        busPort,
        pid: Deno.pid,
        startedAt,
        agentCount: config.agents.length,
        status: "running",
        ownerId: options?.ownerId,
      });

      const managed: ManagedSession = {
        name: config.session,
        porter,
        config,
        bus,
        busServer,
        busPort,
        graphStore,
        teamName,
        startedAt,
        status: "running",
        ownerId: options?.ownerId,
      };

      this.sessions.set(config.session, managed);
      return managed;
    } catch (err) {
      // Release the port so the next launch attempt doesn't get EADDRINUSE.
      // This can happen if start() throws (bad config, API key missing, etc.).
      console.error(
        `[session-manager] Failed to create session '${config.session}': ${(err as Error).message}`,
      );
      try {
        await busServer.stop();
      } catch { /* stop() may fail if the server didn't fully start */ }
      throw err;
    }
  }

  /**
   * Stop a session gracefully.
   *
   * Saves a snapshot, stops the Porter orchestrator (sends cancel to all
   * agent isolates, waits up to 10 s, force-terminates stragglers), shuts
   * down the BusServer, and unregisters from the global registry.
   *
   * Returns the path of the saved snapshot.
   * Throws if the session is not found.
   */
  async stopSession(name: string): Promise<string> {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session '${name}' not found`);

    session.status = "stopping";

    // Save snapshot first so we have agent state even if stop() fails
    const snapPath = await session.porter.snapshot();

    // Stop the porter instance: cancels isolates, saves another snapshot
    // internally, kills the tmux/NullTransport session
    await session.porter.stop();

    // Shut down the WebSocket bus server for this session
    await session.busServer.stop();

    // Remove from global registry
    await unregisterSession(name);

    session.status = "stopped";
    this.sessions.delete(name);

    return snapPath;
  }

  /**
   * Delete a session — stops it if running, then removes its snapshot directory.
   *
   * Safe to call on an already-stopped session (unregister is idempotent).
   */
  async deleteSession(name: string): Promise<void> {
    // Stop if still tracked as running
    if (this.sessions.has(name)) {
      await this.stopSession(name);
    }

    // Remove snapshot directory for this session
    const snapFile = snapshotPath(name);
    // snapshotPath returns e.g. ~/.porter/snapshots/<session>/latest.json
    // Strip the filename to get the session-scoped directory
    const snapDir = snapFile.replace(/\/[^/]+$/, "");
    try {
      await Deno.remove(snapDir, { recursive: true });
    } catch {
      // Snapshot directory may not exist — not an error
    }

    // Ensure registry entry is gone even if stopSession was not called
    await unregisterSession(name);
  }

  /**
   * Edit a running session: stop it (saving snapshot), then restart
   * with the new config while restoring agent conversation history.
   *
   * Agents with the same name in old and new configs retain their
   * conversation history. Renamed or removed agents start fresh.
   */
  async editSession(
    name: string,
    newConfig: PorterConfig,
  ): Promise<ManagedSession> {
    const snapPath = await this.stopSession(name);
    return this.createSession(newConfig, { restoreFrom: snapPath });
  }

  /**
   * Get a managed session by name. Returns undefined if not found.
   */
  getSession(name: string): ManagedSession | undefined {
    return this.sessions.get(name);
  }

  /**
   * List all currently managed (running or stopping) sessions.
   */
  listSessions(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /**
   * List sessions owned by a specific user.
   *
   * Returns only sessions whose ownerId matches the given value.
   * Sessions with no ownerId (legacy/local-mode) are excluded.
   */
  listSessionsForUser(ownerId: string): ManagedSession[] {
    return [...this.sessions.values()].filter(s => s.ownerId === ownerId);
  }

  /**
   * Assert that the requester owns the given session.
   *
   * Returns the session if ownership is verified.
   * Throws if the session is not found or belongs to another user.
   * Sessions with no ownerId (legacy/local-mode) are accessible to all.
   */
  async restartAgent(sessionName: string, agentName: string): Promise<void> {
    const session = this.sessions.get(sessionName);
    if (!session) throw new Error(`Session '${sessionName}' not found`);
    await session.porter.restartAgent(agentName);
  }

  assertOwner(name: string, requesterId: string): ManagedSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session '${name}' not found`);
    }
    if (session.ownerId && session.ownerId !== requesterId) {
      throw new Error(`Access denied: session '${name}' belongs to another user`);
    }
    return session;
  }

  /**
   * Check whether a session with the given name exists.
   */
  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  /**
   * Stop all sessions gracefully.
   *
   * Errors from individual session stops are logged but do not abort
   * the remaining stops — all sessions are attempted.
   */
  async stopAll(): Promise<void> {
    // Snapshot the keys first: stopSession() mutates this.sessions
    const names = [...this.sessions.keys()];
    for (const name of names) {
      try {
        await this.stopSession(name);
      } catch (err) {
        console.error(
          `[session-manager] Error stopping '${name}': ${(err as Error).message}`,
        );
      }
    }
  }
}
