# RecursiveMAS-inspired Collaboration Patterns for Porter

## Context

Porter's current team model uses admin→worker→reviewer roles with a flat message bus. This works for large models but underserves small models (3-8B) which need structured collaboration patterns to compensate for individual weaknesses. RecursiveMAS demonstrates that architecture matters: Mixture (parallel specialists + synthesizer), Deliberation (reflector ↔ tool-caller loops), and Distillation (expert guides learner) patterns yield significant quality improvements even at the text level.

This effort adds three things:
1. **Collaboration patterns** — Mixture, Deliberation, Distillation as first-class team configurations
2. **Graph-backed coordination** — agents share structured state through the RDF graph instead of parsing prose
3. **Tool-calling inference engine** — a smarter layer that helps small models select and invoke tools correctly

---

## 1. Collaboration Patterns

### Mixture Pattern

Multiple specialist agents work a problem **in parallel**, each from their domain perspective. A synthesizer agent aggregates via SPARQL queries on the shared graph.

**Config:**
```json
{
  "pattern": "mixture",
  "agents": [
    { "name": "code-expert", "role": "specialist", "model": "qwen-coder-3b" },
    { "name": "arch-expert", "role": "specialist", "model": "granite-3b" },
    { "name": "security-expert", "role": "specialist", "model": "granite-3b" },
    { "name": "synthesizer", "role": "synthesizer", "model": "granite-8b" }
  ]
}
```

**Bus flow:**
```
task → [specialists in parallel] → each writes findings to graph
                                 → synthesizer queries graph → response
```

### Deliberation Pattern

A reflector iteratively critiques a worker's output. The graph tracks critique history to prevent regression.

**Config:**
```json
{
  "pattern": "deliberation",
  "max_deliberation_rounds": 3,
  "agents": [
    { "name": "worker", "role": "worker", "tools": ["read_file", "write_file", "bash", ...] },
    { "name": "reflector", "role": "reflector" }
  ]
}
```

**Bus flow:**
```
task → worker → graph(work) → reflector queries graph
                                ↓
                        [approve] → response
                        [critique] → graph(critique) → worker reads critique → revise...
```

### Distillation Pattern

A larger model reasons and plans; a smaller model executes. The graph tracks plan steps and completion status.

**Config:**
```json
{
  "pattern": "distillation",
  "agents": [
    { "name": "expert", "role": "expert", "model": "granite-8b", "tools": ["read_file", "glob", "grep"] },
    { "name": "learner", "role": "learner", "model": "granite-3b", "tools": ["read_file", "write_file", "bash"] }
  ]
}
```

**Bus flow:**
```
task → expert → graph(plan steps) → learner reads plan → executes → graph(step status)
                    ↑                                                      ↓
                    └──────────── learner writes clarify request ──────────┘
```

---

## 2. Graph-Backed Coordination

Instead of agents parsing each other's prose from bus messages, they read and write structured facts through the graph. This is the key enabler for small models -- structured data is far more reliable than free-text parsing.

### Pattern-specific graph vocabularies

Add to `src/graph/vocabulary.ts` in the PORTER namespace:

```ts
// Collaboration pattern classes
Finding: `${NS}Finding`,          // Specialist observation (Mixture)
Critique: `${NS}Critique`,        // Reflector feedback (Deliberation)
PlanStep: `${NS}PlanStep`,        // Expert plan step (Distillation)
StepStatus: `${NS}StepStatus`,    // Learner step completion (Distillation)

// Properties
domain: `${NS}domain`,            // Specialist's domain area
confidence: `${NS}confidence`,    // Finding confidence (0-1)
round: `${NS}round`,              // Deliberation round number
approved: `${NS}approved`,        // Reflector approval flag
stepOrder: `${NS}stepOrder`,      // Plan step sequence
stepState: `${NS}stepState`,      // pending/active/done/failed
addresses: `${NS}addresses`,      // Links critique to the finding it addresses
```

### Pattern-specific tools

New tools injected per role (like AP tools are auto-injected for AP sessions):

**Mixture specialists get `finding_write`:**
```ts
{
  name: "finding_write",
  description: "Record a finding from your domain analysis.",
  input_schema: {
    properties: {
      about: { type: "string", description: "What the finding is about" },
      finding: { type: "string", description: "Your analysis" },
      confidence: { type: "number", description: "0.0 to 1.0" },
      domain: { type: "string", description: "Your area of expertise" },
    },
    required: ["about", "finding"],
  },
}
```

**Mixture synthesizer gets `findings_query`:**
```ts
{
  name: "findings_query",
  description: "Query all specialist findings. Returns structured results.",
  input_schema: {
    properties: {
      domain: { type: "string", description: "Filter by domain (optional)" },
      min_confidence: { type: "number", description: "Minimum confidence threshold (optional)" },
    },
  },
}
```

**Deliberation reflector gets `critique_write` + `approve`:**
- `critique_write`: Record specific feedback about the worker's output
- `approve`: Mark the current work as accepted (ends deliberation)

**Deliberation worker gets `critiques_query`:**
- Returns unaddressed critiques from the current round

**Distillation expert gets `plan_write`:**
- Record a plan step with order, description, and expected outcome

**Distillation learner gets `plan_query` + `step_update`:**
- `plan_query`: Get the next pending step from the expert's plan
- `step_update`: Mark a step as done/failed with notes

These tools are simpler and more constrained than the raw `memory_write`/`memory_query` tools -- small models handle them better because each tool does one specific thing with clear parameters.

### Implementation

Create `src/orchestration/patterns.ts`:
- `wirePattern(pattern, agents, graphStore)` -- sets up channels, injects tools and system prompts
- `getPatternTools(role, pattern)` -- returns the role-specific graph tools
- `getPatternSystemPrompt(role, pattern, agents)` -- returns the role-specific system prompt suffix
- Pattern tools write/read RDF triples via `GraphStore` (already exists in `src/graph/store.ts`)

---

## 3. Tool-Calling Inference Engine

Porter already has a 7-stage text parser (`tool_shim.ts`) and auto-repair (`shapes.ts`). But small models fail at a higher level: they don't know *which* tool to use, they hallucinate parameters, or they generate tool calls when they should just respond with text. The inference engine adds a smarter decision layer.

### Tool Intent Classifier

Before parsing tool calls from model output, classify the model's *intent*:

```ts
interface ToolIntent {
  wantsToolCall: boolean;       // Does the output indicate tool-use intent?
  likelyTool: string | null;    // Best-guess tool name
  confidence: number;           // 0-1
  suggestedParams: Record<string, unknown> | null;
}
```

**How it works:**
1. **Keyword/pattern scan** -- look for intent signals in the model's text output before trying to parse JSON:
   - "let me read the file" / "I'll check" → `read_file`
   - "I need to run" / "let me execute" → `bash`
   - "I'll write" / "let me create" → `write_file`
   - "searching for" / "looking for" → `grep` or `glob`
   - Action verbs + nouns matched against tool descriptions

2. **Context-aware tool suggestion** -- based on the conversation state and what tools have been used recently:
   - After `read_file`, the model likely wants `edit_file` or `write_file` next
   - After `grep` with results, likely wants `read_file` on a found file
   - After `bash` error, likely wants `bash` retry or `read_file` to check
   - Graph state: if the current plan step says "edit the config file", suggest `edit_file`

3. **Parameter extraction from natural language** -- if the model writes "let me read src/main.ts", extract `{ path: "src/main.ts" }` even without JSON formatting.

### Simplified Tool Schemas for Small Models

When a model is flagged as small (via config or auto-detected from model name/size), reduce cognitive load:

**Tool reduction:** Only show the 4-5 most relevant tools based on:
- The current pattern role (specialist doesn't need `write_file`)
- The current task context (graph state indicates which step we're on)
- Recent tool usage (don't re-show tools that just succeeded)

**Schema simplification:** For small models, use shorter descriptions and fewer optional parameters:
```ts
// Full schema (for large models):
{ name: "edit_file", description: "Replace exact string in file...", 
  input_schema: { properties: { path, old_string, new_string, replace_all } } }

// Simplified (for small models):
{ name: "edit_file", description: "Edit a file. Give the exact text to find and replace.",
  input_schema: { properties: { path, old_string, new_string } } }
```

### Recovery loop

When a tool call fails to parse or validate, instead of immediately returning an error to the model (which small models often can't recover from), the engine:

1. Infers intent from the surrounding text
2. If confident (>0.8), auto-constructs the tool call and executes
3. If uncertain, sends a structured nudge with the exact JSON format to use:
   ```
   I couldn't parse your tool call. To read a file, use exactly:
   {"tool": "read_file", "input": {"path": "the/file/path.ts"}}
   ```
4. Tracks which tools the model struggles with and pre-fills examples in future prompts

### Implementation

Create `src/tools/inference_engine.ts`:
- `classifyIntent(text, toolRegistry, graphState?)` → `ToolIntent`
- `extractParamsFromText(text, toolName, schema)` → params or null
- `simplifySchemas(tools, modelSize, role, context)` → reduced tool list
- `buildRecoveryNudge(failedText, likelyTool, schema)` → structured error message
- `getContextualToolOrder(recentTools, graphState, patternRole)` → prioritized tool list

Wire into the agent loop in `src/runtime/agent.ts`:
- After `parseToolCalls()` returns empty but text looks like tool intent → try `classifyIntent()`
- If classification confident → auto-construct and execute
- If not → use `buildRecoveryNudge()` instead of generic error
- Before each API call → use `simplifySchemas()` if model is small

**Model size detection:** Check `ModelConfig.context_window` or model name patterns (names containing "1b", "3b", "1.5b", "7b" → small; "70b", "claude", "gpt-4" → large). Add `small_model?: boolean` to `AgentConfig` for explicit override.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/orchestration/patterns.ts` | Pattern wiring: channel setup, tool injection, system prompt generation, round tracking |
| `src/tools/inference_engine.ts` | Tool intent classification, parameter extraction, schema simplification, recovery nudges |
| `src/tools/finding_write.ts` | Mixture specialist: write finding to graph |
| `src/tools/findings_query.ts` | Mixture synthesizer: query findings from graph |
| `src/tools/critique_write.ts` | Deliberation reflector: write critique to graph |
| `src/tools/critiques_query.ts` | Deliberation worker: query unaddressed critiques |
| `src/tools/approve.ts` | Deliberation reflector: approve work (end loop) |
| `src/tools/plan_write.ts` | Distillation expert: write plan step to graph |
| `src/tools/plan_query.ts` | Distillation learner: get next pending step |
| `src/tools/step_update.ts` | Distillation learner: mark step done/failed |

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/config.ts` | Add `pattern`, extend `AgentRole`, add `small_model?` to `AgentConfig` |
| `src/graph/vocabulary.ts` | Add Finding, Critique, PlanStep, StepStatus classes and properties |
| `src/orchestration/orchestrator.ts` | Call `wirePattern()` during `start()` |
| `src/runtime/agent.ts` | Integrate inference engine into tool call pipeline |
| `src/tools/mod.ts` | Add pattern tool loading |
| `src/providers/tool_shim.ts` | Use simplified schemas for small models |
| `src/cli/init.ts` | Pattern selection in interactive init |
| `src/activitypub/actor.ts` | Pattern-aware welcome messages |
| `src/activitypub/session_bridge.ts` | Pattern-aware `#who` output |
| `porter.example.json` | Examples of each pattern |
| `README.md` | Document patterns + inference engine |

## Documentation

### README.md

Add a new "Collaboration Patterns" section (before or alongside the existing Configuration Reference). Cover:

- **Overview** -- why patterns matter for small models, the three patterns with when to use each
- **Mixture** -- config example, how specialists write findings to graph, synthesizer queries
- **Deliberation** -- config example, reflector↔worker loop, max rounds, graph-tracked critiques
- **Distillation** -- config example, expert plans in graph, learner executes and reports status
- **Graph coordination** -- how agents share structured state, pattern-specific tools table
- **Tool inference engine** -- what it does for small models (intent classification, schema simplification, recovery nudges), `small_model` config flag
- **Combining with AP federation** -- how fediverse users interact with patterned teams, `#who` shows pattern roles

### Example configs

Create example config files in `examples/` directory:

**`examples/mixture-review.json`** -- Code review team with parallel specialists:
```json
{
  "session": "code-review",
  "pattern": "mixture",
  "model": "granite-3b",
  "agents": [
    { "name": "correctness", "role": "specialist", "system_prompt": "Analyze for bugs, logic errors, and incorrect behavior." },
    { "name": "security", "role": "specialist", "system_prompt": "Analyze for security vulnerabilities, injection risks, and auth issues." },
    { "name": "performance", "role": "specialist", "system_prompt": "Analyze for performance bottlenecks, memory leaks, and scaling issues." },
    { "name": "synthesizer", "role": "synthesizer", "model": "granite-8b", "system_prompt": "Synthesize specialist analyses into a unified review." }
  ]
}
```

**`examples/deliberation-coder.json`** -- Coding with reflection loop:
```json
{
  "session": "careful-coder",
  "pattern": "deliberation",
  "max_deliberation_rounds": 3,
  "model": "granite-3b",
  "agents": [
    { "name": "coder", "role": "worker", "tools": ["read_file", "write_file", "edit_file", "bash", "glob", "grep"] },
    { "name": "reviewer", "role": "reflector", "model": "granite-8b", "tools": ["read_file", "glob", "grep"] }
  ]
}
```

**`examples/distillation-guided.json`** -- Large model guides small model:
```json
{
  "session": "guided-dev",
  "pattern": "distillation",
  "agents": [
    { "name": "architect", "role": "expert", "model": "granite-8b", "tools": ["read_file", "glob", "grep", "list_dir"] },
    { "name": "developer", "role": "learner", "model": "granite-3b", "tools": ["read_file", "write_file", "edit_file", "bash", "git"] }
  ]
}
```

**`examples/mixture-research.json`** -- Research team with domain specialists:
```json
{
  "session": "research",
  "pattern": "mixture",
  "agents": [
    { "name": "code-analyst", "role": "specialist", "model": "qwen-coder-3b", "tools": ["read_file", "glob", "grep"] },
    { "name": "doc-analyst", "role": "specialist", "model": "granite-3b", "tools": ["read_file", "glob"] },
    { "name": "test-analyst", "role": "specialist", "model": "granite-3b", "tools": ["read_file", "glob", "grep", "bash"] },
    { "name": "reporter", "role": "synthesizer", "model": "granite-8b" }
  ]
}
```

**`examples/deliberation-security.json`** -- Security audit with iterative review:
```json
{
  "session": "security-audit",
  "pattern": "deliberation",
  "max_deliberation_rounds": 5,
  "agents": [
    { "name": "scanner", "role": "worker", "model": "granite-3b", "tools": ["read_file", "grep", "glob", "bash"] },
    { "name": "auditor", "role": "reflector", "model": "granite-8b", "tools": ["read_file", "grep"] }
  ]
}
```

### CONTRIBUTING.md

Note the new pattern system for contributors: how to add a new pattern (create tools, add to `patterns.ts`, wire channels).

## Verification

1. `deno check mod.ts`
2. `deno test --allow-all` -- existing + new pattern/engine tests
3. `porter init` -- select each pattern, verify generated config
4. Unit tests:
   - `classifyIntent("let me read src/main.ts", registry)` → `{ wantsToolCall: true, likelyTool: "read_file", confidence: 0.9 }`
   - `extractParamsFromText("read src/main.ts", "read_file", schema)` → `{ path: "src/main.ts" }`
   - `simplifySchemas(tools, "small", "specialist")` → reduced set
   - Pattern tools write/query graph correctly
   - Deliberation stops after max rounds
   - Mixture synthesizer sees all specialist findings
5. Integration test with small model on RHOAI
