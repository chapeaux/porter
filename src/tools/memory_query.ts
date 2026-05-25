import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";

const entry: ToolEntry = {
  definition: {
    name: "memory_query",
    description:
      "Query the shared knowledge graph using SPARQL. Returns observations, task history, and other data recorded by all agents in this session. Use SELECT queries to find information.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            'A SPARQL SELECT query. Prefixes porter:, as:, prov:, rdf:, rdfs:, xsd: are pre-defined. Example: SELECT ?file ?finding WHERE { ?obs porter:about ?file ; porter:finding ?finding }',
        },
      },
      required: ["query"],
    },
  },

  async execute(params) {
    const query = params.query as string;

    const store = getGraphStore();
    if (!store) {
      return {
        content: "Graph store not initialized. Memory tools are not available in this session.",
        is_error: true,
      };
    }

    if (!query.trim().toUpperCase().startsWith("SELECT")) {
      return {
        content: "Only SELECT queries are allowed. Use memory_write to add data.",
        is_error: true,
      };
    }

    try {
      const results = await Promise.resolve(store.query(query));

      if (results.length === 0) {
        return { content: "No results found." };
      }

      const headers = Object.keys(results[0]);
      const rows = results.map(r => headers.map(h => r[h] ?? "").join(" | "));
      const table = [headers.join(" | "), headers.map(() => "---").join(" | "), ...rows].join("\n");

      return {
        content: `${results.length} result(s):\n\n${table}`,
      };
    } catch (err) {
      return {
        content: `SPARQL error: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
