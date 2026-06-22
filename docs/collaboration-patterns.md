# Collaboration Patterns

## Agent Identity vs Pattern Behavior

Porter separates **agent identity** from **pattern behavior**. An agent defines domain expertise: its name, system prompt, model, and tool permissions. A pattern defines coordination: how agents communicate, what channels they subscribe to, and what specialized tools they receive at runtime.

This separation means the same agent can work in any pattern. A "security-analyst" agent configured with `read_file`, `grep`, and `glob` can serve as a specialist in a Mixture team, a reflector in a Deliberation team, or a worker in a Sequential team. The pattern injects the coordination behavior -- channels, auto-tools, and system prompt suffixes -- when the session starts.

Agents are portable. Patterns are pluggable. You build your agent library once and compose teams by placing agents into pattern roles.

---

## Pattern Definition Format

Patterns are defined as JSON files conforming to the `PatternDefinition` schema (see `src/orchestration/pattern_registry.ts`). Each definition specifies the coordination structure: what roles exist, how they communicate, and what tools are injected.

### Full Schema

```json
{
  "id": "string",
  "name": "string",
  "description": "string",
  "bus_flow": "string",
  "builtin": true | false,
  "max_rounds": 3,
  "roles": [
    {
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

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Unique identifier used in config files (e.g., `"mixture"`, `"deliberation"`) |
| `name` | `string` | yes | Human-readable display name |
| `description` | `string` | yes | What this pattern does and when to use it |
| `bus_flow` | `string` | yes | ASCII diagram of the message flow between roles |
| `builtin` | `boolean` | yes | Whether this is a built-in pattern (set automatically by the registry) |
| `roles` | `PatternRole[]` | yes | Role definitions that agents are placed into |
| `max_rounds` | `number` | no | Maximum iteration rounds (used by Deliberation; default: 3) |

### PatternRole Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Role identifier matching the agent's `role` field in config |
| `name` | `string` | yes | Human-readable role name shown in the UI |
| `description` | `string` | yes | What this role does within the pattern |
| `min` | `number` | yes | Minimum number of agents required for this role |
| `max` | `number` | yes | Maximum number of agents allowed for this role |
| `system_prompt_suffix` | `string` | yes | Text appended to the agent's system prompt at session start, providing pattern-specific instructions |
| `auto_tools` | `string[]` | yes | Tools automatically injected for this role (e.g., `finding_write` for specialists). These are added regardless of the agent's configured tool list |
| `subscribe` | `string[]` | yes | Bus channels this role subscribes to (e.g., `["task", "control"]`) |
| `subscribe_dynamic` | `string` | no | Dynamic subscription template. Uses `{name}` placeholder to create per-agent channels (e.g., `"specialist:{name}"` subscribes the synthesizer to each specialist's output channel) |
| `default_tools` | `string[]` | yes | Default tools given to agents in this role if the agent config does not specify its own `tools` array |

### Complete Example

```json
{
  "id": "mixture",
  "name": "Mixture",
  "description": "Parallel domain specialists analyze a problem independently, then a synthesizer reconciles their findings into a unified response.",
  "bus_flow": "task -> [specialists in parallel] -> graph -> synthesizer -> response",
  "builtin": true,
  "roles": [
    {
      "id": "specialist",
      "name": "Specialist",
      "description": "Analyzes the problem from a specific domain perspective",
      "min": 2,
      "max": 8,
      "system_prompt_suffix": "You are a domain specialist in a Mixture team. Analyze the problem from your area of expertise. Use the finding_write tool to record each finding with a confidence score and your domain name.",
      "auto_tools": ["finding_write", "send_message"],
      "subscribe": ["task", "control"],
      "default_tools": ["read_file", "glob", "grep", "list_dir"]
    },
    {
      "id": "synthesizer",
      "name": "Synthesizer",
      "description": "Aggregates specialist findings into a coherent response",
      "min": 1,
      "max": 1,
      "system_prompt_suffix": "You are the synthesizer in a Mixture team. Use findings_query to retrieve all specialist findings. Synthesize them into a coherent, comprehensive response.",
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

Porter ships with four built-in patterns. Their definitions are in `src/orchestration/patterns/`.

### Sequential

Traditional admin/worker/reviewer pipeline. An admin plans and coordinates, workers execute tasks, and reviewers verify the output. This is the default pattern and works well with large models.

**Roles:** Admin (0-1), Worker (1-8), Reviewer (0-2)

**Bus flow:** `task -> admin -> task -> workers -> log -> reviewer -> response`

**Definition:** `src/orchestration/patterns/sequential.json`

### Mixture

Parallel domain specialists analyze a problem independently, then a synthesizer reconciles their findings into a unified response. Each specialist writes structured findings to the shared graph. The synthesizer queries all findings via SPARQL and produces a unified result.

**When to use:** Multiple perspectives on the same problem -- code review, research, analysis.

**Roles:** Specialist (2-8), Synthesizer (1)

**Bus flow:** `task -> [specialists in parallel] -> graph -> synthesizer -> response`

**Definition:** `src/orchestration/patterns/mixture.json`

### Deliberation

A reflector iteratively critiques a worker's output, triggering corrections until the work is approved or the round limit is reached. The graph tracks critique history to prevent regression.

**When to use:** Tasks requiring iterative refinement -- coding with review, security auditing, writing.

**Roles:** Worker (1), Reflector (1)

**Bus flow:** `task -> worker -> deliberation -> reflector -> [approve or revision -> worker -> ...]`

**Definition:** `src/orchestration/patterns/deliberation.json`

### Distillation

A larger/stronger expert model reasons and creates a step-by-step plan, which a smaller learner model executes. The graph tracks plan progress and enables clarification requests.

**When to use:** A larger model should reason and plan while a smaller model executes -- guided development, mentored coding.

**Roles:** Expert (1), Learner (1)

**Bus flow:** `task -> expert -> graph(plan) -> learner -> execute -> graph(status) -> [clarify -> expert -> ...]`

**Definition:** `src/orchestration/patterns/distillation.json`

---

## Custom Patterns

Custom patterns let you define your own coordination structures without modifying Porter's source code.

### Creating a Custom Pattern

1. **Via the UI:** Open the Patterns panel in the dashboard. Click "New Pattern" and fill in the definition fields. The visual editor provides role slots where you set min/max, auto-tools, channels, and system prompt suffixes.

2. **Via JSON:** Write a JSON file following the `PatternDefinition` schema above. Upload it through the Patterns panel or register it via the API.

### Storage

Custom patterns are stored per-user. For SSO/Solid users, they sync to the LWS Pod alongside teams, agents, and models. For local users, they persist in the user store.

### Sharing Patterns

Patterns are portable JSON files. To share:

- **Download:** Click the download button on any pattern card in the Patterns panel. This exports the full JSON definition.
- **Upload:** Click "Upload Pattern" and select a `.json` file. Porter validates the definition and registers it.
- **Copy/paste:** Patterns are self-contained JSON -- copy from one Porter instance and upload to another.

Custom patterns appear alongside built-in patterns in the Team Builder's pattern selector. They work identically to built-in patterns.

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

### Example Errors

```
Requires at least 2 Specialists (have 1)
Maximum 1 Synthesizer allowed (have 2)
Requires a Worker
```
