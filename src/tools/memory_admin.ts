import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { GRAPHS, PORTER } from "../graph/vocabulary.ts";
import { COLLECTIONS, embedAndUpsert } from "../vector/mod.ts";

// ---------------------------------------------------------------------------
// Team scoping — set once per isolate at agent start (see isolate.ts).
// Durable memory is keyed by team identity (stable across relaunches),
// not the disposable per-launch session name — see orchestrator.ts's
// `teamName` option and session_manager.ts's capture of config.session
// before its per-launch override.
// ---------------------------------------------------------------------------

let _teamName: string | null = null;

export function setMemoryTeamName(name: string | null): void {
  _teamName = name;
}

/**
 * Exported so main-thread code (src/ui/server.ts) can load/persist the same
 * durable store — module-level state here (_teamName, _loadedTeams) is
 * per-isolate and not reachable from the main thread, which runs in a
 * separate process context from any agent's Worker isolate.
 */
export function durablePath(team: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/durable-memory/${encodeURIComponent(team)}.ttl`;
}

/** Load a team's durable Turtle file (if any) into GRAPHS.durable on `store`. */
export async function loadDurableForTeam(
  store: { load(turtle: string, graph?: string): void },
  team: string,
): Promise<void> {
  try {
    const turtle = await Deno.readTextFile(durablePath(team));
    store.load(turtle, GRAPHS.durable);
  } catch {
    // No durable file yet for this team — that's fine, it starts empty.
  }
}

/** Persist a team's GRAPHS.durable contents back to disk. */
export async function persistDurableForTeam(
  store: { dump(graph?: string): string },
  team: string,
): Promise<void> {
  const path = durablePath(team);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true }).catch(() => {});
  await Deno.writeTextFile(path, store.dump(GRAPHS.durable));
}

// Tracks which teams' durable graphs have already been loaded into this
// isolate's GraphStore, so repeated calls don't reload from disk every time.
const _loadedTeams = new Set<string>();

async function ensureDurableLoaded(
  store: { load(turtle: string, graph?: string): void },
): Promise<void> {
  if (!_teamName || _loadedTeams.has(_teamName)) return;
  await loadDurableForTeam(store, _teamName);
  _loadedTeams.add(_teamName);
}

async function persistDurable(store: { dump(graph?: string): string }): Promise<void> {
  if (!_teamName) return;
  await persistDurableForTeam(store, _teamName);
}

function durableUri(): string {
  return `${PORTER.ns}durable/${crypto.randomUUID()}`;
}

interface ObsRow {
  about?: string;
  finding?: string;
  memoryType?: string;
  discoveredBy?: string;
}

/** Look up an observation's fields in a given named graph by its full URI. */
function lookupObs(
  store: { query(sparql: string): Record<string, string>[] },
  graph: string,
  uri: string,
): ObsRow | null {
  const rows = store.query(`
    SELECT ?about ?finding ?memoryType ?discoveredByAgent WHERE {
      GRAPH <${graph}> {
        <${uri}> porter:about ?about ;
                 porter:finding ?finding .
        OPTIONAL { <${uri}> porter:memoryType ?memoryType }
        OPTIONAL { <${uri}> porter:discoveredBy ?discoveredByAgent }
      }
    }
  `);
  if (rows.length === 0) return null;
  return {
    about: rows[0].about,
    finding: rows[0].finding,
    memoryType: rows[0].memoryType,
    discoveredBy: rows[0].discoveredByAgent,
  };
}

/** Normalize a bare UUID or full URI param into a full observation URI. */
function toObsUri(id: string): string {
  return id.startsWith("http") ? id : `${PORTER.ns}obs/${id}`;
}

function toDurableUri(id: string): string {
  return id.startsWith("http") ? id : `${PORTER.ns}durable/${id}`;
}

const entry: ToolEntry = {
  definition: {
    name: "memory_admin",
    description:
      "Librarian-only: promote local memories to durable cross-session memory, resolve conflicts, or correct the durable store directly.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: {
          type: "string",
          enum: ["promote", "adjudicate", "edit", "delete"],
          description:
            '"promote" a local memory to durable storage. "adjudicate" a conflict flagged by promote. "edit" or "delete" an existing durable entry.',
        },
        id: {
          type: "string",
          description:
            "For promote/adjudicate: the local memory's id (from a memory save result). For edit/delete: the durable entry's id.",
        },
        resolution: {
          type: "string",
          enum: ["supersede", "merge", "reject"],
          description: "Required for adjudicate: how to resolve the conflict.",
        },
        supersedes_id: {
          type: "string",
          description: "Required for adjudicate supersede/merge: the existing durable entry being resolved against.",
        },
        text: {
          type: "string",
          description: "New/merged text for adjudicate (merge) or edit.",
        },
      },
      required: ["method", "id"],
    },
  },

  async execute(params) {
    const method = params.method as string;
    const id = params.id as string | undefined;

    if (!id) {
      return { content: "Error: 'id' parameter is required.", is_error: true };
    }

    const store = getGraphStore();
    if (!store) {
      return {
        content: "Graph store not initialized. Memory tools are not available in this session.",
        is_error: true,
      };
    }
    if (!_teamName) {
      return {
        content: "Team identity not set for this session — durable memory is unavailable.",
        is_error: true,
      };
    }

    try {
      await ensureDurableLoaded(store);

      switch (method) {
        case "promote":
          return await promote(store, id);
        case "adjudicate":
          return await adjudicate(store, id, params);
        case "edit":
          return await editDurable(store, id, params.text as string | undefined);
        case "delete":
          return await deleteDurable(store, id);
        default:
          return {
            content: `Error: 'method' must be one of promote, adjudicate, edit, delete (got: ${method}).`,
            is_error: true,
          };
      }
    } catch (err) {
      return {
        content: `Error in memory_admin: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

type Store = {
  query(sparql: string): Record<string, string>[];
  update(sparql: string): void;
  dump(graph?: string): string;
  load(turtle: string, graph?: string): void;
  addTriple(subject: string, predicate: string, object: string, graph?: string): void;
  addLiteral(subject: string, predicate: string, value: string | number | boolean, graph?: string): void;
};

async function promote(store: Store, id: string) {
  const localUri = toObsUri(id);
  const local = lookupObs(store, GRAPHS.memory, localUri);
  if (!local || !local.about || !local.finding) {
    return { content: `Error: local memory '${id}' not found.`, is_error: true };
  }

  // Only semantic facts need conflict adjudication — episodic/procedural
  // entries are additive by nature (a log entry, or one more lesson).
  if (local.memoryType === "semantic") {
    const conflicts = store.query(`
      SELECT ?d ?finding WHERE {
        GRAPH <${GRAPHS.durable}> {
          ?d a porter:Observation ;
             porter:about "${local.about.replace(/"/g, '\\"')}" ;
             porter:memoryType "semantic" ;
             porter:finding ?finding .
          FILTER NOT EXISTS { ?d porter:validUntil ?u }
        }
      }
    `);
    if (conflicts.length > 0) {
      const conflictId = conflicts[0].d.split("/").pop();
      return {
        content: `Conflict: an existing durable fact about "${local.about}" already exists (id: ${conflictId}): "${conflicts[0].finding}"\n\nCall memory_admin({method:"adjudicate", id:"${id}", resolution:"supersede"|"merge"|"reject", supersedes_id:"${conflictId}"}) to resolve before this can be promoted.`,
      };
    }
  }

  const uri = durableUri();
  writeDurableTriples(store, uri, local);
  await persistDurable(store);
  await tagQdrantDurable(uri, local);

  return { content: `Promoted to durable memory: ${uri}\n  ${local.finding}` };
}

async function adjudicate(store: Store, id: string, params: Record<string, unknown>) {
  const resolution = params.resolution as string | undefined;
  const supersedesId = params.supersedes_id as string | undefined;
  const overrideText = params.text as string | undefined;

  if (!resolution) {
    return { content: "Error: 'resolution' is required for adjudicate.", is_error: true };
  }

  if (resolution === "reject") {
    return { content: `Rejected — local memory '${id}' will not be promoted.` };
  }

  if (!supersedesId) {
    return { content: "Error: 'supersedes_id' is required for supersede/merge.", is_error: true };
  }

  const localUri = toObsUri(id);
  const local = lookupObs(store, GRAPHS.memory, localUri);
  if (!local || !local.about) {
    return { content: `Error: local memory '${id}' not found.`, is_error: true };
  }

  const oldUri = toDurableUri(supersedesId);

  // Close out the superseded entry rather than deleting it — a validUntil
  // timestamp preserves history instead of erasing a prior "current" fact.
  store.update(`
    WITH <${GRAPHS.durable}>
    DELETE { <${oldUri}> porter:validUntil ?u }
    INSERT { <${oldUri}> porter:validUntil "${new Date().toISOString()}" }
    WHERE { OPTIONAL { <${oldUri}> porter:validUntil ?u } }
  `);

  const finding = resolution === "merge" && overrideText ? overrideText : local.finding ?? "";
  const uri = durableUri();
  writeDurableTriples(store, uri, { ...local, finding }, oldUri);
  await persistDurable(store);
  await tagQdrantDurable(uri, { ...local, finding });

  return {
    content: `Resolved (${resolution}): ${uri} supersedes ${oldUri}\n  ${finding}`,
  };
}

async function editDurable(store: Store, id: string, text: string | undefined) {
  if (!text) {
    return { content: "Error: 'text' parameter is required for edit.", is_error: true };
  }
  const uri = toDurableUri(id);
  const existing = lookupObs(store, GRAPHS.durable, uri);
  if (!existing) {
    return { content: `Error: durable entry '${id}' not found.`, is_error: true };
  }

  store.update(`
    WITH <${GRAPHS.durable}>
    DELETE { <${uri}> porter:finding ?f }
    INSERT { <${uri}> porter:finding "${text.replace(/"/g, '\\"')}" }
    WHERE { <${uri}> porter:finding ?f }
  `);
  await persistDurable(store);

  return { content: `Updated durable entry ${uri}\n  ${text}` };
}

async function deleteDurable(store: Store, id: string) {
  const uri = toDurableUri(id);
  const existing = lookupObs(store, GRAPHS.durable, uri);
  if (!existing) {
    return { content: `Error: durable entry '${id}' not found.`, is_error: true };
  }

  store.update(`WITH <${GRAPHS.durable}> DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
  await persistDurable(store);

  return { content: `Deleted durable entry ${uri}` };
}

function writeDurableTriples(store: Store, uri: string, obs: ObsRow, supersedesUri?: string): void {
  const g = GRAPHS.durable;
  store.addTriple(uri, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", PORTER.Observation, g);
  store.addLiteral(uri, PORTER.about, obs.about ?? "", g);
  store.addLiteral(uri, PORTER.finding, obs.finding ?? "", g);
  if (obs.memoryType) store.addLiteral(uri, PORTER.memoryType, obs.memoryType, g);
  if (obs.discoveredBy) {
    // discoveredBy here is already the full agent URI (bound straight off the
    // porter:discoveredBy triple's object in lookupObs's SPARQL SELECT) —
    // wrapping it again in agentUri()-style encoding would double-encode it.
    store.addTriple(uri, PORTER.discoveredBy, obs.discoveredBy, g);
  }
  store.addLiteral(uri, PORTER.validFrom, new Date().toISOString(), g);
  if (supersedesUri) store.addTriple(uri, PORTER.supersedes, supersedesUri, g);
}

async function tagQdrantDurable(uri: string, obs: ObsRow): Promise<void> {
  const id = uri.split("/").pop() ?? crypto.randomUUID();
  // obs.discoveredBy is a full agent URI here (see writeDurableTriples) —
  // extract the bare name so the payload shape matches memory.ts's local
  // saves, which store a plain agent name.
  const discoveredByName = obs.discoveredBy
    ? decodeURIComponent(obs.discoveredBy.split("/").pop() ?? obs.discoveredBy)
    : undefined;
  await embedAndUpsert(COLLECTIONS.observations, id, `${obs.about}: ${obs.finding}`, {
    about: obs.about,
    finding: obs.finding,
    discoveredBy: discoveredByName,
    memoryType: obs.memoryType,
    scope: "durable",
  });
}

export default entry;
