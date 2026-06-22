import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";

const entry: ToolEntry = {
  definition: {
    name: "step_update",
    description:
      "Mark a plan step as done or failed. Used by distillation learners to report progress on assigned plan steps.",
    input_schema: {
      type: "object" as const,
      properties: {
        order: {
          type: "number",
          description: "The step number to update.",
        },
        state: {
          type: "string",
          enum: ["done", "failed"],
          description: 'New state for the step: "done" or "failed".',
        },
        notes: {
          type: "string",
          description:
            "Optional notes about the outcome (e.g. what was accomplished or why it failed).",
        },
      },
      required: ["order", "state"],
    },
  },

  async execute(params) {
    const order = params.order as number;
    const state = params.state as string;
    const notes = params.notes as string | undefined;

    if (state !== "done" && state !== "failed") {
      return {
        content: 'State must be "done" or "failed".',
        is_error: true,
      };
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
      // Update the stepState for the matching PlanStep
      store.update(
        `DELETE { ?s porter:stepState ?old }
INSERT { ?s porter:stepState "${state}" }
WHERE {
  ?s a porter:PlanStep ;
     porter:stepOrder ${order} ;
     porter:stepState ?old .
}`,
      );

      // If notes provided, add them as a finding on the step
      if (notes) {
        store.update(
          `INSERT {
  ?s porter:addresses "${notes.replace(/"/g, '\\"')}"
}
WHERE {
  ?s a porter:PlanStep ;
     porter:stepOrder ${order} .
}`,
        );
      }

      return {
        content: `Step ${order} marked as ${state}.${notes ? `\n  Notes: ${notes}` : ""}`,
      };
    } catch (err) {
      return {
        content: `Error updating step: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
