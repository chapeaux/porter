import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { GRAPHS } from "../graph/vocabulary.ts";
import { getBus } from "../runtime/bus.ts";

const entry: ToolEntry = {
  definition: {
    name: "approve",
    description:
      "Mark the current deliberation round as approved. Sets all critiques from the current round as addressed and publishes an APPROVED signal to end the deliberation loop.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description:
            "Optional summary of why the work is approved.",
        },
      },
      required: [],
    },
  },

  async execute(params) {
    const summary = (params.summary as string) ?? "Approved without comment.";

    const store = getGraphStore();
    if (!store) {
      return {
        content:
          "Graph store not initialized. Collaboration tools are not available in this session.",
        is_error: true,
      };
    }

    try {
      // Find the latest round
      const maxRoundResult = store.query(
        `SELECT (MAX(?r) AS ?maxRound) WHERE {
  GRAPH <${GRAPHS.memory}> {
    ?c a porter:Critique ;
       porter:round ?r .
  }
}`,
      );

      let round = 1;
      if (maxRoundResult.length > 0 && maxRoundResult[0].maxRound) {
        round = parseInt(maxRoundResult[0].maxRound, 10);
      }

      // Mark all critiques from this round as approved
      store.update(
        `WITH <${GRAPHS.memory}>
DELETE { ?c porter:approved ?old }
INSERT { ?c porter:approved true }
WHERE {
  ?c a porter:Critique ;
     porter:round ${round} ;
     porter:approved ?old .
}`,
      );

      // Publish APPROVED signal on the deliberation channel + activity event
      try {
        const bus = getBus();
        const agentName = Deno.env.get("PORTER_AGENT_NAME") ?? "reflector";
        await bus.publish("deliberation", `APPROVED: ${summary}`);
        await bus.publish("activity", JSON.stringify({ event: "approved", round, agent: agentName }), agentName);
      } catch {
        // Bus may not be available in all contexts
      }

      return {
        content: `Deliberation round ${round} approved.\n  Summary: ${summary}`,
      };
    } catch (err) {
      return {
        content: `Error approving: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
