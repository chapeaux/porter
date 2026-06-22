/**
 * Tool-calling inference engine for small models.
 *
 * Helps models that struggle with structured tool invocation by:
 * - Detecting tool-calling intent from natural language output
 * - Extracting parameters from prose descriptions
 * - Simplifying tool schemas to reduce confusion
 * - Building recovery nudges when parsing fails
 * - Reordering tools contextually for system prompt injection
 */

import type { ToolDefinition } from "../providers/types.ts";

// ---------------------------------------------------------------------------
// 1. ToolIntent interface
// ---------------------------------------------------------------------------

/** Result of classifying whether model output intends a tool call. */
export interface ToolIntent {
  wantsToolCall: boolean;
  likelyTool: string | null;
  confidence: number;
  suggestedParams: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Internal: intent signal map and follow-up heuristics
// ---------------------------------------------------------------------------

/** Maps natural-language phrases to tool names. */
const INTENT_SIGNALS: [RegExp, string, number][] = [
  // read_file — high specificity phrases first
  [/\bread(?:ing)?\s+(?:the\s+)?file\b/i, "read_file", 0.85],
  [/\bcheck(?:ing)?\s+(?:the\s+)?file\b/i, "read_file", 0.8],
  [/\blook\s+at\b/i, "read_file", 0.7],
  [/\blet\s+me\s+see\b/i, "read_file", 0.65],
  [/\bopen\b/i, "read_file", 0.6],

  // bash
  [/\bexecut(?:e|ing)\b/i, "bash", 0.8],
  [/\brun(?:ning)?\b/i, "bash", 0.7],
  [/\blet\s+me\s+try\b/i, "bash", 0.65],
  [/\bcommand\b/i, "bash", 0.6],

  // write_file
  [/\bcreate\s+(?:the\s+)?file\b/i, "write_file", 0.85],
  [/\bwrite\b/i, "write_file", 0.65],
  [/\bsave\b/i, "write_file", 0.6],

  // edit_file
  [/\bedit(?:ing)?\b/i, "edit_file", 0.75],
  [/\bchange\b/i, "edit_file", 0.65],
  [/\bmodif(?:y|ying)\b/i, "edit_file", 0.7],
  [/\breplace\b/i, "edit_file", 0.7],
  [/\bupdate\s+(?:the\s+)?file\b/i, "edit_file", 0.75],

  // grep
  [/\bsearch(?:ing)?\b/i, "grep", 0.7],
  [/\bfind\b/i, "grep", 0.6],
  [/\blook(?:ing)?\s+for\b/i, "grep", 0.7],
  [/\bgrep\b/i, "grep", 0.9],

  // list_dir / glob
  [/\blist\b/i, "list_dir", 0.6],
  [/\bwhat\s+files\b/i, "list_dir", 0.75],
  [/\bdirectory\b/i, "list_dir", 0.6],

  // git
  [/\bcommit\b/i, "git", 0.8],
  [/\bpush\b/i, "git", 0.7],
  [/\bpull\b/i, "git", 0.7],
  [/\bdiff\b/i, "git", 0.75],
  [/\bbranch\b/i, "git", 0.7],

  // finding_write
  [/\brecord\s+(?:a\s+)?finding\b/i, "finding_write", 0.85],
  [/\bmy\s+analysis\b/i, "finding_write", 0.7],

  // findings_query
  [/\bcheck\s+findings\b/i, "findings_query", 0.85],
  [/\bwhat\s+did\b/i, "findings_query", 0.6],

  // critique_write
  [/\bissue\s+with\b/i, "critique_write", 0.7],
  [/\bproblem\s*:/i, "critique_write", 0.75],
  [/\bneeds\s+fixing\b/i, "critique_write", 0.7],

  // approve
  [/\bapprove\b/i, "approve", 0.85],
  [/\blooks\s+good\b/i, "approve", 0.8],
  [/\bacceptable\b/i, "approve", 0.7],

  // plan_write / plan_query
  [/\bstep\s+\d+\b/i, "plan_write", 0.7],
  [/\bthe\s+plan\b/i, "plan_query", 0.65],
];

/** Common follow-up tool sequences. */
const FOLLOW_UP_MAP: Record<string, string[]> = {
  read_file: ["edit_file", "write_file"],
  grep: ["read_file"],
  bash: ["bash"],
  glob: ["read_file"],
  list_dir: ["read_file"],
  plan_write: ["plan_write"],
  finding_write: ["finding_write", "send_message"],
  critique_write: ["critique_write", "send_message"],
  findings_query: ["send_message"],
};

/** Confidence boost when a tool appears in the follow-up chain. */
const FOLLOW_UP_BOOST = 0.15;

// ---------------------------------------------------------------------------
// 2. classifyIntent
// ---------------------------------------------------------------------------

/**
 * Analyze model text output to determine if it intends a tool call.
 *
 * Uses keyword/pattern matching against known intent signals, then
 * boosts confidence based on recent tool-use context.
 */
export function classifyIntent(
  text: string,
  toolNames: string[],
  recentTools?: string[],
): ToolIntent {
  const toolSet = new Set(toolNames);

  // a) Keyword/pattern matching
  let bestTool: string | null = null;
  let bestConfidence = 0;

  for (const [pattern, toolName, baseConfidence] of INTENT_SIGNALS) {
    if (!toolSet.has(toolName)) continue;
    if (pattern.test(text) && baseConfidence > bestConfidence) {
      bestTool = toolName;
      bestConfidence = baseConfidence;
    }
  }

  // b) Context-aware boost from recent tools
  if (recentTools && recentTools.length > 0) {
    const lastTool = recentTools[recentTools.length - 1];
    const followUps = FOLLOW_UP_MAP[lastTool];
    if (followUps) {
      for (const candidate of followUps) {
        if (!toolSet.has(candidate)) continue;

        if (bestTool === candidate) {
          // Boost an already-matched tool
          bestConfidence = Math.min(bestConfidence + FOLLOW_UP_BOOST, 0.95);
        } else if (!bestTool) {
          // Suggest follow-up if no match yet, with modest confidence
          bestTool = candidate;
          bestConfidence = 0.4;
        }
      }
    }
  }

  // c) Return
  if (!bestTool || bestConfidence < 0.3) {
    return { wantsToolCall: false, likelyTool: null, confidence: 0, suggestedParams: null };
  }

  return {
    wantsToolCall: true,
    likelyTool: bestTool,
    confidence: bestConfidence,
    suggestedParams: null,
  };
}

// ---------------------------------------------------------------------------
// 3. extractParamsFromText
// ---------------------------------------------------------------------------

/** File path pattern: word chars, dots, slashes, hyphens with an extension. */
const FILE_PATH_RE = /(?:["'`]([^"'`\s]+\.\w+)["'`]|(?:^|\s)((?:\.{0,2}\/)?[\w./\-]+\.\w+))/;

/** Backtick-wrapped command. */
const BACKTICK_CMD_RE = /`([^`]+)`/;

/** Quoted string. */
const QUOTED_RE = /["']([^"']+)["']/;

/**
 * Try to extract parameters from natural language for common tools.
 *
 * Returns null when extraction is ambiguous or the tool is not
 * recognized for parameter extraction.
 */
export function extractParamsFromText(
  text: string,
  toolName: string,
  _schema: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (toolName) {
    case "read_file": {
      const m = FILE_PATH_RE.exec(text);
      if (m) return { path: m[1] ?? m[2] };
      return null;
    }

    case "bash": {
      // Prefer backtick-wrapped content
      const bt = BACKTICK_CMD_RE.exec(text);
      if (bt) return { command: bt[1] };
      // Fall back to text after "run"/"execute"
      const after = text.match(/(?:run|execute)\s+(.+)/i);
      if (after) return { command: after[1].trim() };
      return null;
    }

    case "edit_file": {
      // edit_file requires path + old_string + new_string, which is
      // hard to extract reliably from prose. Return null unless we
      // can find all three unambiguously.
      const pathMatch = FILE_PATH_RE.exec(text);
      if (!pathMatch) return null;
      // Look for quoted old→new pairs separated by arrows or "with"/"to"
      const pairMatch = text.match(
        /["'`]([^"'`]+)["'`]\s*(?:->|→|to|with)\s*["'`]([^"'`]+)["'`]/,
      );
      if (!pairMatch) return null;
      return {
        path: pathMatch[1] ?? pathMatch[2],
        old_string: pairMatch[1],
        new_string: pairMatch[2],
      };
    }

    case "grep": {
      // Look for a quoted search term
      const q = QUOTED_RE.exec(text);
      if (!q) return null;
      const result: Record<string, unknown> = { pattern: q[1] };
      // Check for a file path after the quoted term
      const rest = text.slice((q.index ?? 0) + q[0].length);
      const pathMatch = FILE_PATH_RE.exec(rest);
      if (pathMatch) result.path = pathMatch[1] ?? pathMatch[2];
      return result;
    }

    case "send_message": {
      // Look for "to #channel: message" or "#channel message"
      const chanMatch = text.match(/#([\w-]+)/);
      if (!chanMatch) return null;
      // Everything after the channel reference is the message
      const afterChan = text.slice(
        (chanMatch.index ?? 0) + chanMatch[0].length,
      ).replace(/^[\s:]+/, "").trim();
      if (!afterChan) return null;
      return { channel: chanMatch[1], message: afterChan };
    }

    case "finding_write": {
      // Look for "about X: finding Y" or "about X finding Y"
      const aboutMatch = text.match(
        /about\s+(\S+)\s*[:\-]\s*(.+)/i,
      );
      if (aboutMatch) {
        return { about: aboutMatch[1], finding: aboutMatch[2].trim() };
      }
      return null;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 4. simplifySchemas
// ---------------------------------------------------------------------------

/** Tools most commonly used by each role, in priority order. */
const ROLE_TOOL_PRIORITY: Record<string, string[]> = {
  worker: [
    "read_file", "edit_file", "write_file", "bash", "grep", "glob",
    "list_dir", "git",
  ],
  specialist: [
    "read_file", "grep", "glob", "list_dir", "send_message",
    "finding_write", "findings_query", "memory_query",
  ],
  reflector: [
    "read_file", "grep", "glob", "list_dir", "critique_write",
    "critiques_query", "finding_write", "findings_query",
  ],
  reviewer: [
    "read_file", "grep", "glob", "list_dir", "critique_write",
    "approve", "finding_write", "send_message",
  ],
  synthesizer: [
    "read_file", "findings_query", "critiques_query", "send_message",
    "plan_query", "memory_query", "grep", "list_dir",
  ],
  admin: [
    "send_message", "read_messages", "plan_write", "plan_query",
    "bash", "read_file", "memory_write", "memory_query",
  ],
};

/** Tools to exclude per role. */
const ROLE_EXCLUDES: Record<string, Set<string>> = {
  specialist: new Set(["write_file", "edit_file", "bash"]),
  reflector: new Set(["write_file", "edit_file"]),
};

const MAX_SMALL_MODEL_TOOLS = 8;

/**
 * Simplify tool schemas for small models.
 *
 * For small models: shortens descriptions, removes optional parameters,
 * filters by role, and caps total tool count. For large models, returns
 * the definitions unchanged.
 */
export function simplifySchemas(
  definitions: ToolDefinition[],
  isSmall: boolean,
  role?: string,
): ToolDefinition[] {
  if (!isSmall) return definitions;

  let filtered = definitions;

  // Filter out tools excluded for this role
  if (role && ROLE_EXCLUDES[role]) {
    const excludes = ROLE_EXCLUDES[role];
    filtered = filtered.filter((d) => !excludes.has(d.name));
  }

  // Sort by role priority (known tools first, then alphabetical)
  if (role && ROLE_TOOL_PRIORITY[role]) {
    const priority = ROLE_TOOL_PRIORITY[role];
    filtered.sort((a, b) => {
      const ai = priority.indexOf(a.name);
      const bi = priority.indexOf(b.name);
      const aPri = ai >= 0 ? ai : priority.length;
      const bPri = bi >= 0 ? bi : priority.length;
      return aPri - bPri || a.name.localeCompare(b.name);
    });
  }

  // Cap at maximum
  filtered = filtered.slice(0, MAX_SMALL_MODEL_TOOLS);

  // Simplify each definition
  return filtered.map((def) => {
    // Shorten description to one sentence
    const firstSentence = def.description.split(/\.\s/)[0];
    const shortDesc = firstSentence.endsWith(".")
      ? firstSentence
      : firstSentence + ".";

    // Keep only required properties
    const required = new Set(def.input_schema.required ?? []);
    const simplifiedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(def.input_schema.properties)) {
      if (required.has(key)) {
        simplifiedProps[key] = value;
      }
    }

    return {
      name: def.name,
      description: shortDesc,
      input_schema: {
        type: "object" as const,
        properties: simplifiedProps,
        required: def.input_schema.required,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 5. buildRecoveryNudge
// ---------------------------------------------------------------------------

/**
 * Build a structured error message that helps the model fix its tool call.
 *
 * If `likelyTool` is identified, shows the correct invocation format with
 * placeholder values derived from the schema. Otherwise lists available
 * tools with the generic JSON format.
 */
export function buildRecoveryNudge(
  _failedText: string,
  likelyTool: string | null,
  schema: Record<string, unknown> | null,
): string {
  if (likelyTool && schema) {
    const example = buildExampleInput(schema);
    return [
      `I couldn't parse your tool call. To use ${likelyTool}, respond with exactly:`,
      `{"tool": "${likelyTool}", "input": ${JSON.stringify(example)}}`,
    ].join("\n");
  }

  if (likelyTool) {
    return [
      `I couldn't parse your tool call. To use ${likelyTool}, respond with exactly:`,
      `{"tool": "${likelyTool}", "input": {}}`,
    ].join("\n");
  }

  return [
    "I couldn't parse your tool call. Available tools: (check your system prompt)",
    'To call a tool, respond with: {"tool": "tool_name", "input": {"param": "value"}}',
  ].join("\n");
}

/**
 * Generate a placeholder input object from a JSON schema's required
 * properties. Strings get "...", numbers get 0, booleans get true.
 */
function buildExampleInput(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = (schema.required ?? []) as string[];

  for (const key of required) {
    const prop = properties[key];
    if (!prop) {
      result[key] = "...";
      continue;
    }
    switch (prop.type) {
      case "number":
      case "integer":
        result[key] = 0;
        break;
      case "boolean":
        result[key] = true;
        break;
      case "array":
        result[key] = [];
        break;
      case "object":
        result[key] = {};
        break;
      default:
        result[key] = "...";
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 6. getContextualToolOrder
// ---------------------------------------------------------------------------

/**
 * Reorder tools based on what's likely needed next.
 *
 * Moves likely follow-up tools to the front of the list based on
 * the same heuristics used by classifyIntent.
 */
export function getContextualToolOrder(
  recentTools: string[],
  toolNames: string[],
): string[] {
  if (recentTools.length === 0) return toolNames;

  const lastTool = recentTools[recentTools.length - 1];
  const followUps = FOLLOW_UP_MAP[lastTool];
  if (!followUps) return toolNames;

  const toolSet = new Set(toolNames);
  const promoted: string[] = [];
  const rest: string[] = [];

  // Collect follow-up tools that exist in the current set
  for (const candidate of followUps) {
    if (toolSet.has(candidate)) {
      promoted.push(candidate);
    }
  }

  // Add remaining tools in original order
  const promotedSet = new Set(promoted);
  for (const name of toolNames) {
    if (!promotedSet.has(name)) {
      rest.push(name);
    }
  }

  return [...promoted, ...rest];
}
