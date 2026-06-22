import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { GRAPHS, PORTER, PROV, RDF } from "../graph/vocabulary.ts";

const entry: ToolEntry = {
  definition: {
    name: "plan_write",
    description:
      "Write a plan step to the shared knowledge graph. Used by distillation experts to break work into ordered steps for learners to execute.",
    input_schema: {
      type: "object" as const,
      properties: {
        step: {
          type: "string",
          description: "Description of what this step should accomplish.",
        },
        order: {
          type: "number",
          description: "Sequence number for this step (1-based).",
        },
        expected_outcome: {
          type: "string",
          description:
            "What the expected result looks like when this step is complete.",
        },
      },
      required: ["step", "order"],
    },
  },

  async execute(params) {
    const step = params.step as string;
    const order = params.order as number;
    const expectedOutcome = (params.expected_outcome as string) ?? "";

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
      const uri = `${PORTER.ns}step/${id}`;
      const g = GRAPHS.memory;
      const agentName = Deno.env.get("PORTER_AGENT_NAME") ?? "unknown";

      store.addTriple(uri, RDF.type, PORTER.PlanStep, g);
      store.addLiteral(uri, PORTER.finding, step, g);
      store.addLiteral(uri, PORTER.stepOrder, order, g);
      store.addLiteral(uri, PORTER.stepState, "pending", g);
      store.addLiteral(uri, PORTER.discoveredBy, agentName, g);
      store.addLiteral(
        uri,
        PROV.generatedAtTime,
        new Date().toISOString(),
        g,
      );

      if (expectedOutcome) {
        store.addLiteral(uri, PORTER.about, expectedOutcome, g);
      }

      return {
        content:
          `Plan step recorded: ${uri}\n  step ${order}: ${step}${expectedOutcome ? `\n  expected: ${expectedOutcome}` : ""}`,
      };
    } catch (err) {
      return {
        content: `Error writing plan step: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
