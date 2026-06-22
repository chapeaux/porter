import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";

const entry: ToolEntry = {
  definition: {
    name: "findings_query",
    description:
      "Query findings from the shared knowledge graph. Used by mixture-of-agents synthesizers to gather domain-specific findings from specialists.",
    input_schema: {
      type: "object" as const,
      properties: {
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
    const domain = params.domain as string | undefined;
    const minConfidence = params.min_confidence as number | undefined;

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
  ?f a porter:Finding ;
     porter:about ?about ;
     porter:finding ?finding ;
     porter:domain ?domain ;
     porter:confidence ?confidence ;
     porter:discoveredBy ?discoveredBy ;
     prov:generatedAtTime ?time .`;

      if (domain) {
        sparql += `\n  FILTER(?domain = "${domain}")`;
      }
      if (minConfidence !== undefined) {
        sparql += `\n  FILTER(xsd:float(?confidence) >= ${minConfidence})`;
      }

      sparql += "\n} ORDER BY DESC(?confidence)";

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
