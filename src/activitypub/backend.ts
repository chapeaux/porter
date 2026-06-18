/**
 * ActivityPub backend interface.
 *
 * Abstracts the deployment-specific behavior behind a common interface
 * so the AP module works identically in standalone and router modes.
 *
 * - StandaloneBackend: uses SessionManager + MessageBus in-process
 * - RouterBackend: provisions pods via PodRegistry, proxies to pods
 */

import { UserStore, type SavedTeam } from "../auth/user_store.ts";
import type { BusMessage } from "../runtime/bus.ts";
import { resolveOwner, listFederated } from "./registry.ts";

/** Opaque handle to a running session. */
export interface SessionHandle {
  sessionName: string;
  ownerId: string;
  teamSlug: string;
  busPort?: number;
  podUrl?: string;
}

/** Session status / metrics summary. */
export interface SessionStatus {
  sessionName: string;
  running: boolean;
  agentCount: number;
  uptime?: number;
  metrics?: {
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    apiCalls: number;
  };
}

/**
 * Backend interface for AP session operations.
 *
 * Implemented differently for standalone (in-process SessionManager)
 * and router (PodRegistry + HTTP proxy) deployment modes.
 */
export interface ActivityPubBackend {
  /** Look up which userId owns a team. */
  resolveTeamOwner(teamSlug: string): Promise<string | null>;

  /** Get a team's configuration. */
  getTeam(ownerId: string, teamSlug: string): Promise<SavedTeam | null>;

  /** List all federated teams. */
  listFederatedTeams(): Promise<
    Array<{ teamSlug: string; ownerId: string }>
  >;

  /**
   * Create a session from a team.
   *
   * In standalone mode: calls SessionManager.createSession().
   * In router mode: provisions a pod, then POST to pod's session API.
   */
  createSession(
    ownerId: string,
    teamSlug: string,
  ): Promise<SessionHandle>;

  /**
   * Send a message to a running session's bus.
   *
   * In standalone mode: publishes to the in-process MessageBus.
   * In router mode: proxies via WebSocket to the pod's bus.
   */
  sendMessage(
    handle: SessionHandle,
    channel: string,
    content: string,
    from: string,
  ): Promise<void>;

  /**
   * Subscribe to session output (agent responses).
   *
   * Returns an unsubscribe function.
   *
   * In standalone mode: subscribes to the MessageBus activity channel.
   * In router mode: opens a WebSocket to the pod.
   */
  onSessionOutput(
    handle: SessionHandle,
    callback: (msg: BusMessage) => void,
  ): Promise<() => void>;

  /** Stop a running session. */
  stopSession(handle: SessionHandle): Promise<void>;

  /** Get session status / metrics. */
  getSessionStatus(
    handle: SessionHandle,
  ): Promise<SessionStatus | null>;
}

// ---------------------------------------------------------------------------
// Standalone backend (in-process SessionManager + MessageBus)
// ---------------------------------------------------------------------------

import type { PorterConfig } from "../core/config.ts";

/** Minimal bus interface needed by StandaloneBackend. */
interface BusLike {
  publish(channel: string, content: string, from?: string): Promise<void>;
  subscribe(subscriberId: string, channels: string[]): void;
  drain(subscriberId?: string, channel?: string): Promise<BusMessage[]>;
}

/** Minimal managed session shape needed by StandaloneBackend. */
interface ManagedSessionLike {
  name: string;
  bus: BusLike;
  busPort: number;
  config: PorterConfig;
  startedAt: string;
  status: string;
}

/** Minimal session manager interface accepted by StandaloneBackend. */
export interface SessionManagerLike {
  getSession(name: string): ManagedSessionLike | undefined;
  createSession(config: unknown, options?: { sessionName?: string; ownerId?: string }): Promise<ManagedSessionLike>;
  stopSession(name: string): Promise<string>;
}

export class StandaloneBackend implements ActivityPubBackend {
  constructor(
    private sessionManager: SessionManagerLike,
    private userStore: UserStore,
  ) {}

  async resolveTeamOwner(teamSlug: string): Promise<string | null> {
    return await resolveOwner(teamSlug);
  }

  async getTeam(ownerId: string, teamSlug: string): Promise<SavedTeam | null> {
    return await this.userStore.getTeam(ownerId, teamSlug);
  }

  async listFederatedTeams(): Promise<Array<{ teamSlug: string; ownerId: string }>> {
    return await listFederated();
  }

  async createSession(ownerId: string, teamSlug: string): Promise<SessionHandle> {
    const team = await this.userStore.getTeam(ownerId, teamSlug);
    if (!team) throw new Error(`Team '${teamSlug}' not found for user '${ownerId}'`);

    const sessionName = `ap-${teamSlug}-${Date.now()}`;
    const managed = await this.sessionManager.createSession(team.config, {
      sessionName,
      ownerId,
    });

    return {
      sessionName: managed.name,
      ownerId,
      teamSlug,
      busPort: managed.busPort,
    };
  }

  async sendMessage(
    handle: SessionHandle,
    channel: string,
    content: string,
    from: string,
  ): Promise<void> {
    const session = this.sessionManager.getSession(handle.sessionName);
    if (!session) throw new Error(`Session '${handle.sessionName}' not found`);
    await session.bus.publish(channel, content, from);
  }

  async onSessionOutput(
    handle: SessionHandle,
    callback: (msg: BusMessage) => void,
  ): Promise<() => void> {
    const session = this.sessionManager.getSession(handle.sessionName);
    if (!session) throw new Error(`Session '${handle.sessionName}' not found`);

    const subscriberId = `ap-bridge-${handle.sessionName}`;
    session.bus.subscribe(subscriberId, ["activity", "log"]);

    const interval = setInterval(async () => {
      const msgs = await session.bus.drain(subscriberId);
      for (const msg of msgs) {
        callback(msg);
      }
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    await this.sessionManager.stopSession(handle.sessionName);
  }

  async getSessionStatus(handle: SessionHandle): Promise<SessionStatus | null> {
    const session = this.sessionManager.getSession(handle.sessionName);
    if (!session) return null;

    const startedAt = new Date(session.startedAt).getTime();
    const uptime = Math.floor((Date.now() - startedAt) / 1000);

    return {
      sessionName: handle.sessionName,
      running: session.status === "running",
      agentCount: session.config.agents.length,
      uptime,
    };
  }
}

// ---------------------------------------------------------------------------
// Router backend (PodRegistry + HTTP proxy to user pods)
// ---------------------------------------------------------------------------

import type { PodRegistry, PodEntry } from "../router/pod_registry.ts";

export class RouterBackend implements ActivityPubBackend {
  constructor(
    private podRegistry: PodRegistry,
    private userStore: UserStore,
  ) {}

  async resolveTeamOwner(teamSlug: string): Promise<string | null> {
    return await resolveOwner(teamSlug);
  }

  async getTeam(ownerId: string, teamSlug: string): Promise<SavedTeam | null> {
    const local = await this.userStore.getTeam(ownerId, teamSlug);
    if (local) return local;

    try {
      const pod = await this.ensurePod(ownerId);
      const resp = await fetch(`${pod.podUrl}/api/teams/${encodeURIComponent(teamSlug)}`);
      if (resp.ok) return (await resp.json()) as SavedTeam;
    } catch { /* pod unavailable */ }
    return null;
  }

  async listFederatedTeams(): Promise<Array<{ teamSlug: string; ownerId: string }>> {
    return await listFederated();
  }

  private async ensurePod(ownerId: string): Promise<PodEntry> {
    let entry = this.podRegistry.get(ownerId);
    if (!entry) {
      entry = await this.podRegistry.provision(ownerId);
    }

    if (!entry.ready) {
      for (let i = 0; i < 30; i++) {
        const ready = await this.podRegistry.checkReady(ownerId);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    this.podRegistry.touch(ownerId);
    return entry;
  }

  async createSession(ownerId: string, teamSlug: string): Promise<SessionHandle> {
    const team = await this.userStore.getTeam(ownerId, teamSlug);
    if (!team) throw new Error(`Team '${teamSlug}' not found for user '${ownerId}'`);

    const pod = await this.ensurePod(ownerId);
    const sessionName = `ap-${teamSlug}-${Date.now()}`;

    const resp = await fetch(`${pod.podUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: team.config,
        sessionName,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create session on pod: ${resp.status} ${text}`);
    }

    return {
      sessionName,
      ownerId,
      teamSlug,
      podUrl: pod.podUrl,
    };
  }

  async sendMessage(
    handle: SessionHandle,
    channel: string,
    content: string,
    from: string,
  ): Promise<void> {
    if (!handle.podUrl) throw new Error("No pod URL for session");

    this.podRegistry.touch(handle.ownerId);
    await fetch(`${handle.podUrl}/api/sessions/${handle.sessionName}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, content, from }),
    });
  }

  async onSessionOutput(
    handle: SessionHandle,
    callback: (msg: BusMessage) => void,
  ): Promise<() => void> {
    if (!handle.podUrl) throw new Error("No pod URL for session");

    const wsUrl = handle.podUrl.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}/ws?session=${handle.sessionName}`);

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data));
        if (data.type === "publish" && (data.channel === "activity" || data.channel === "log")) {
          callback({
            channel: data.channel,
            from: data.from ?? "agent",
            content: data.content,
            timestamp: data.timestamp ?? Date.now(),
          });
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        subscriberId: `ap-bridge-${handle.sessionName}`,
        channels: ["activity", "log"],
      }));
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    if (!handle.podUrl) return;

    await fetch(`${handle.podUrl}/api/sessions/${handle.sessionName}/stop`, {
      method: "POST",
    });
  }

  async getSessionStatus(handle: SessionHandle): Promise<SessionStatus | null> {
    if (!handle.podUrl) return null;

    try {
      const resp = await fetch(`${handle.podUrl}/api/sessions/${handle.sessionName}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      return {
        sessionName: handle.sessionName,
        running: data.status === "running",
        agentCount: data.agentCount ?? 0,
        uptime: data.uptime,
        metrics: data.metrics,
      };
    } catch {
      return null;
    }
  }
}
