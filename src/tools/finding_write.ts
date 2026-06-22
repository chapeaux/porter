import type { ToolEntry } from "./mod.ts";
import { getGraphStore } from "../graph/store.ts";
import { GRAPHS, PORTER, PROV, RDF } from "../graph/vocabulary.ts";

const entry: ToolEntry = {
  definition: {
    name: "finding_write",
    description:
      "Write a finding to the shared knowledge graph. Used by mixture-of-agents specialists to record domain-specific findings with confidence scores.",
    input_schema: {
      type: "object" as const,
      properties: {
        about: {
          type: "string",
          description:
            "What this finding is about -- a file path, component, concept, or URI.",
        },
        finding: {
          type: "string",
          description: "The finding or analysis result to record.",
        },
        confidence: {
          type: "number",
          description:
            "Confidence level from 0 to 1. Default: 0.5.",
        },
        domain: {
          type: "string",
          description:
            "Domain or specialization area (e.g. 'security', 'performance', 'architecture').",
        },
      },
      required: ["about", "finding"],
    },
  },

  async execute(params) {
    const about = params.about as string;
    const finding = params.finding as string;
    const confidence = (params.confidence as number) ?? 0.5;
    const domain = (params.domain as string) ?? "general";

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
      const uri = `${PORTER.ns}finding/${id}`;
      const g = GRAPHS.memory;
      const agentName = Deno.env.get("PORTER_AGENT_NAME") ?? "unknown";

      store.addTriple(uri, RDF.type, PORTER.Finding, g);
      store.addLiteral(uri, PORTER.about, about, g);
      store.addLiteral(uri, PORTER.finding, finding, g);
      store.addLiteral(uri, PORTER.confidence, confidence, g);
      store.addLiteral(uri, PORTER.domain, domain, g);
      store.addLiteral(uri, PORTER.discoveredBy, agentName, g);
      store.addLiteral(
        uri,
        PROV.generatedAtTime,
        new Date().toISOString(),
        g,
      );

      return {
        content:
          `Finding recorded: ${uri}\n  about: ${about}\n  domain: ${domain}\n  confidence: ${confidence}`,
      };
    } catch (err) {
      return {
        content: `Error writing finding: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
