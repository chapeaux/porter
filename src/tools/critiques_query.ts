import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";

const entry: ToolEntry = {
  definition: {
    name: "critiques_query",
    description:
      "Query unaddressed critiques from the current deliberation round. Used by deliberation workers to see what issues need to be resolved.",
    input_schema: {
      type: "object" as const,
      properties: {
        round: {
          type: "number",
          description:
            "Deliberation round to query. Defaults to the latest round if omitted.",
        },
      },
      required: [],
    },
  },

  async execute(params) {
    const roundParam = params.round as number | undefined;

    const store = getGraphStore();
    if (!store) {
      return {
        content:
          "Graph store not initialized. Collaboration tools are not available in this session.",
        is_error: true,
      };
    }

    try {
      // If no round specified, find the latest round first
      let round = roundParam;
      if (round === undefined) {
        const maxRoundResult = store.query(
          `SELECT (MAX(?r) AS ?maxRound) WHERE {
  ?c a porter:Critique ;
     porter:round ?r .
}`,
        );
        if (maxRoundResult.length > 0 && maxRoundResult[0].maxRound) {
          round = parseInt(maxRoundResult[0].maxRound, 10);
        } else {
          return { content: "No critiques found in any round." };
        }
      }

      const sparql = `SELECT ?issue ?suggestion ?discoveredBy ?time WHERE {
  ?c a porter:Critique ;
     porter:finding ?issue ;
     porter:about ?suggestion ;
     porter:round ?round ;
     porter:discoveredBy ?discoveredBy ;
     porter:approved ?approved ;
     prov:generatedAtTime ?time .
  FILTER(?round = ${round})
  FILTER(?approved = false)
} ORDER BY ?time`;

      const results = await Promise.resolve(store.query(sparql));

      if (results.length === 0) {
        return {
          content: `No unaddressed critiques in round ${round}.`,
        };
      }

      const lines = results.map(
        (r) =>
          `- Issue: ${r.issue}\n  Suggestion: ${r.suggestion}\n  From: ${r.discoveredBy}`,
      );

      return {
        content: `${results.length} unaddressed critique(s) in round ${round}:\n\n${lines.join("\n\n")}`,
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
