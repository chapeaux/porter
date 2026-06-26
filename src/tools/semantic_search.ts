import type { ToolEntry } from "./mod.ts";
import { COLLECTIONS, embedAndSearch, getVectorStore } from "../vector/mod.ts";
import type { ScoredPoint } from "../vector/mod.ts";

const COLLECTION_MAP: Record<string, string> = {
  findings: COLLECTIONS.findings,
  critiques: COLLECTIONS.critiques,
  observations: COLLECTIONS.observations,
};

const entry: ToolEntry = {
  definition: {
    name: "semantic_search",
    description:
      "Search agent findings, critiques, and observations by semantic similarity. Returns results ranked by relevance to the query.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query.",
        },
        collection: {
          type: "string",
          enum: ["findings", "critiques", "observations", "all"],
          description:
            "Which collection to search. Default: all.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Default: 5.",
        },
      },
      required: ["query"],
    },
  },

  async execute(params) {
    const query = params.query as string;
    const collection = (params.collection as string) ?? "all";
    const limit = (params.limit as number) ?? 5;

    if (!getVectorStore()) {
      return {
        content: "Vector store not available. Set QDRANT_URL to enable semantic search.",
        is_error: true,
      };
    }

    try {
      let results: ScoredPoint[];

      if (collection === "all") {
        const searches = await Promise.all(
          Object.values(COLLECTION_MAP).map((c) =>
            embedAndSearch(c, query, undefined, limit)
          ),
        );
        results = searches.flat().sort((a, b) => b.score - a.score).slice(0, limit);
      } else {
        const col = COLLECTION_MAP[collection];
        if (!col) {
          return {
            content: `Unknown collection: ${collection}. Use: findings, critiques, observations, or all.`,
            is_error: true,
          };
        }
        results = await embedAndSearch(col, query, undefined, limit);
      }

      if (results.length === 0) {
        return { content: "No results found." };
      }

      const lines = results.map((r) => {
        const p = r.payload;
        const source = p.issue ? "critique" : p.domain ? "finding" : "observation";
        const text = p.issue
          ? `${p.issue}: ${p.suggestion}`
          : `${p.about}: ${p.finding ?? p.finding}`;
        return `- [${source}] (score: ${r.score.toFixed(3)}, by: ${p.discoveredBy}) ${text}`;
      });

      return {
        content: `${results.length} result(s) for "${query}":\n\n${lines.join("\n")}`,
      };
    } catch (err) {
      return {
        content: `Semantic search error: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
