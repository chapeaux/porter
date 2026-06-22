/**
 * Pattern orchestration module.
 *
 * Wires collaboration patterns by reading portable PatternDefinition
 * files from the pattern registry. All logic is definition-driven —
 * adding a new pattern means adding a JSON file, not changing code.
 */

import type {
  AgentRole,
  CollaborationPattern,
  PorterConfig,
  ToolName,
} from "../core/config.ts";
import type { MessageBus } from "../runtime/bus.ts";
import { getPattern, getRole } from "./pattern_registry.ts";

// ---------------------------------------------------------------------------
// 1. wirePattern — set up channel subscriptions per pattern
// ---------------------------------------------------------------------------

/**
 * Configure pattern-specific channel subscriptions on the bus.
 *
 * Reads subscribe[] and subscribe_dynamic from the pattern definition.
 * Called by the orchestrator after creating the bus but before spawning agents.
 */
export function wirePattern(
  config: PorterConfig,
  bus: MessageBus,
): void {
  const patternId = config.pattern ?? "sequential";
  const pattern = getPattern(patternId);
  if (!pattern) return;

  for (const agent of config.agents) {
    const roleDef = pattern.roles.find((r) => r.id === agent.role);
    if (!roleDef) continue;

    const channels = [...roleDef.subscribe];

    if (roleDef.subscribe_dynamic) {
      const template = roleDef.subscribe_dynamic;
      for (const other of config.agents) {
        if (other.name === agent.name) continue;
        const otherRole = pattern.roles.find((r) => r.id === other.role);
        if (!otherRole) continue;
        if (template.startsWith(`${otherRole.id}:`)) {
          channels.push(`${otherRole.id}:${other.name}`);
        }
      }
    }

    agent.subscribe = channels;
    bus.subscribe(agent.name, [...channels, `task:${agent.name}`]);
  }
}

// ---------------------------------------------------------------------------
// 2. getPatternTools — auto-injected tools per role/pattern
// ---------------------------------------------------------------------------

/**
 * Return tool names to auto-inject for a given role in a pattern.
 * Reads from the pattern definition's auto_tools field.
 */
export function getPatternTools(
  role: AgentRole,
  pattern: CollaborationPattern,
): ToolName[] {
  const roleDef = getRole(pattern, role);
  if (!roleDef) return [];
  return roleDef.auto_tools as ToolName[];
}

// ---------------------------------------------------------------------------
// 3. getPatternSystemPrompt — role-aware system prompt suffix
// ---------------------------------------------------------------------------

/**
 * Generate a system prompt suffix from the pattern definition.
 * Replaces template variables: {agent_name}, {max_rounds}, specialist names.
 */
export function getPatternSystemPrompt(
  role: AgentRole,
  pattern: CollaborationPattern,
  agents: Array<{ name: string; role: string }>,
  maxRounds?: number,
  agentName?: string,
): string {
  const patternDef = getPattern(pattern);
  if (!patternDef) return "";

  const roleDef = patternDef.roles.find((r) => r.id === role);
  if (!roleDef) return "";

  let suffix = roleDef.system_prompt_suffix;

  suffix = suffix.replace(/\{agent_name\}/g, agentName ?? "agent");
  suffix = suffix.replace(/\{your_name\}/g, agentName ?? "agent");
  suffix = suffix.replace(/\{max_rounds\}/g, String(maxRounds ?? patternDef.max_rounds ?? 3));

  const specialistNames = agents
    .filter((a) => a.role === "specialist")
    .map((a) => a.name);
  if (specialistNames.length > 0) {
    suffix += ` Specialists: ${specialistNames.join(", ")}.`;
  }

  return suffix;
}

/**
 * Get the default tools for a role from the pattern definition.
 */
export function getPatternDefaultTools(
  role: AgentRole,
  pattern: CollaborationPattern,
): string[] {
  const roleDef = getRole(pattern, role);
  if (!roleDef) return [];
  return roleDef.default_tools;
}

// ---------------------------------------------------------------------------
// 4. isSmallModel — auto-detect small models from model name
// ---------------------------------------------------------------------------

const SMALL_PATTERNS = /(?:^|[^0-9])(?:1\.?5?|[2-4]|7|8)b(?:$|[^0-9])/i;
const LARGE_PATTERNS = /(?:70b|72b|405b|claude|gpt-4|gpt-4o|opus|sonnet)/i;

export function isSmallModel(
  modelName: string,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  if (LARGE_PATTERNS.test(modelName)) return false;
  if (SMALL_PATTERNS.test(modelName)) return true;
  return false;
}
