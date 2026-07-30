import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { GRAPHS } from "../graph/vocabulary.ts";

const entry: ToolEntry = {
  definition: {
    name: "plan_query",
    description:
      "Get pending plan steps from the shared knowledge graph. Used by distillation learners to see what work remains to be done, in order.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  async execute(_params) {
    const store = getGraphStore();
    if (!store) {
      return {
        content:
          "Graph store not initialized. Collaboration tools are not available in this session.",
        is_error: true,
      };
    }

    try {
      const sparql = `SELECT ?step ?order ?outcome WHERE {
  GRAPH <${GRAPHS.memory}> {
    ?s a porter:PlanStep ;
       porter:finding ?step ;
       porter:stepOrder ?order ;
       porter:stepState "pending" .
    OPTIONAL { ?s porter:about ?outcome }
  }
} ORDER BY ?order`;

      const results = await Promise.resolve(store.query(sparql));

      if (results.length === 0) {
        return { content: "No pending plan steps." };
      }

      const lines = results.map((r) => {
        const outcome = r.outcome ? ` (expected: ${r.outcome})` : "";
        return `Step ${r.order}: ${r.step}${outcome}`;
      });

      return {
        content: `${results.length} pending step(s):\n\n${lines.join("\n")}`,
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
