import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { GRAPHS } from "../graph/vocabulary.ts";
import { COLLECTIONS, embedAndSearch } from "../vector/mod.ts";

const entry: ToolEntry = {
  definition: {
    name: "findings_query",
    description:
      "Query findings from the shared knowledge graph. Used by mixture-of-agents synthesizers to gather domain-specific findings from specialists.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Semantic search query. When provided, returns findings ranked by relevance instead of confidence. Requires a vector store.",
        },
        domain: {
          type: "string",
          description:
            "Filter by domain (e.g. 'security', 'performance'). Omit to return all domains.",
        },
        min_confidence: {
          type: "number",
          description:
            "Minimum confidence threshold (0-1). Omit to return all confidence levels.",
        },
      },
      required: [],
    },
  },

  async execute(params) {
    const query = params.query as string | undefined;
    const domain = params.domain as string | undefined;
    const minConfidence = params.min_confidence as number | undefined;

    // Semantic search path — when query is provided and vector store is available
    if (query) {
      const filter = domain ? { domain } : undefined;
      const results = await embedAndSearch(COLLECTIONS.findings, query, filter, 10);
      if (results.length > 0) {
        const lines = results.map(
          (r) =>
            `- [${r.payload.domain}] (score: ${r.score.toFixed(3)}): ${r.payload.finding} about ${r.payload.about}`,
        );
        return {
          content: `${results.length} finding(s) by relevance:\n\n${lines.join("\n")}`,
        };
      }
      // Fall through to SPARQL if vector search returned nothing
    }

    const store = getGraphStore();
    if (!store) {
      return {
        content:
          "Graph store not initialized. Collaboration tools are not available in this session.",
        is_error: true,
      };
    }

    try {
      let sparql = `SELECT ?about ?finding ?domain ?confidence ?discoveredBy ?time WHERE {
  GRAPH <${GRAPHS.memory}> {
    ?f a porter:Finding ;
       porter:about ?about ;
       porter:finding ?finding ;
       porter:domain ?domain ;
       porter:confidence ?confidence ;
       porter:discoveredBy ?discoveredBy ;
       prov:generatedAtTime ?time .`;

      if (domain) {
        sparql += `\n    FILTER(?domain = "${domain}")`;
      }
      if (minConfidence !== undefined) {
        sparql += `\n    FILTER(xsd:float(?confidence) >= ${minConfidence})`;
      }

      sparql += "\n  }\n} ORDER BY DESC(?confidence)";

      const results = await Promise.resolve(store.query(sparql));

      if (results.length === 0) {
        return { content: "No findings found." };
      }

      const lines = results.map(
        (r) =>
          `- [${r.domain}] (${r.confidence}): ${r.finding} about ${r.about}`,
      );

      return {
        content: `${results.length} finding(s):\n\n${lines.join("\n")}`,
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
