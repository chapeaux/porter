import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { observationToTriples } from "../graph/converters.ts";
import { GRAPHS } from "../graph/vocabulary.ts";
import {
  COLLECTIONS,
  embedAndSearch,
  embedAndUpsert,
  getVectorStore,
} from "../vector/mod.ts";
import type { PayloadFilter, ScoredPoint } from "../vector/mod.ts";

// ---------------------------------------------------------------------------
// Session scoping — set once per isolate at agent start (see isolate.ts).
// Used to keep "local" searches scoped to the current session instead of
// leaking across every session ever run against a shared Qdrant instance.
// ---------------------------------------------------------------------------

let _sessionId: string | null = null;

export function setMemorySessionId(id: string | null): void {
  _sessionId = id;
}

/** Derive a short "about" label from free text (first clause, capped). */
function deriveAbout(text: string): string {
  const firstLine = text.split("\n")[0] ?? text;
  const firstClause = firstLine.split(/[.:;]/)[0]?.trim();
  return (firstClause || text).slice(0, 80);
}

/**
 * Split a procedural-memory statement into trigger/action for storage.
 * Models write one natural-language lesson (e.g. "When X, do Y") rather
 * than two structured fields; this recovers the split where an obvious
 * "when/if ..., ..." shape exists, and otherwise just duplicates the full
 * text into both fields rather than losing information.
 */
function splitLesson(text: string): { trigger: string; action: string } {
  const m = text.match(/^(?:when|if)\s+(.+?),\s*(?:then\s+)?(.+)$/i);
  if (m) return { trigger: m[1].trim(), action: m[2].trim() };
  return { trigger: text, action: text };
}

const SEARCH_COLLECTIONS = [
  COLLECTIONS.findings,
  COLLECTIONS.critiques,
  COLLECTIONS.observations,
];

const entry: ToolEntry = {
  definition: {
    name: "memory",
    description:
      'Save or search team memory. method "save" records something worth remembering; method "search" recalls relevant memories by meaning.',
    input_schema: {
      type: "object" as const,
      properties: {
        method: {
          type: "string",
          enum: ["save", "search"],
          description: '"save" to record a memory, "search" to recall relevant ones.',
        },
        type: {
          type: "string",
          enum: ["semantic", "episodic", "procedural"],
          description:
            "Kind of memory. semantic = a stable fact. episodic = something that happened. procedural = a reusable lesson/rule for a recurring situation. Required for save; optional filter for search.",
        },
        text: {
          type: "string",
          description: "For save: the memory to record. For search: what you're looking for.",
        },
        scope: {
          type: "string",
          enum: ["local", "durable", "both"],
          description:
            "local = this session only (default for save). durable = shared across sessions. both = search across local and durable (default for search).",
        },
        limit: {
          type: "number",
          description: "Max results for search. Default 5.",
        },
        agent_name: {
          type: "string",
          description: "Your agent name, for attribution.",
        },
      },
      // "type" is only strictly needed for save, but it's listed as required
      // so simplifySchemas() (src/tools/inference_engine.ts) — which strips
      // any property not in `required` for small models — doesn't hide it;
      // searchMemory() below treats it as an optional filter regardless.
      required: ["method", "type", "text"],
    },
  },

  async execute(params) {
    const method = params.method as string;
    const text = params.text as string | undefined;

    if (!text) {
      return { content: "Error: 'text' parameter is required.", is_error: true };
    }

    if (method === "save") {
      return await saveMemory(params, text);
    }
    if (method === "search") {
      return await searchMemory(params, text);
    }
    return {
      content: `Error: 'method' must be "save" or "search" (got: ${method}).`,
      is_error: true,
    };
  },
};

async function saveMemory(
  params: Record<string, unknown>,
  text: string,
): Promise<{ content: string; is_error?: boolean }> {
  const type = params.type as string | undefined;
  const agentName = (params.agent_name as string) ?? "unknown";

  if (!type) {
    return { content: "Error: 'type' parameter is required for save.", is_error: true };
  }

  const store = getGraphStore();
  if (!store) {
    return {
      content: "Graph store not initialized. Memory tools are not available in this session.",
      is_error: true,
    };
  }

  try {
    const about = deriveAbout(text);

    // Soft-write-with-warning: a conflicting live semantic fact isn't
    // rejected (that would cost small models an extra round-trip for a
    // fairly common case) — it's flagged back so the model or a later
    // librarian review (see memory_admin) can decide whether to reconcile.
    let conflictWarning = "";
    if (type === "semantic") {
      try {
        // Named-graph data is invisible to a query without an explicit GRAPH
        // clause (confirmed by direct testing — this store does not use a
        // union default graph), so this must be scoped to GRAPHS.memory.
        const existing = store.query(`
          SELECT ?obs ?finding WHERE {
            GRAPH <${GRAPHS.memory}> {
              ?obs a porter:Observation ;
                   porter:about "${about.replace(/"/g, '\\"')}" ;
                   porter:memoryType "semantic" ;
                   porter:finding ?finding .
              FILTER NOT EXISTS { ?obs porter:validUntil ?u }
            }
          }
        `);
        if (existing.length > 0) {
          conflictWarning = `\n\n[warning: ${existing.length} existing semantic entr${existing.length === 1 ? "y" : "ies"} about "${about}" already recorded — this may be a duplicate or conflict: ${existing.map((r) => r.finding).join("; ")}]`;
        }
      } catch { /* best-effort conflict check; never block the write on it */ }
    }

    const lesson = type === "procedural" ? splitLesson(text) : undefined;

    const obsUri = observationToTriples(
      {
        about,
        finding: text,
        discoveredBy: agentName,
        severity: "info",
        memoryType: type,
        lessonTrigger: lesson?.trigger,
        lessonAction: lesson?.action,
      },
      store,
    );

    const obsId = obsUri.split("/").pop() ?? crypto.randomUUID();
    await embedAndUpsert(COLLECTIONS.observations, obsId, `${about}: ${text}`, {
      about,
      finding: text,
      discoveredBy: agentName,
      memoryType: type,
      sessionId: _sessionId ?? undefined,
    });

    return {
      content: `Memory saved (${type}): ${obsUri}\n  ${text}${conflictWarning}`,
    };
  } catch (err) {
    return {
      content: `Error saving memory: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

async function searchMemory(
  params: Record<string, unknown>,
  text: string,
): Promise<{ content: string; is_error?: boolean }> {
  const type = params.type as string | undefined;
  const scope = (params.scope as string) ?? "both";
  const limit = (params.limit as number) ?? 5;

  if (!getVectorStore()) {
    return {
      content: "Vector store not available. Set QDRANT_URL to enable memory search.",
      is_error: true,
    };
  }

  // Durable-store separation lands in a later phase; for now "durable"/"both"
  // search without a session restriction, and "local" restricts to the
  // current session so recall doesn't leak across unrelated sessions.
  const filter: PayloadFilter | undefined = scope === "local" && _sessionId
    ? { sessionId: _sessionId, ...(type ? { memoryType: type } : {}) }
    : type
    ? { memoryType: type }
    : undefined;

  try {
    const searches = await Promise.all(
      SEARCH_COLLECTIONS.map((c) => embedAndSearch(c, text, filter, limit)),
    );
    const results: ScoredPoint[] = searches.flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (results.length === 0) {
      return { content: "No results found." };
    }

    const lines = results.map((r) => {
      const p = r.payload;
      const source = p.issue ? "critique" : p.domain ? "finding" : "observation";
      const snippet = p.issue ? `${p.issue}: ${p.suggestion}` : `${p.about}: ${p.finding}`;
      return `- [${source}] (score: ${r.score.toFixed(3)}, by: ${p.discoveredBy}) ${snippet}`;
    });

    return {
      content: `${results.length} result(s) for "${text}":\n\n${lines.join("\n")}`,
    };
  } catch (err) {
    return {
      content: `Memory search error: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

export default entry;
