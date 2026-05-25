/**
 * Session snapshot -- saves and restores agent conversation state
 * and tmux layout.
 */

import { dirname } from "@std/path";
import type { AgentState } from "./agent.ts";
import { serializeState, deserializeState } from "./agent.ts";

/** Snapshot data for the entire session. */
export interface Snapshot {
  /** ISO timestamp when the snapshot was taken. */
  timestamp: string;
  /** Session name. */
  session: string;
  /** Serialized agent states. */
  agents: Record<string, string>;
}

/**
 * Save a snapshot of all agent states to disk.
 */
export async function saveSnapshot(
  path: string,
  session: string,
  agents: Map<string, AgentState>,
): Promise<void> {
  const snapshot: Snapshot = {
    timestamp: new Date().toISOString(),
    session,
    agents: {},
  };

  for (const [name, state] of agents) {
    snapshot.agents[name] = serializeState(state);
  }

  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(snapshot, null, 2));
}

/**
 * Load a snapshot from disk.
 */
export async function loadSnapshot(
  path: string,
): Promise<Snapshot> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as Snapshot;
}

/**
 * Restore agent states from a snapshot.
 */
export function restoreAgentStates(
  snapshot: Snapshot,
): Map<string, AgentState> {
  const states = new Map<string, AgentState>();
  for (const [name, json] of Object.entries(snapshot.agents)) {
    states.set(name, deserializeState(json));
  }
  return states;
}

/**
 * Generate a default snapshot file path.
 *
 * Phase 7: uses the global ~/.porter/snapshots/<session>/latest.json directory
 * so snapshots persist across working directory changes and are centrally managed.
 * The `_workingDir` parameter is kept for backwards-compatibility but ignored.
 */
export function snapshotPath(session: string, _workingDir?: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/snapshots/${session}/latest.json`;
}
