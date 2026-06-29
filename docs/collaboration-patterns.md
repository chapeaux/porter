# Collaboration Patterns

## Agent Identity vs Pattern Behavior

Porter separates **agent identity** from **pattern behavior**. An agent defines domain expertise: its name, system prompt, model, and tool permissions. A pattern defines coordination: how agents communicate, what channels they subscribe to, and what specialized tools they receive at runtime.

This separation means the same agent can work in any pattern. A "security-analyst" agent configured with `read_file`, `grep`, and `glob` can serve as a specialist in a Mixture team, a reflector in a Deliberation team, or a worker in a Sequential team. The pattern injects the coordination behavior -- channels, auto-tools, and system prompt suffixes -- when the session starts.

Agents are portable. Patterns are pluggable. You build your agent library once and compose teams by placing agents into pattern roles.

### Example: Same Agent in Different Patterns

The same agent definition works across patterns. The pattern injects the coordination behavior:

```json
// Agent library definition
{
  "name": "security-analyst",
  "system_prompt": "You are a security expert. Analyze code for vulnerabilities...",
  "tools": ["read_file", "grep", "glob", "list_dir"]
}

// In a Mixture team: agent gets finding_write + send_message auto-injected
{ "pattern": "mixture", "agents": [
  { "name": "security-analyst", "role": "specialist" },
  { "name": "perf-analyst", "role": "specialist" },
  { "name": "reporter", "role": "synthesizer" }
]}

// In a Deliberation team: same agent gets critique_write + approve auto-injected
{ "pattern": "deliberation", "agents": [
  { "name": "coder", "role": "worker" },
  { "name": "security-analyst", "role": "reflector" }
]}
```

---

## Pattern Definition Format

Patterns are defined as JSON-LD files conforming to the `PatternDefinition` schema (see `src/orchestration/pattern_registry.ts`). Each definition is a valid JSON-LD document with `@context`, `@type`, and `@id` fields that map Porter's vocabulary to RDF. The registry accepts both `.jsonld` and `.json` extensions, preferring `.jsonld`.

### Full Schema

```json
{
  "@context": { "..." : "..." },
  "@id": "porter:pattern/<id>",
  "@type": "Pattern",
  "id": "string",
  "name": "string",
  "description": "string",
  "bus_flow": "string",
  "builtin": true | false,
  "max_rounds": 3,
  "roles": [
    {
      "@type": "PatternRole",
      "id": "string",
      "name": "string",
      "description": "string",
      "min": 1,
      "max": 1,
      "system_prompt_suffix": "string",
      "auto_tools": ["string"],
      "subscribe": ["string"],
      "subscribe_dynamic": "string",
      "default_tools": ["string"]
    }
  ]
}
```

### JSON-LD Context

Every pattern file includes an inline `@context` that maps short property names to the `porter:` vocabulary namespace (`https://porter.chapeaux.io/vocab#`). The canonical context is also available as a standalone file at `src/orchestration/patterns/context.jsonld`. Key mappings:

| Short Name | RDF Property | Notes |
|------------|-------------|-------|
| `name` | `porter:name` | String |
| `description` | `porter:description` | String |
| `bus_flow` | `porter:busFlow` | String |
| `builtin` | `porter:isBuiltin` | `xsd:boolean` |
| `max_rounds` | `porter:maxRounds` | `xsd:integer` |
| `roles` | `porter:hasRole` | `@container: @set` |
| `min` | `porter:minCount` | `xsd:integer` |
| `max` | `porter:maxCount` | `xsd:integer` |
| `system_prompt_suffix` | `porter:systemPromptSuffix` | String |
| `auto_tools` | `porter:autoTool` | `@container: @set` |
| `subscribe` | `porter:subscribesTo` | `@container: @set` |
| `subscribe_dynamic` | `porter:subscribeDynamic` | String |
| `default_tools` | `porter:defaultTool` | `@container: @set` |

The `@type` values `Pattern` and `PatternRole` map to `porter:Pattern` and `porter:PatternRole` respectively.

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `@context` | `object` | yes (JSON-LD) | Inline context mapping short names to RDF terms |
| `@id` | `string` | yes (JSON-LD) | URI for this pattern, e.g. `"porter:pattern/mixture"` |
| `@type` | `string` | yes (JSON-LD) | Always `"Pattern"` |
| `id` | `string` | yes | Unique identifier used in config files (e.g., `"mixture"`, `"deliberation"`) |
| `name` | `string` | yes | Human-readable display name |
| `description` | `string` | yes | What this pattern does and when to use it |
| `bus_flow` | `string` | yes | Formal description of message flow between roles (see bus_flow syntax below) |
| `builtin` | `boolean` | yes | Whether this is a built-in pattern (set automatically by the registry) |
| `roles` | `PatternRole[]` | yes | Role definitions that agents are placed into |
| `max_rounds` | `number` | no | Maximum iteration rounds (used by Deliberation; default: 3) |

### PatternRole Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `@type` | `string` | yes (JSON-LD) | Always `"PatternRole"` |
| `id` | `string` | yes | Role identifier matching the agent's `role` field in config |
| `name` | `string` | yes | Human-readable role name shown in the UI |
| `description` | `string` | yes | What this role does within the pattern |
| `min` | `number` | yes | Minimum number of agents required for this role |
| `max` | `number` | yes | Maximum number of agents allowed for this role |
| `system_prompt_suffix` | `string` | yes | Text appended to the agent's system prompt at session start, providing pattern-specific instructions. Supports template variables: `{agent_name}` / `{your_name}` (replaced with the agent's name) and `{max_rounds}` (replaced with the configured deliberation round limit) |
| `auto_tools` | `string[]` | yes | Tools automatically injected for this role (e.g., `finding_write` for specialists). These are added regardless of the agent's configured tool list |
| `subscribe` | `string[]` | yes | Bus channels this role subscribes to (e.g., `["task", "control"]`) |
| `subscribe_dynamic` | `string` | no | Dynamic subscription template. Uses `{name}` placeholder to create per-agent channels (e.g., `"specialist:{name}"` subscribes the synthesizer to each specialist's output channel) |
| `default_tools` | `string[]` | yes | Default tools given to agents in this role if the agent config does not specify its own `tools` array |

### Complete Example

```json
{
  "@context": {
    "porter": "https://porter.chapeaux.io/vocab#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "id": "@id",
    "type": "@type",
    "name": "porter:name",
    "description": "porter:description",
    "bus_flow": "porter:busFlow",
    "builtin": { "@id": "porter:isBuiltin", "@type": "xsd:boolean" },
    "max_rounds": { "@id": "porter:maxRounds", "@type": "xsd:integer" },
    "roles": { "@id": "porter:hasRole", "@container": "@set" },
    "min": { "@id": "porter:minCount", "@type": "xsd:integer" },
    "max": { "@id": "porter:maxCount", "@type": "xsd:integer" },
    "system_prompt_suffix": "porter:systemPromptSuffix",
    "auto_tools": { "@id": "porter:autoTool", "@container": "@set" },
    "subscribe": { "@id": "porter:subscribesTo", "@container": "@set" },
    "subscribe_dynamic": "porter:subscribeDynamic",
    "default_tools": { "@id": "porter:defaultTool", "@container": "@set" },
    "Pattern": "porter:Pattern",
    "PatternRole": "porter:PatternRole"
  },
  "@id": "porter:pattern/mixture",
  "@type": "Pattern",
  "id": "mixture",
  "name": "Mixture",
  "description": "Parallel domain specialists analyze a problem independently, then a synthesizer reconciles their findings into a unified response. Optimized for small models.",
  "bus_flow": "task -> [role:specialist*] -> graph -> role:synthesizer -> response",
  "builtin": true,
  "roles": [
    {
      "@type": "PatternRole",
      "id": "specialist",
      "name": "Specialist",
      "description": "Analyzes the problem from a specific domain perspective",
      "min": 2,
      "max": 8,
      "system_prompt_suffix": "You are a domain specialist in a Mixture team. Analyze the problem from your area of expertise. Use the finding_write tool to record each finding with a confidence score and your domain name. Other specialists are analyzing simultaneously — focus on your domain. Publish your completion to channel 'specialist:{agent_name}' via send_message when done.",
      "auto_tools": ["finding_write", "send_message"],
      "subscribe": ["task", "control"],
      "default_tools": ["read_file", "glob", "grep", "list_dir"]
    },
    {
      "@type": "PatternRole",
      "id": "synthesizer",
      "name": "Synthesizer",
      "description": "Aggregates specialist findings into a coherent response",
      "min": 1,
      "max": 1,
      "system_prompt_suffix": "You are the synthesizer in a Mixture team. Use findings_query to retrieve all specialist findings. Synthesize them into a coherent, comprehensive response. Reconcile any contradictions and credit specific insights.",
      "auto_tools": ["findings_query", "send_message"],
      "subscribe": [],
      "subscribe_dynamic": "specialist:{name}",
      "default_tools": []
    }
  ]
}
```

---

## Built-in Patterns

Porter ships with four built-in patterns. Their definitions are JSON-LD files in `src/orchestration/patterns/`.

### Sequential

Traditional admin/worker/reviewer pipeline. An admin plans and coordinates, workers execute tasks, and reviewers verify the output. This is the default pattern and works well with large models.

**Roles:**

| Role | Min | Max | Auto Tools | Default Tools | Subscribe |
|------|-----|-----|------------|---------------|-----------|
| Admin | 0 | 1 | `send_message`, `read_messages` | `read_file`, `glob`, `grep`, `list_dir`, `memory_write`, `memory_query` | `log` |
| Worker | 1 | 8 | `send_message`, `read_messages` | `read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`, `list_dir`, `git` | `task`, `control` |
| Reviewer | 0 | 2 | `send_message`, `read_messages` | `read_file`, `bash`, `glob`, `grep`, `list_dir` | `review` |

**Bus flow:** `task -> role:admin -> task -> role:worker* -> log -> role:reviewer -> response`

**When to use:** General-purpose task execution where a planner decomposes work, multiple workers execute in sequence, and optional reviewers verify quality. Works well with large models that can handle open-ended coordination.

**Definition:** `src/orchestration/patterns/sequential.jsonld`

### Mixture

Parallel domain specialists analyze a problem independently, then a synthesizer reconciles their findings into a unified response. Each specialist writes structured findings to the shared graph. The synthesizer queries all findings via SPARQL and produces a unified result.

**Roles:**

| Role | Min | Max | Auto Tools | Default Tools | Subscribe |
|------|-----|-----|------------|---------------|-----------|
| Specialist | 2 | 8 | `finding_write`, `send_message` | `read_file`, `glob`, `grep`, `list_dir` | `task`, `control` |
| Synthesizer | 1 | 1 | `findings_query`, `send_message` | (none) | (dynamic: `specialist:{name}`) |

**Bus flow:** `task -> [role:specialist*] -> graph -> role:synthesizer -> response`

**When to use:** Multiple perspectives on the same problem -- code review, research, analysis. Optimized for small models because specialists have a narrow, focused task.

**Definition:** `src/orchestration/patterns/mixture.jsonld`

### Deliberation

A reflector iteratively critiques a worker's output, triggering corrections until the work is approved or the round limit is reached. The graph tracks critique history to prevent regression.

**Roles:**

| Role | Min | Max | Auto Tools | Default Tools | Subscribe |
|------|-----|-----|------------|---------------|-----------|
| Worker | 1 | 1 | `critiques_query`, `send_message` | `read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`, `list_dir`, `git` | `task`, `revision`, `control` |
| Reflector | 1 | 1 | `critique_write`, `approve`, `send_message` | `read_file`, `glob`, `grep`, `list_dir` | `deliberation`, `control` |

**Bus flow:** `task -> role:worker -> deliberation -> role:reflector -> (approve -> response | revision -> role:worker)`

**When to use:** Tasks requiring iterative refinement -- coding with review, security auditing, writing. The `max_rounds` field (default: 3) caps the review loop.

**Deliberation handoff:** The worker publishes a summary of its work to the `deliberation` channel via `send_message`. The reflector reviews it and either calls the `approve` tool (which publishes an `APPROVED` signal on the `deliberation` channel and marks all critiques from the current round as addressed in the graph) or writes critiques via `critique_write` and sends a revision request to the `revision` channel. The worker receives the revision, queries specific critiques via `critiques_query`, addresses each one, and resubmits. The loop continues until approval or the round limit is reached.

The `{max_rounds}` template variable in the worker's system prompt suffix is replaced at session start with the configured value (from the team config's `max_deliberation_rounds` or the pattern's `max_rounds` default of 3), so the worker knows how many rounds remain.

**Definition:** `src/orchestration/patterns/deliberation.jsonld`

### Distillation

A larger/stronger expert model reasons and creates a step-by-step plan, which a smaller learner model executes. The graph tracks plan progress and enables clarification requests.

**Roles:**

| Role | Min | Max | Auto Tools | Default Tools | Subscribe |
|------|-----|-----|------------|---------------|-----------|
| Expert | 1 | 1 | `plan_write`, `send_message` | `read_file`, `glob`, `grep`, `list_dir` | `task`, `clarify`, `control` |
| Learner | 1 | 1 | `plan_query`, `step_update`, `send_message` | `read_file`, `write_file`, `edit_file`, `bash`, `git` | `guidance`, `control` |

**Bus flow:** `task -> role:expert -> graph -> role:learner -> response ; role:learner -> clarify -> role:expert`

**When to use:** A larger model should reason and plan while a smaller model executes -- guided development, mentored coding.

**Definition:** `src/orchestration/patterns/distillation.jsonld`

---

## bus_flow Formal Syntax

The `bus_flow` field uses a small grammar to describe message flow between roles. This string is displayed in the UI and used by the visual editor to generate topology.

### Grammar Elements

| Element | Syntax | Description |
|---------|--------|-------------|
| **Role reference** | `role:name` | References a pattern role by its `id` |
| **Multi-agent role** | `role:name*` | Indicates the role may have multiple agents |
| **Parallel execution** | `[items]` | Items inside brackets run in parallel |
| **Branching** | `(branch1 \| branch2)` | Alternative paths (e.g., approve or revise) |
| **Sequence arrow** | `->` | Sequential flow from left to right |
| **Secondary flow** | `;` | Separates independent flow paths (e.g., a clarification channel) |
| **Named channel** | `name` | A bare name like `task`, `graph`, `log`, `response`, `deliberation` |
| **Labeled store** | `graph(label)` | A graph node with a descriptive label (e.g., `graph(findings)`, `graph(plan)`) |

### Built-in Pattern bus_flow Strings

**Sequential:**
```
task -> role:admin -> task -> role:worker* -> log -> role:reviewer -> response
```
Admin receives tasks, dispatches to workers (possibly multiple), workers log output, reviewer checks before final response.

**Mixture:**
```
task -> [role:specialist*] -> graph -> role:synthesizer -> response
```
All specialists receive the task in parallel (bracket notation), write findings to the graph, then the synthesizer reads and produces the response.

**Deliberation:**
```
task -> role:worker -> deliberation -> role:reflector -> (approve -> response | revision -> role:worker)
```
Worker output flows to the reflector, who either approves (ending the loop) or sends a revision back to the worker (branching notation).

**Distillation:**
```
task -> role:expert -> graph -> role:learner -> response ; role:learner -> clarify -> role:expert
```
Main flow: expert plans, learner executes. Secondary flow (after `;`): learner can send clarification requests back to the expert.

### Flow Diagram Rendering

The dashboard renders `bus_flow` strings as visual flow diagrams using the `flow-parser` and `flow-diagram` modules. The parser tokenizes the bus_flow string into nodes and edges, and the diagram module renders them as an SVG with directional arrows, parallel groupings, and branch indicators.

---

## Pattern-Specific Tools

Patterns inject role-specific coordination tools at runtime via the `auto_tools` field. These tools are backed by the session's RDF graph, enabling structured data exchange between agents.

### Auto-Injected Tools by Role

| Pattern | Role | Auto Tools | Purpose |
|---------|------|------------|---------|
| Sequential | Admin | `send_message`, `read_messages` | Dispatch tasks, read worker output |
| Sequential | Worker | `send_message`, `read_messages` | Report progress, receive instructions |
| Sequential | Reviewer | `send_message`, `read_messages` | Report review results |
| Mixture | Specialist | `finding_write`, `send_message` | Record domain findings to graph, signal completion |
| Mixture | Synthesizer | `findings_query`, `send_message` | Query all specialist findings from graph |
| Deliberation | Worker | `critiques_query`, `send_message` | Read reflector critiques from graph |
| Deliberation | Reflector | `critique_write`, `approve`, `send_message` | Write critique to graph, approve to end loop |
| Distillation | Expert | `plan_write`, `send_message` | Write step-by-step plan to graph |
| Distillation | Learner | `plan_query`, `step_update`, `send_message` | Read next plan step, mark completion/failure |

### Graph-Backed Coordination

The tools above read from and write to the session's RDF graph rather than passing raw text. This means:

- **`finding_write`** creates a structured finding node with confidence, domain, and content. The synthesizer can query all findings via SPARQL.
- **`critique_write`** creates a critique node linked to the work being reviewed. The worker can query specific issues via `critiques_query`.
- **`plan_write`** creates ordered plan steps with expected outcomes. The learner queries the next pending step via `plan_query` and marks it done/failed via `step_update`.
- **`approve`** writes an approval assertion to the graph, triggering the orchestrator to end the deliberation loop.

This graph-backed approach ensures agents can coordinate without needing to parse each other's natural language output.

---

## Tool Inference Engine

The inference engine (`src/tools/inference_engine.ts`) helps small models that struggle with structured tool invocation. It provides four capabilities:

### 1. Intent Classification (`classifyIntent`)

Analyzes a model's natural language output to determine if it intends a tool call. Uses regex-based pattern matching against known intent signals (e.g., "reading the file" maps to `read_file` with confidence 0.85, "let me try" maps to `bash` with confidence 0.65).

The classifier also applies **context-aware boosting**: if the model recently used `read_file`, follow-up tools like `edit_file` and `write_file` get a confidence boost of 0.15. The follow-up chains are defined in `FOLLOW_UP_MAP`:

| Last Tool | Likely Next Tools |
|-----------|-------------------|
| `read_file` | `edit_file`, `write_file` |
| `grep` | `read_file` |
| `bash` | `bash` |
| `glob` | `read_file` |
| `finding_write` | `finding_write`, `send_message` |
| `critique_write` | `critique_write`, `send_message` |
| `findings_query` | `send_message` |
| `plan_write` | `plan_write` |

Intent classification returns a `ToolIntent` object with `wantsToolCall`, `likelyTool`, `confidence`, and `suggestedParams`.

### 2. Schema Simplification (`simplifySchemas`)

For small models, tool schemas are simplified to reduce confusion:

- **Descriptions** are truncated to the first sentence.
- **Optional parameters** are removed -- only required properties remain.
- **Role-based filtering** removes tools that a role should not use (e.g., specialists cannot `write_file`, `edit_file`, or `bash`).
- **Priority ordering** moves the most relevant tools for each role to the front of the list, based on the `ROLE_TOOL_PRIORITY` map.
- **Tool count cap** limits small models to a maximum of 8 tools.

For large models, schemas are returned unchanged.

### 3. Recovery Nudges (`buildRecoveryNudge`)

When a model's output fails to parse as a tool call, the engine builds a structured error message showing the correct invocation format. If the intent classifier identified a likely tool, the nudge includes an example with placeholder values derived from the schema:

```
I couldn't parse your tool call. To use read_file, respond with exactly:
{"tool": "read_file", "input": {"path": "..."}}
```

### 4. Contextual Tool Ordering (`getContextualToolOrder`)

Reorders the tool list based on recent usage. If the model last used `grep`, `read_file` is promoted to the front. This reduces the cognitive load for small models by putting the most likely next tool first.

### Configuration

The inference engine activates automatically for models classified as `small` by the model registry. The `small_model` flag on a model's configuration determines whether simplification and intent classification apply. Set `small_model: true` on an agent to enable it explicitly, or let Porter auto-detect from the model name (names containing "1b", "3b", "7b" are treated as small).

```json
{
  "name": "developer",
  "role": "learner",
  "small_model": true,
  "tools": ["read_file", "write_file", "edit_file", "bash"]
}
```

---

## Custom Patterns

Custom patterns let you define your own coordination structures without modifying Porter's source code.

### Creating a Custom Pattern

1. **Via the UI:** Open the Patterns panel in the dashboard. Click "New Pattern" to open the visual pattern editor. Define roles, channels, and connections visually. The editor generates the `bus_flow` string from your topology. Set role properties (min/max, auto-tools, channels, system prompt suffixes) in the properties panel.

2. **Via JSON-LD:** Write a `.jsonld` file following the `PatternDefinition` schema above. Upload it through the Patterns panel or register it via the `POST /api/patterns` endpoint.

### Storage

Custom patterns are stored per-user. For SSO/Solid users, they sync to the LWS Pod alongside teams, agents, and models. For local users, they persist in the user store.

### Sharing Patterns

Patterns are portable JSON-LD files. To share:

- **Download:** Click the download button on any pattern card in the Patterns panel. This exports the full JSON-LD definition.
- **Upload:** Click "Upload Pattern" and select a `.jsonld` or `.json` file. Porter validates the definition against SHACL shapes and registers it.
- **Solid Pod ACL:** Patterns stored on a Solid Pod can be made public via ACL. Use `setResourcePublic()` to grant read access to any agent (i.e., the `foaf:Agent` class). Other Porter instances can then import the pattern by URL.

Custom patterns appear alongside built-in patterns in the Team Builder's pattern selector. They work identically to built-in patterns.

Patterns are also managed in the dashboard via the **PATTERNS** flipboard cell, which opens the Pattern Manager dialog.

---

## Visual Pattern Editor

The pattern editor (`src/ui/dialogs/pattern-editor.js`) is an SVG-based visual tool for designing collaboration patterns.

### Layout

The editor has three sections:

1. **Header panel:** Pattern-level properties (name, description, max rounds). The pattern ID is auto-generated from the name.
2. **SVG canvas:** Interactive canvas where roles and channels are represented as draggable nodes connected by directed edges.
3. **Footer panel:** Properties for the currently selected node (role fields or channel name).

### Node Types

- **Role nodes** (rounded-corner rectangles, gold accent): Represent pattern roles. Properties include `id`, `name`, `description`, `min`, `max`, `system_prompt_suffix`, `auto_tools`, `subscribe`, and `default_tools`.
- **Channel nodes** (pill-shaped, dimmer): Represent bus channels. Properties include `name`.

### Toolbar Actions

| Button | Action |
|--------|--------|
| Add Role | Creates a new role node at (200, 150) with default values |
| Add Channel | Creates a new channel node at (200, 200) |
| Connect | Enters connect mode -- click two nodes to create a directed edge |
| Delete | Removes the selected node (and its edges) or selected edge |
| Auto Layout | Topologically sorts nodes by edge direction and repositions them top-to-bottom, left-to-right using Kahn's algorithm |

### Interaction

- **Drag nodes** to reposition them. Positions snap to a 10px grid.
- **Click a node** to select it and show its properties in the footer panel.
- **Click an edge** to select it (highlighted in gold). Press Delete to remove it.
- **Connect mode:** Click the first node (source), then the second node (target) to create a directed edge. Duplicate edges are prevented.
- **Read-only mode** is used when viewing existing patterns -- nodes are not draggable, fields are not editable.

### bus_flow Generation

On save, the editor generates a `bus_flow` string from the graph topology:

- Topological sort determines node order.
- Nodes with multiple outgoing edges produce parallel notation (e.g., `[role_a, role_b]`).
- Roles with `max > 1` get a `*` suffix (e.g., `specialist*`).
- Disconnected subgraphs are separated by `;`.

### Saving

The Save button posts the pattern definition to `POST /api/patterns`. The pattern must have a name and at least one role.

---

## SHACL Validation

Pattern definitions are validated against SHACL shapes defined in `src/orchestration/patterns/pattern-shapes.ttl`.

### PatternShape (`porter:PatternShape`)

Validates `porter:Pattern` instances:

| Property | Constraint |
|----------|-----------|
| `porter:name` | Required, exactly 1, `xsd:string` |
| `porter:description` | Optional, at most 1, `xsd:string` |
| `porter:busFlow` | Required, exactly 1, `xsd:string` |
| `porter:hasRole` | Required, at least 1, must conform to `PatternRoleShape` |
| `porter:maxRounds` | Optional, at most 1, `xsd:integer` |
| `porter:isBuiltin` | Optional, at most 1, `xsd:boolean` |

### PatternRoleShape (`porter:PatternRoleShape`)

Validates `porter:PatternRole` instances:

| Property | Constraint |
|----------|-----------|
| `porter:roleId` | Required, exactly 1, `xsd:string` |
| `porter:name` | Required, exactly 1, `xsd:string` |
| `porter:description` | Optional, at most 1, `xsd:string` |
| `porter:minCount` | Required, exactly 1, `xsd:integer` |
| `porter:maxCount` | Required, exactly 1, `xsd:integer` |
| `porter:systemPromptSuffix` | Optional, at most 1, `xsd:string` |

Validation runs on save (both via the UI editor and the API).

---

## Linked Data

Porter uses linked data throughout its data model. Agents, teams, and patterns are all URI-addressable RDF resources.

### JSON-LD Contexts

Porter provides two JSON-LD contexts:

1. **Pattern context** (`src/orchestration/patterns/context.jsonld`): Maps pattern properties (`name`, `busFlow`, `hasRole`, `minCount`, `maxCount`, etc.) to the `porter:` namespace.

2. **Agent context** (`src/agents/context.jsonld`): Maps agent properties (`name`, `expertise`, `model`, `tools`, `reasoning`, `maxTokens`, `visibility`, `derivedFrom`, `linkedFrom`) to the `porter:` namespace.

Both contexts use the namespace `https://porter.chapeaux.io/vocab#`.

### JSON-LD Conversion

The pattern registry (`src/orchestration/pattern_registry.ts`) provides two conversion functions:

- **`patternToJsonLd(pattern)`**: Converts a `PatternDefinition` to a JSON-LD document with `@context`, `@type: "Pattern"`, and `@id: "porter:pattern/<id>"`. Roles are annotated with `@type: "PatternRole"`.

- **`jsonLdToPattern(doc)`**: Parses a JSON-LD document back to a `PatternDefinition`. Handles both inline context (short names like `roles`, `min`, `max`) and external context (full names like `hasRole`, `minCount`, `maxCount`).

### Turtle Serialization

Agents and teams are serialized to Turtle format for storage on Solid Pods:

- **`agentToTurtle(agent, uri)`** (`src/ui/sync/sync-helpers.js`): Serializes an agent as a `porter:Agent` with properties like `porter:name`, `porter:assignedRole`, `porter:agentExpertise`, `porter:hasTool`, `porter:subscribesTo`, `porter:usesModel`, etc.

- **`teamToTurtle(team, uri)`** (`src/ui/sync/sync-helpers.js`): Serializes a team as a `porter:Team` with `porter:name`, `porter:teamPattern`, `porter:hasAgentRef` (blank nodes with `porter:agentRef` and `porter:assignedRole`), and `porter:configJson` for lossless round-tripping.

### Content Negotiation

Resources on the Solid Pod are stored as `text/turtle` and can be fetched with standard HTTP. The Pod's Linked Data Platform (LDP) interface provides container listings via `ldp:contains`.

### Import from URL (Link/Copy)

Agents support `porter:derivedFrom` and `porter:linkedFrom` properties (defined in the agent JSON-LD context) for tracking provenance. When importing an agent from a URL:

- **Link** (`linkedFrom`): The agent references the original URI. Updates to the source are reflected.
- **Copy** (`derivedFrom`): The agent is a snapshot. The original URI is recorded for provenance but the agent is independent.

### Individual Turtle Files on Solid Pod

Each agent is stored as an individual Turtle file at `{podRoot}/porter/agents/{name}.ttl`. Each team is stored at `{podRoot}/porter/teams/{name}.ttl`. This per-resource storage enables fine-grained access control -- individual agents or teams can be made public via ACL while keeping others private.

The `setResourcePublic(authFetch, resourceUrl)` function writes a WAC ACL that grants `acl:Read` to `foaf:Agent` (any authenticated or unauthenticated user) while preserving owner control. `setResourcePrivate(authFetch, resourceUrl)` removes the ACL.

---

## CLI Integration

The `porter init` command (`src/cli/init.ts`) integrates pattern selection into the CLI setup wizard.

### Pattern Selection

The wizard presents all four built-in patterns as numbered options:

```
Collaboration pattern:
  * 1) Sequential — Traditional admin/worker/reviewer pipeline...
    2) Mixture — Parallel domain specialists analyze a problem...
    3) Deliberation — A reflector iteratively critiques a worker's output...
    4) Distillation — A larger/stronger expert model reasons and creates...
```

### Role-Based Agent Setup

After selecting a pattern, the wizard shows the pattern's roles with their descriptions and min/max requirements:

```
Pattern "Mixture" suggests these roles:
  Specialist (specialist): Analyzes the problem from a specific domain perspective [2-8]
  Synthesizer (synthesizer): Aggregates specialist findings into a coherent response [1]
```

Each agent created in the wizard:

1. Selects a role from the pattern's role list (with contextual labels showing role name and description).
2. Gets **tool defaults** from the pattern role's `default_tools` and `auto_tools` arrays.
3. Gets **channel defaults** from the pattern role's `subscribe` array.
4. Gets a **system prompt default** from the pattern role's `system_prompt_suffix`.

For Deliberation, the wizard also prompts for `max_deliberation_rounds` (default: 3).

### Add Agent

The `porter add-agent` command adds an agent to an existing config file. It reads the current agents, prompts for the new agent's configuration, and appends it.

---

## Example Configurations

The [`examples/`](../examples/) directory includes ready-to-use team configurations for each pattern:

| File | Pattern | Description |
|------|---------|-------------|
| [`mixture-review.json`](../examples/mixture-review.json) | mixture | Code review with correctness, security, and performance specialists |
| [`mixture-research.json`](../examples/mixture-research.json) | mixture | Codebase research with code, doc, and test analysts |
| [`deliberation-coder.json`](../examples/deliberation-coder.json) | deliberation | Coding with iterative review (3 rounds) |
| [`deliberation-security.json`](../examples/deliberation-security.json) | deliberation | Security audit with iterative verification (5 rounds) |
| [`distillation-guided.json`](../examples/distillation-guided.json) | distillation | Large model architect guides small model developer |
| [`solo-dev.json`](../examples/solo-dev.json) | sequential | Single developer agent |
| [`full-team.json`](../examples/full-team.json) | sequential | Admin, worker, and reviewer team |
| [`multi-model.json`](../examples/multi-model.json) | sequential | Mixed model team (different providers) |

---

## ActivityPub Integration

Patterns integrate with Porter's ActivityPub (fediverse) interface.

### `#who` Command

The `#who` command shows the team's pattern and role assignments. When a team uses a pattern, the response includes the pattern name and maps each agent to its pattern role name:

```
Team: my-team (Mixture pattern)
Agents:
  security-analyst — Specialist
  performance-analyst — Specialist
  coordinator — Synthesizer
```

Without a pattern, agents are shown with their raw role IDs.

### Welcome Message

When a fediverse user first messages a team, the welcome message includes the pattern name:

```
my-team — AI agent team on Porter

Pattern: Mixture

Agents:
  #security-analyst — Specialist
  #performance-analyst — Specialist
  #coordinator — Synthesizer
```

The agent names are prefixed with `#` so users can directly address them in subsequent messages (e.g., `#security-analyst check the auth module`).

### Actor Summary

The ActivityPub actor's `summary` field includes the pattern name in brackets (e.g., `AI agent team [Mixture]: security-analyst (specialist), coordinator (synthesizer)`), making pattern information visible to other fediverse users browsing the actor profile.

---

## Visual Team Composition

The Team Builder uses a slot-based UI for composing teams within a pattern. When you select a pattern, the builder shows the pattern's roles as slots with their min/max requirements.

1. **Select a pattern** -- choose from built-in or custom patterns.
2. **Fill role slots** -- drag agents from the library into role slots. Each slot shows its min/max (e.g., "Specialist: 2-8 agents"). Agents already in the library can be reused across teams.
3. **Validation feedback** -- the builder highlights unfilled requirements (red border if below min) and prevents exceeding max. The "Save & Launch" button is disabled until all role minimums are met.

The same agent can appear in different teams under different roles. A "security-analyst" agent placed into a Specialist slot gets `finding_write` and `send_message` auto-injected. Placed into a Reflector slot, it gets `critique_write` and `approve` instead. The agent's identity stays the same; only the pattern behavior changes.

---

## Validation

Porter enforces pattern composition rules when teams are created or launched.

### Min/Max Enforcement

Each role in a pattern definition specifies `min` and `max` counts. The `validateTeamComposition()` function checks that the team's agent list satisfies these constraints:

- If a role has fewer agents than its `min`, the team is invalid. The error message names the role and the shortfall.
- If a role has more agents than its `max`, the team is invalid. The error message names the role and the excess.

### Where Validation Runs

- **Team Builder UI:** real-time validation as agents are added/removed. Role slots show visual feedback.
- **Session launch:** validation runs before starting the session. If the team is invalid, the session fails with descriptive errors.
- **API:** the `POST /api/sessions` endpoint validates composition and returns errors in the response body.
- **SHACL:** pattern definitions are validated against SHACL shapes on save (name required, at least one role, min/max required on roles).

### Example Errors

```
Requires at least 2 Specialists (have 1)
Maximum 1 Synthesizer allowed (have 2)
Requires a Worker
```
