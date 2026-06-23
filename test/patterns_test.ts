/**
 * Tests for the pattern registry, tool inference engine, sync helpers,
 * and config type guards.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";

import {
  getPattern,
  listPatterns,
  registerCustomPattern,
  removePattern,
  validateTeamComposition,
  getCompositionSummary,
  patternToJsonLd,
  jsonLdToPattern,
  resetPatternRegistry,
} from "../src/orchestration/pattern_registry.ts";
import type { PatternDefinition } from "../src/orchestration/pattern_registry.ts";

import {
  classifyIntent,
  extractParamsFromText,
  simplifySchemas,
  buildRecoveryNudge,
  getContextualToolOrder,
} from "../src/tools/inference_engine.ts";
import type { ToolDefinition } from "../src/providers/types.ts";

import { isAgentRef } from "../src/core/config.ts";
import type { AgentConfig, AgentRef } from "../src/core/config.ts";

// NOTE: agentToTurtle / parseTurtleAgent live in src/ui/sync/sync-helpers.js
// which transitively imports browser-only modules (HTMLElement).  Those pure
// functions are tested inline below by copy-pasting the serialisation logic
// rather than importing the module.  See sync-helpers round-trip tests at the
// bottom of this file.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal custom pattern for testing registration/removal. */
function makeCustomPattern(id = "custom-test"): PatternDefinition {
  return {
    id,
    name: "Custom Test",
    description: "A custom pattern for testing",
    bus_flow: "task -> worker -> response",
    builtin: false,
    roles: [
      {
        id: "worker",
        name: "Worker",
        description: "Does work",
        min: 1,
        max: 4,
        system_prompt_suffix: "",
        auto_tools: [],
        subscribe: ["task"],
        default_tools: ["read_file"],
      },
    ],
  };
}

/** Build a minimal ToolDefinition for inference engine tests. */
function makeTool(name: string, desc: string, props: Record<string, unknown> = {}, required: string[] = []): ToolDefinition {
  return {
    name,
    description: desc,
    input_schema: { type: "object", properties: props, required },
  };
}

// ---------------------------------------------------------------------------
// 1. Pattern Registry
// ---------------------------------------------------------------------------

Deno.test("pattern-registry: getPattern('mixture') returns valid PatternDefinition with roles", () => {
  resetPatternRegistry();
  const pattern = getPattern("mixture");
  assertExists(pattern);
  assertEquals(pattern!.id, "mixture");
  assertEquals(pattern!.name, "Mixture");
  assert(pattern!.roles.length >= 2, "mixture should have at least 2 roles");
  // Must have specialist and synthesizer roles
  const roleIds = pattern!.roles.map((r) => r.id);
  assert(roleIds.includes("specialist"), "mixture should have a specialist role");
  assert(roleIds.includes("synthesizer"), "mixture should have a synthesizer role");
});

Deno.test("pattern-registry: getPattern('nonexistent') returns null", () => {
  resetPatternRegistry();
  const pattern = getPattern("nonexistent");
  assertEquals(pattern, null);
});

Deno.test("pattern-registry: listPatterns() returns at least 4 built-in patterns", () => {
  resetPatternRegistry();
  const patterns = listPatterns();
  assert(patterns.length >= 4, `expected >= 4 patterns, got ${patterns.length}`);
  const ids = patterns.map((p) => p.id);
  assert(ids.includes("sequential"));
  assert(ids.includes("mixture"));
  assert(ids.includes("deliberation"));
  assert(ids.includes("distillation"));
});

Deno.test("pattern-registry: registerCustomPattern adds a pattern, getPattern finds it", () => {
  resetPatternRegistry();
  const custom = makeCustomPattern();
  registerCustomPattern(custom);
  const found = getPattern("custom-test");
  assertExists(found);
  assertEquals(found!.id, "custom-test");
  assertEquals(found!.name, "Custom Test");
  assertEquals(found!.builtin, false);
});

Deno.test("pattern-registry: removePattern removes custom but not built-in", () => {
  resetPatternRegistry();
  // Register and then remove a custom pattern
  registerCustomPattern(makeCustomPattern("removable"));
  const removed = removePattern("removable");
  assertEquals(removed, true);
  assertEquals(getPattern("removable"), null);

  // Attempting to remove a built-in pattern should return false
  const removedBuiltin = removePattern("mixture");
  assertEquals(removedBuiltin, false);
  assertExists(getPattern("mixture"), "built-in 'mixture' should still exist");
});

Deno.test("pattern-registry: validateTeamComposition — valid mixture team passes", () => {
  resetPatternRegistry();
  const pattern = getPattern("mixture")!;
  // Valid: 2 specialists + 1 synthesizer
  const agents = [
    { role: "specialist" },
    { role: "specialist" },
    { role: "synthesizer" },
  ];
  const result = validateTeamComposition(pattern, agents);
  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("pattern-registry: validateTeamComposition — mixture team with 0 specialists fails", () => {
  resetPatternRegistry();
  const pattern = getPattern("mixture")!;
  // Invalid: 0 specialists
  const agents = [
    { role: "synthesizer" },
  ];
  const result = validateTeamComposition(pattern, agents);
  assertEquals(result.valid, false);
  assert(result.errors.length > 0, "should have at least one error");
  const specialistError = result.errors.find((e) => e.roleId === "specialist");
  assertExists(specialistError, "should have an error for the specialist role");
});

Deno.test("pattern-registry: getCompositionSummary returns readable string", () => {
  resetPatternRegistry();
  const pattern = getPattern("mixture")!;
  const summary = getCompositionSummary(pattern);
  assert(typeof summary === "string");
  assert(summary.length > 0, "summary should not be empty");
  // Should mention specialist and synthesizer role names
  assertStringIncludes(summary, "Specialist");
  assertStringIncludes(summary, "Synthesizer");
});

Deno.test("pattern-registry: patternToJsonLd round-trips through jsonLdToPattern", () => {
  resetPatternRegistry();
  const original = getPattern("mixture")!;
  const jsonLd = patternToJsonLd(original);

  // JSON-LD doc should have @context and @type
  assertExists(jsonLd["@context"]);
  assertEquals(jsonLd["@type"], "Pattern");

  // Round-trip back to PatternDefinition
  const restored = jsonLdToPattern(jsonLd);
  assertEquals(restored.id, original.id);
  assertEquals(restored.name, original.name);
  assertEquals(restored.description, original.description);
  assertEquals(restored.bus_flow, original.bus_flow);
  assertEquals(restored.builtin, original.builtin);
  assertEquals(restored.roles.length, original.roles.length);

  // Verify role details survived the round-trip
  for (let i = 0; i < original.roles.length; i++) {
    assertEquals(restored.roles[i].id, original.roles[i].id);
    assertEquals(restored.roles[i].name, original.roles[i].name);
    assertEquals(restored.roles[i].min, original.roles[i].min);
    assertEquals(restored.roles[i].max, original.roles[i].max);
  }
});

// ---------------------------------------------------------------------------
// 2. Tool Inference Engine
// ---------------------------------------------------------------------------

Deno.test("inference-engine: classifyIntent detects read_file intent", () => {
  const tools = ["read_file", "bash", "edit_file", "grep"];
  const result = classifyIntent("let me read the file src/main.ts", tools);
  assertEquals(result.wantsToolCall, true);
  assertEquals(result.likelyTool, "read_file");
  assert(result.confidence > 0.5, `expected confidence > 0.5, got ${result.confidence}`);
});

Deno.test("inference-engine: classifyIntent detects bash intent for 'run the tests'", () => {
  const tools = ["read_file", "bash", "edit_file", "grep"];
  const result = classifyIntent("I need to run the tests", tools);
  assertEquals(result.wantsToolCall, true);
  assertEquals(result.likelyTool, "bash");
});

Deno.test("inference-engine: classifyIntent returns wantsToolCall false for plain text", () => {
  const tools = ["read_file", "bash", "edit_file", "grep"];
  const result = classifyIntent("hello world", tools);
  assertEquals(result.wantsToolCall, false);
});

Deno.test("inference-engine: extractParamsFromText extracts path for read_file", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };
  const params = extractParamsFromText("read src/main.ts", "read_file", schema);
  assertExists(params);
  assertEquals(params!.path, "src/main.ts");
});

Deno.test("inference-engine: simplifySchemas filters out write tools for specialist", () => {
  const defs: ToolDefinition[] = [
    makeTool("read_file", "Read a file", { path: { type: "string" } }, ["path"]),
    makeTool("write_file", "Write a file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    makeTool("edit_file", "Edit a file", { path: { type: "string" } }, ["path"]),
    makeTool("bash", "Run a command", { command: { type: "string" } }, ["command"]),
    makeTool("grep", "Search files", { pattern: { type: "string" } }, ["pattern"]),
  ];

  const simplified = simplifySchemas(defs, true, "specialist");
  const names = simplified.map((d) => d.name);
  // Specialist should not have write_file, edit_file, or bash
  assertEquals(names.includes("write_file"), false, "specialist should not have write_file");
  assertEquals(names.includes("edit_file"), false, "specialist should not have edit_file");
  assertEquals(names.includes("bash"), false, "specialist should not have bash");
  // Should keep read_file and grep
  assert(names.includes("read_file"), "specialist should have read_file");
  assert(names.includes("grep"), "specialist should have grep");
});

Deno.test("inference-engine: simplifySchemas returns unchanged for non-small model", () => {
  const defs: ToolDefinition[] = [
    makeTool("read_file", "Read a file", { path: { type: "string" } }, ["path"]),
    makeTool("bash", "Run a command", { command: { type: "string" } }, ["command"]),
  ];

  const result = simplifySchemas(defs, false);
  // Should be the exact same array reference
  assertEquals(result, defs);
});

Deno.test("inference-engine: buildRecoveryNudge includes tool name and JSON example", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };
  const nudge = buildRecoveryNudge("I want to read a file", "read_file", schema);
  assertStringIncludes(nudge, "read_file");
  assertStringIncludes(nudge, '"tool"');
  assertStringIncludes(nudge, '"input"');
  // Should include an example with path placeholder
  assertStringIncludes(nudge, '"path"');
});

Deno.test("inference-engine: getContextualToolOrder puts follow-ups near front", () => {
  const tools = ["bash", "edit_file", "grep", "read_file", "write_file"];
  // After using grep, read_file should be promoted to front
  const reordered = getContextualToolOrder(["grep"], tools);
  assertEquals(reordered[0], "read_file");
  // All original tools should still be present
  assertEquals(reordered.length, tools.length);
  for (const t of tools) {
    assert(reordered.includes(t), `reordered should contain ${t}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Config Types
// ---------------------------------------------------------------------------

Deno.test("config: isAgentRef returns true for a ref-based entry", () => {
  const ref: AgentRef = { ref: "my-agent", name: "My Agent", role: "worker" };
  assertEquals(isAgentRef(ref), true);
});

Deno.test("config: isAgentRef returns false for a full AgentConfig", () => {
  const config = {
    name: "My Agent",
    role: "worker" as const,
    system_prompt: "You are a worker.",
    tools: [],
  };
  assertEquals(isAgentRef(config as AgentConfig), false);
});

// ---------------------------------------------------------------------------
// 4. Sync Helpers — agentToTurtle / parseTurtleAgent
//
// Cannot import sync-helpers.js directly because it transitively pulls in
// browser-only modules (HTMLElement).  The serialisation functions are pure
// string logic, so we inline minimal copies here to test the Turtle format.
// ---------------------------------------------------------------------------

/** Minimal re-implementation of escapeTtl for testing. */
function escapeTtl(s: string): string {
  return (s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Minimal agentToTurtle matching sync-helpers.js logic. */
function agentToTurtle(agent: Record<string, unknown>, uri: string): string {
  const name = (agent.name || "") as string;
  const expertise = (agent.systemPrompt || agent.system_prompt || "") as string;
  const tools = (agent.tools || []) as string[];
  const mcpTools = (agent.mcpTools || agent.mcp_tools || []) as string[];
  const model = (agent.model || "") as string;
  const maxTokens = (agent.maxTokens || agent.max_tokens || 0) as number;
  const reasoning = (agent.reasoning || false) as boolean;
  const role = (agent.role || "worker") as string;

  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    "",
    `<${uri}> a porter:Agent ;`,
    `  porter:name "${escapeTtl(name)}" ;`,
    `  porter:assignedRole "${escapeTtl(role)}" ;`,
  ];

  if (expertise) lines.push(`  porter:agentExpertise """${escapeTtl(expertise)}""" ;`);
  for (const t of tools) lines.push(`  porter:hasTool "${escapeTtl(t)}" ;`);
  for (const t of mcpTools) lines.push(`  porter:hasMcpTool "${escapeTtl(t)}" ;`);
  if (model) lines.push(`  porter:usesModel "${escapeTtl(model)}" ;`);
  if (maxTokens) lines.push(`  porter:maxTokens "${maxTokens}"^^xsd:integer ;`);
  if (reasoning) lines.push(`  porter:reasoning "true"^^xsd:boolean ;`);

  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, " .");

  return lines.join("\n") + "\n";
}

/** Minimal parseTurtleAgent matching sync-helpers.js logic. */
function parseTurtleAgent(turtle: string): Record<string, unknown> | null {
  if (!turtle) return null;
  const NS = "https://porter.chapeaux.io/vocab#";
  const norm = turtle.replace(
    new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^>]+)>`, "g"),
    "porter:$1",
  );
  if (!norm.includes("porter:Agent")) return null;

  const extractLiteral = (predicate: string): string => {
    const longMatch = norm.match(new RegExp(`${predicate}\\s+"""((?:[^"]|"(?!""))*?)"""`, "s"));
    if (longMatch) return longMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const shortMatch = norm.match(new RegExp(`${predicate}\\s+"([^"]*?)"`));
    if (shortMatch) return shortMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return "";
  };

  const extractAll = (predicate: string): string[] => {
    const results: string[] = [];
    const re = new RegExp(`${predicate}\\s+"([^"]*?)"`, "g");
    let m;
    while ((m = re.exec(norm)) !== null) {
      results.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    }
    return results;
  };

  const name = extractLiteral("porter:name");
  if (!name) return null;

  return {
    name,
    role: extractLiteral("porter:assignedRole") || "worker",
    systemPrompt: extractLiteral("porter:agentExpertise"),
    tools: extractAll("porter:hasTool"),
    mcpTools: extractAll("porter:hasMcpTool"),
    model: extractLiteral("porter:usesModel"),
    maxTokens: parseInt(extractLiteral("porter:maxTokens"), 10) || 8192,
    reasoning: extractLiteral("porter:reasoning") === "true",
  };
}

Deno.test("sync-helpers: agentToTurtle produces valid Turtle with porter vocabulary", () => {
  const agent = {
    name: "test-agent",
    role: "worker",
    systemPrompt: "You are helpful.",
    tools: ["read_file", "bash"],
    model: "claude-sonnet-4-6",
  };
  const turtle = agentToTurtle(agent, "https://pod.example/porter/agents/test-agent.ttl");
  assertStringIncludes(turtle, "porter:Agent");
  assertStringIncludes(turtle, 'porter:name "test-agent"');
  assertStringIncludes(turtle, 'porter:assignedRole "worker"');
  assertStringIncludes(turtle, "porter:agentExpertise");
  assertStringIncludes(turtle, 'porter:hasTool "read_file"');
  assertStringIncludes(turtle, 'porter:hasTool "bash"');
  assertStringIncludes(turtle, 'porter:usesModel "claude-sonnet-4-6"');
});

Deno.test("sync-helpers: parseTurtleAgent round-trips from agentToTurtle", () => {
  const original = {
    name: "round-trip",
    role: "specialist",
    systemPrompt: "Domain expert in security.",
    tools: ["grep", "read_file"],
    mcpTools: ["scanner.scan"],
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
    reasoning: true,
  };
  const uri = "https://pod.example/porter/agents/round-trip.ttl";
  const turtle = agentToTurtle(original, uri);
  const parsed = parseTurtleAgent(turtle);

  assertExists(parsed);
  assertEquals(parsed!.name, "round-trip");
  assertEquals(parsed!.role, "specialist");
  assertEquals(parsed!.systemPrompt, "Domain expert in security.");
  assert((parsed!.tools as string[]).includes("grep"), "should have grep tool");
  assert((parsed!.tools as string[]).includes("read_file"), "should have read_file tool");
  assert((parsed!.mcpTools as string[]).includes("scanner.scan"), "should have mcp tool");
  assertEquals(parsed!.model, "claude-sonnet-4-6");
  assertEquals(parsed!.maxTokens, 4096);
  assertEquals(parsed!.reasoning, true);
});

Deno.test("sync-helpers: parseTurtleAgent returns null for non-agent Turtle", () => {
  const turtle = `
@prefix porter: <https://porter.chapeaux.io/vocab#> .
<https://example.com/thing> a porter:Team ;
  porter:name "not-an-agent" .
`;
  const result = parseTurtleAgent(turtle);
  assertEquals(result, null);
});
