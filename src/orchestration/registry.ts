/**
 * Global session registry.
 *
 * Stores session records in ~/.porter/sessions.json.
 * Multiple orchestrator processes may read/write concurrently,
 * so writes use atomic rename to avoid corruption.
 */

/** A single registered session record. */
export interface SessionRecord {
  /** Session name (unique key). */
  session: string;
  /** Path to the config file that started this session. */
  configPath: string;
  /** Resolved working directory. */
  workingDir: string;
  /** Repo URL if cloned. */
  repoUrl?: string;
  /** Bus WebSocket port. */
  busPort: number;
  /** UI server port (if running). */
  uiPort?: number;
  /** Orchestrator process PID. */
  pid: number;
  /** ISO timestamp when the session started. */
  startedAt: string;
  /** Number of agents in this session. */
  agentCount: number;
  /** Session status. */
  status: "running" | "stopping" | "stopped";
  /** User ID of the session owner. Undefined for legacy/local-mode sessions. */
  ownerId?: string;
}

/** Resolve the registry directory, reading HOME dynamically (for test overrides). */
function registryDir(): string {
  return `${Deno.env.get("HOME") ?? Deno.cwd()}/.porter`;
}

/** Resolve the full registry file path. */
function registryPath(): string {
  return `${registryDir()}/sessions.json`;
}

async function readRegistry(): Promise<SessionRecord[]> {
  try {
    const text = await Deno.readTextFile(registryPath());
    return JSON.parse(text) as SessionRecord[];
  } catch {
    return [];
  }
}

async function writeRegistry(records: SessionRecord[]): Promise<void> {
  const dir = registryDir();
  const path = registryPath();
  await Deno.mkdir(dir, { recursive: true });
  // Atomic write: write to temp file then rename to prevent concurrent corruption
  const tmpPath = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(records, null, 2));
  await Deno.rename(tmpPath, path);
}

/**
 * Register a new session.
 * Replaces any existing record with the same session name (e.g. stale).
 */
export async function registerSession(record: SessionRecord): Promise<void> {
  const records = await readRegistry();
  // Remove any existing record with the same name
  const filtered = records.filter((r) => r.session !== record.session);
  filtered.push(record);
  await writeRegistry(filtered);
}

/**
 * Unregister a session by name.
 */
export async function unregisterSession(session: string): Promise<void> {
  const records = await readRegistry();
  await writeRegistry(records.filter((r) => r.session !== session));
}

/**
 * List all registered sessions.
 */
export async function listSessions(): Promise<SessionRecord[]> {
  return await readRegistry();
}

/**
 * Get a specific session record by name.
 * Returns null if not found.
 */
export async function getSession(
  session: string,
): Promise<SessionRecord | null> {
  const records = await readRegistry();
  return records.find((r) => r.session === session) ?? null;
}

/**
 * Remove dead sessions (where PID is no longer alive).
 * Returns the number of pruned entries.
 */
export async function pruneStale(): Promise<number> {
  const records = await readRegistry();
  const alive: SessionRecord[] = [];
  let pruned = 0;

  for (const record of records) {
    if (await isProcessAlive(record.pid)) {
      alive.push(record);
    } else {
      pruned++;
    }
  }

  if (pruned > 0) {
    await writeRegistry(alive);
  }
  return pruned;
}

/**
 * Find an available bus port starting from the given base port.
 * Skips ports already in use by registered sessions.
 */
export async function findAvailablePort(start: number = 8787): Promise<number> {
  const sessions = await readRegistry();
  const usedPorts = new Set(sessions.map((s) => s.busPort));
  let port = start;
  while (usedPorts.has(port)) port++;
  return port;
}

/** Check if a process with the given PID is alive (signal 0 equivalent). */
async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    // SIGCONT is harmless to a running process; throws if PID doesn't exist
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}
