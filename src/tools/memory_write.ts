import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { observationToTriples } from "../graph/converters.ts";

const entry: ToolEntry = {
  definition: {
    name: "memory_write",
    description:
      "Write an observation to the shared knowledge graph. Other agents can query these observations to build cumulative understanding of the project.",
    input_schema: {
      type: "object" as const,
      properties: {
        about: {
          type: "string",
          description:
            "What this observation is about — a file path, component name, concept, or URI.",
        },
        finding: {
          type: "string",
          description:
            "The observation or finding to record.",
        },
        severity: {
          type: "string",
          enum: ["info", "low", "medium", "high", "critical"],
          description:
            "Severity level of the finding. Default: info.",
        },
        agent_name: {
          type: "string",
          description:
            "Your agent name (for attribution).",
        },
      },
      required: ["about", "finding"],
    },
  },

  async execute(params) {
    const about = params.about as string;
    const finding = params.finding as string;
    const severity = (params.severity as string) ?? "info";
    const agentName = (params.agent_name as string) ?? "unknown";

    const store = getGraphStore();
    if (!store) {
      return {
        content: "Graph store not initialized. Memory tools are not available in this session.",
        is_error: true,
      };
    }

    try {
      const obsUri = observationToTriples(
        { about, finding, discoveredBy: agentName, severity },
        store,
      );
      return {
        content: `Observation recorded: ${obsUri}\n  about: ${about}\n  finding: ${finding}\n  severity: ${severity}`,
      };
    } catch (err) {
      return {
        content: `Error writing to memory: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
