import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { GRAPHS, PORTER, PROV, RDF } from "../graph/vocabulary.ts";

const entry: ToolEntry = {
  definition: {
    name: "critique_write",
    description:
      "Write a critique to the shared knowledge graph. Used by deliberation reflectors to raise issues and suggest improvements for the current round.",
    input_schema: {
      type: "object" as const,
      properties: {
        issue: {
          type: "string",
          description: "The issue or problem identified in the current work.",
        },
        suggestion: {
          type: "string",
          description: "Suggested improvement or fix for the issue.",
        },
        round: {
          type: "number",
          description:
            "Deliberation round number. Auto-detected from context if omitted.",
        },
      },
      required: ["issue", "suggestion"],
    },
  },

  async execute(params) {
    const issue = params.issue as string;
    const suggestion = params.suggestion as string;
    const round = (params.round as number) ?? 1;

    const store = getGraphStore();
    if (!store) {
      return {
        content:
          "Graph store not initialized. Collaboration tools are not available in this session.",
        is_error: true,
      };
    }

    try {
      const id = crypto.randomUUID();
      const uri = `${PORTER.ns}critique/${id}`;
      const g = GRAPHS.memory;
      const agentName = Deno.env.get("PORTER_AGENT_NAME") ?? "unknown";

      store.addTriple(uri, RDF.type, PORTER.Critique, g);
      store.addLiteral(uri, PORTER.finding, issue, g);
      store.addLiteral(uri, PORTER.about, suggestion, g);
      store.addLiteral(uri, PORTER.round, round, g);
      store.addLiteral(uri, PORTER.discoveredBy, agentName, g);
      store.addLiteral(uri, PORTER.approved, false, g);
      store.addLiteral(
        uri,
        PROV.generatedAtTime,
        new Date().toISOString(),
        g,
      );

      return {
        content:
          `Critique recorded: ${uri}\n  issue: ${issue}\n  suggestion: ${suggestion}\n  round: ${round}`,
      };
    } catch (err) {
      return {
        content: `Error writing critique: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
