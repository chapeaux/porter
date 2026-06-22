/**
 * Pattern orchestration module.
 *
 * Wires up Mixture, Deliberation, and Distillation collaboration
 * patterns by configuring channel subscriptions, injecting
 * pattern-specific tools, and generating role-aware system prompt
 * suffixes.
 */

import type {
  AgentRole,
  CollaborationPattern,
  PorterConfig,
  ToolName,
} from "../core/config.ts";
import type { MessageBus } from "../runtime/bus.ts";

// ---------------------------------------------------------------------------
// 1. wirePattern — set up channel subscriptions per pattern
// ---------------------------------------------------------------------------

/**
 * Configure pattern-specific channel subscriptions on the bus.
 *
 * Called by the orchestrator after creating the bus but before spawning
 * agents. Overrides the `subscribe` field on each agent config so the
 * orchestrator's normal subscription loop picks up the right channels.
 */
export function wirePattern(
  config: PorterConfig,
  bus: MessageBus,
): void {
  const pattern = config.pattern ?? "sequential";

  switch (pattern) {
    case "mixture": {
      const specialists = config.agents.filter(
        (a) => a.role === "specialist",
      );
      const synthesizers = config.agents.filter(
        (a) => a.role === "synthesizer",
      );

      // Each specialist subscribes to task + control
      for (const agent of specialists) {
        agent.subscribe = ["task", "control"];
        bus.subscribe(agent.name, [
          ...agent.subscribe,
          `task:${agent.name}`,
        ]);
      }

      // Synthesizer subscribes to each specialist's output channel + control
      const specialistChannels = specialists.map(
        (s) => `specialist:${s.name}`,
      );
      for (const agent of synthesizers) {
        agent.subscribe = [...specialistChannels, "control"];
        bus.subscribe(agent.name, [
          ...agent.subscribe,
          `task:${agent.name}`,
        ]);
      }
      break;
    }

    case "deliberation": {
      for (const agent of config.agents) {
        if (agent.role === "worker") {
          agent.subscribe = ["task", "revision", "control"];
        } else if (agent.role === "reflector") {
          agent.subscribe = ["deliberation", "control"];
        }
        bus.subscribe(agent.name, [
          ...(agent.subscribe ?? []),
          `task:${agent.name}`,
        ]);
      }
      break;
    }

    case "distillation": {
      for (const agent of config.agents) {
        if (agent.role === "expert") {
          agent.subscribe = ["task", "clarify", "control"];
        } else if (agent.role === "learner") {
          agent.subscribe = ["guidance", "control"];
        }
        bus.subscribe(agent.name, [
          ...(agent.subscribe ?? []),
          `task:${agent.name}`,
        ]);
      }
      break;
    }

    case "sequential":
    default:
      // Default behaviour — no changes to existing subscriptions.
      break;
  }
}

// ---------------------------------------------------------------------------
// 2. getPatternTools — auto-injected tools per role/pattern
// ---------------------------------------------------------------------------

/**
 * Return the tool names that should be auto-injected for a given role
 * in a collaboration pattern.
 */
export function getPatternTools(
  role: AgentRole,
  pattern: CollaborationPattern,
): ToolName[] {
  switch (pattern) {
    case "mixture":
      if (role === "specialist") {
        return ["finding_write", "send_message"];
      }
      if (role === "synthesizer") {
        return ["findings_query", "send_message"];
      }
      return [];

    case "deliberation":
      if (role === "worker") {
        return ["critiques_query", "send_message"];
      }
      if (role === "reflector") {
        return ["critique_write", "approve", "send_message"];
      }
      return [];

    case "distillation":
      if (role === "expert") {
        return ["plan_write", "send_message"];
      }
      if (role === "learner") {
        return ["plan_query", "step_update", "send_message"];
      }
      return [];

    case "sequential":
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 3. getPatternSystemPrompt — role-aware system prompt suffix
// ---------------------------------------------------------------------------

/**
 * Generate a system prompt suffix for an agent based on its role and
 * the active collaboration pattern.
 */
export function getPatternSystemPrompt(
  role: AgentRole,
  pattern: CollaborationPattern,
  agents: Array<{ name: string; role: string }>,
  maxRounds?: number,
): string {
  switch (pattern) {
    case "mixture": {
      if (role === "specialist") {
        // Find this agent's name from the roster for the channel reference.
        // The caller should match by role, but we reference the placeholder
        // {your_name} here — replaced at call-site if needed.
        return (
          "You are a domain specialist in a Mixture team. " +
          "Analyze the problem from your area of expertise. " +
          "Use the finding_write tool to record each finding with a confidence score. " +
          "Other specialists are analyzing simultaneously — focus on your domain. " +
          "Publish your completion to channel 'specialist:{your_name}' via send_message when done."
        );
      }
      if (role === "synthesizer") {
        const specialistNames = agents
          .filter((a) => a.role === "specialist")
          .map((a) => a.name);
        return (
          "You are the synthesizer in a Mixture team. " +
          "Wait for specialists to complete, then use findings_query to retrieve all findings. " +
          "Synthesize them into a coherent response. " +
          "Reconcile contradictions, note areas of agreement, and credit specific specialists. " +
          `Specialists: ${specialistNames.join(", ")}.`
        );
      }
      return "";
    }

    case "deliberation": {
      const rounds = maxRounds ?? 3;
      if (role === "worker") {
        return (
          "You are the worker in a Deliberation team. " +
          "Complete the task using your tools. " +
          "When done, publish your work to the 'deliberation' channel. " +
          "If you receive critique on the 'revision' channel, use critiques_query " +
          "to see specific issues and address them. " +
          `You have ${rounds} rounds maximum.`
        );
      }
      if (role === "reflector") {
        return (
          "You are the reflector in a Deliberation team. " +
          "Review the worker's output for correctness, completeness, edge cases, and security issues. " +
          "If issues found, use critique_write for each one. " +
          "If the work is acceptable, use the approve tool. " +
          "Be specific and actionable in critiques."
        );
      }
      return "";
    }

    case "distillation": {
      if (role === "expert") {
        return (
          "You are the expert in a Distillation team. " +
          "Analyze the task, break it down into clear steps, and use plan_write for each step " +
          "(with order numbers). Identify potential pitfalls. " +
          "You have read-only tools for context gathering. " +
          "Do NOT execute — the learner will implement your plan."
        );
      }
      if (role === "learner") {
        return (
          "You are the learner in a Distillation team. " +
          "Use plan_query to get the expert's next step, then execute it with your tools. " +
          "After each step, use step_update to mark it done or failed. " +
          "If something is unclear, ask for clarification via send_message on the 'clarify' channel."
        );
      }
      return "";
    }

    case "sequential":
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// 4. isSmallModel — auto-detect small models from model name
// ---------------------------------------------------------------------------

/** Small model size patterns (case-insensitive). */
const SMALL_PATTERNS = /(?:^|[^0-9])(?:1\.?5?|[2-4]|7|8)b(?:$|[^0-9])/i;

/** Large model / frontier patterns (case-insensitive). */
const LARGE_PATTERNS =
  /(?:70b|72b|405b|claude|gpt-4|gpt-4o|opus|sonnet)/i;

/**
 * Determine whether a model should be treated as "small".
 *
 * Small models get simplified tool schemas and the tool inference
 * engine. If `explicit` is provided it takes precedence; otherwise
 * the model name is pattern-matched.
 */
export function isSmallModel(
  modelName: string,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;

  if (LARGE_PATTERNS.test(modelName)) return false;
  if (SMALL_PATTERNS.test(modelName)) return true;

  return false;
}
