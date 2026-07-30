# Agent Authoring Guide

This guide covers how to write effective Porter agent definitions -- from the
JSON-LD format and field semantics to practical advice on expertise prompts,
tool selection, model tuning, and sharing agents across teams and Pods.

---

## JSON-LD Format

Every agent definition is a JSON-LD document. JSON-LD gives each agent a
stable URI, a machine-readable type, and a vocabulary that maps to RDF. This
means agents are not opaque config blobs -- they are linked data resources
that can be stored on a Solid Pod, fetched by URL, queried with SPARQL, and
validated with SHACL.

### Minimal Example

```json
{
  "@context": "https://porter.chapeaux.io/agents/context.jsonld",
  "@id": "porter:default/agents/my-agent",
  "@type": "Agent",
  "name": "my-agent",
  "expertise": "Short description of what this agent knows and does.",
  "tools": ["read_file", "grep", "glob", "list_dir"],
  "model": "",
  "reasoning": false,
  "maxTokens": 4096,
  "visibility": "private"
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `@context` | string | Always `"https://porter.chapeaux.io/agents/context.jsonld"`. Points to the canonical JSON-LD context that maps short property names (`name`, `expertise`, `tools`, etc.) to the `porter:` RDF namespace. |
| `@id` | string | URI for this agent. Convention: `"porter:default/agents/<name>"`. When stored on a Solid Pod the URI becomes the Pod resource URL. |
| `@type` | string | Always `"Agent"`. Maps to `porter:Agent` in RDF. |
| `name` | string | Machine-readable identifier. Lowercase, hyphenated. Used in team refs, bus channels, and the UI. |
| `expertise` | string | The agent's system prompt -- its knowledge, capabilities, constraints, and anti-patterns. This is the most important field; see the next section. |
| `tools` | string[] | List of tool names the agent is allowed to use. See "Available Tools" below. |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `""` (inherit team default) | Model override. Set to a specific model ID to override the team/session default. Leave empty to use whatever model the team config specifies. |
| `reasoning` | boolean | `false` | Enable extended thinking / chain-of-thought mode. Useful for complex analysis; increases latency and token usage. |
| `maxTokens` | integer | `8192` | Maximum tokens per response. See "Token Limits" below. |
| `visibility` | string | `"private"` | Access control for the agent definition. See "Visibility" below. |
| `derivedFrom` | string (URI) | -- | Provenance link: this agent was copied from the given URI. The agent is independent; updates to the source are not reflected. |
| `linkedFrom` | string (URI) | -- | Live link: this agent references the given URI. Updates to the source are reflected when the agent is re-fetched. |

### Context Vocabulary

The JSON-LD context maps these short names to the `porter:` namespace
(`https://porter.chapeaux.io/vocab#`):

| Short Name | RDF Property | JSON-LD Type |
|------------|-------------|--------------|
| `name` | `porter:name` | string |
| `expertise` | `porter:agentExpertise` | string |
| `model` | `porter:usesModel` | string |
| `tools` | `porter:hasTool` | `@set` (array) |
| `reasoning` | `porter:reasoning` | `xsd:boolean` |
| `maxTokens` | `porter:maxTokens` | `xsd:integer` |
| `visibility` | `porter:visibility` | string |
| `derivedFrom` | `porter:derivedFrom` | `@id` (URI) |
| `linkedFrom` | `porter:linkedFrom` | `@id` (URI) |

---

## Writing Effective Expertise Prompts

The `expertise` field is the agent's system prompt. It defines what the agent
knows, how it works, what it should avoid, and how it communicates. A well-
structured expertise prompt is the difference between a useful specialist and
a generic chatbot.

### Structure

Study the example agents. They all follow a consistent structure:

1. **Opening sentence** -- one line stating the agent's identity and scope.
2. **Core competencies** -- organized under bold section headers. Each section
   covers a coherent domain area.
3. **Implementation patterns** -- concrete techniques, not vague guidance.
   Code patterns, API names, specific numbers.
4. **Anti-patterns** -- an explicit list of things the agent must never do.

Example opening from `web-platform-specialist`:

```
Web Platform First architect and implementer. Builds applications using
browser-native APIs as the default choice, introducing dependencies only
when the platform genuinely cannot solve the problem.
```

This is one sentence that establishes identity ("architect and implementer"),
philosophy ("browser-native APIs as the default choice"), and a decision
framework ("only when the platform genuinely cannot solve the problem").

### Specificity

The most common mistake in agent prompts is vagueness. Compare:

**Weak:**
```
Expert in web development. Knows HTML, CSS, and JavaScript.
Good at building accessible websites.
```

**Strong:**
```
CSS custom properties for theming -- design tokens flow through --var-name.
No CSS-in-JS, no runtime style injection.
light-dark() for theme switching. @layer for specificity management.
Native nesting for scoping.
@container queries for component-level responsive design.
:host() and ::part() for Shadow DOM styling.
```

The weak version tells the model it is "good at accessibility." The strong
version shows the model exactly which APIs to use and which to avoid. Models
follow concrete instructions far more reliably than abstract self-descriptions.

### Actionable Patterns

Include specific patterns the agent should apply. Use the format:
`<what to use>` over/for `<what problem>`. Include approximate line counts
or complexity budgets where relevant.

From `web-platform-specialist`:

```
fetch() + Map<string, CacheEntry> over data-fetching libraries.
  ~150 lines replaces TanStack Query.
popstate + URLPattern over React Router.
  ~280 lines for full client-side routing.
Proxy for reactive state management
  (~60 lines replaces Redux/MobX/Zustand).
```

These patterns give the model a decision table. When it encounters a data-
fetching problem, it knows to reach for `fetch()` + `Map`, and it knows
roughly how much code that entails.

### Anti-Patterns

Always include an explicit anti-patterns section. Start each item with
"Never" or "No." Be specific about what the alternative is.

From `dashboard-designer`:

```
Never use pie charts for more than 5 segments. Use horizontal bar charts
  instead.
Never truncate data labels in charts -- if the label doesn't fit, redesign
  the chart.
Never use red/green as the only differentiator -- it's invisible to 8% of
  men.
```

Anti-patterns prevent the model from falling back to training-data defaults
that conflict with your team's standards.

### Scaling Expertise Length

Expertise prompts can range from a single paragraph to several thousand words.
The right length depends on the agent's scope:

| Agent Scope | Typical Length | Example |
|-------------|---------------|---------|
| Narrow specialist (one runtime, one framework) | 200-500 words | `deno-pro` |
| Domain specialist (design, brand, security) | 1000-3000 words | `rh-brand-specialist` |
| Cross-cutting architect (platform, full-stack) | 2000-5000 words | `web-platform-specialist` |

Longer prompts work well when they are structured with headers and bullet
points. Unstructured walls of text degrade model performance regardless of
length.

### Prompt Sourcing

In a Porter team config (the JSON config file, as opposed to the JSON-LD
agent definition), the `system_prompt` field supports three formats:

- **Literal string** -- the prompt text directly in the config.
- **File path** -- a path ending in `.md` (resolved relative to the config
  file). The file contents become the system prompt.
- **URL** -- a `http://` or `https://` URL. The response body becomes the
  system prompt.

This means you can maintain expertise prompts as standalone Markdown files
or host them on a web server for shared use across teams.

---

## Available Tools

Tools are capabilities that an agent can invoke during its conversation turn.
An agent can only use tools listed in its `tools` array. Pattern-specific
tools (like `finding_write` or `critique_write`) are injected automatically
by the collaboration pattern and do not need to be listed.

### File System Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `read_file` | Read the contents of a file by path. | Any agent that needs to examine code, configs, data, or documentation. The most commonly assigned tool. |
| `write_file` | Create or overwrite a file. | Agents that produce output files -- code generators, writers, builders. Not needed for read-only analysts. |
| `edit_file` | Apply a targeted edit to an existing file (find-and-replace). | Agents that modify existing code. Prefer over `write_file` for surgical changes since it preserves the rest of the file. |
| `glob` | Find files matching a glob pattern. | Discovery-oriented agents that need to locate files before reading them. Pair with `read_file`. |
| `grep` | Search file contents with regex. | Analysis agents that need to find patterns, usages, or occurrences across a codebase. Pair with `read_file`. |
| `list_dir` | List directory contents. | Agents that need to understand project structure. Lighter than `glob` for simple directory listings. |

### Execution Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `bash` | Execute a shell command. | Agents that need to run builds, tests, linters, or other CLI tools. Powerful but broad -- grant only when needed. |
| `git` | Run git commands. | Agents that need to inspect history, create branches, or commit changes. Separate from `bash` for finer-grained control. |

### Communication Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `send_message` | Send a message to a bus channel. | Inter-agent communication. Usually auto-injected by the pattern. |
| `read_messages` | Read messages from a bus channel. | Receiving inter-agent messages. Usually auto-injected by the pattern. |

### Knowledge Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `memory` | Save (`method: "save"`) or semantically search (`method: "search"`) the session's shared memory (RDF graph + vector index), typed as `semantic`/`episodic`/`procedural`. | Agents that discover reusable knowledge during their work, or that should check shared knowledge before starting to avoid redundant discovery. |

### Pattern-Specific Tools

These tools are auto-injected by collaboration patterns. You do not list them
in the agent's `tools` array -- the pattern adds them at session start based
on the agent's role.

| Tool | Pattern | Role | Description |
|------|---------|------|-------------|
| `finding_write` | Mixture | Specialist | Write a structured finding (domain, confidence, content) to the session graph. |
| `findings_query` | Mixture | Synthesizer | Query all specialist findings from the graph via SPARQL. |
| `critique_write` | Deliberation | Reflector | Write a structured critique linked to the work under review. |
| `critiques_query` | Deliberation | Worker | Read critiques from the reflector. |
| `approve` | Deliberation | Reflector | Write an approval assertion, ending the deliberation loop. |
| `plan_write` | Distillation | Expert | Write ordered plan steps with expected outcomes. |
| `plan_query` | Distillation | Learner | Query the next pending plan step. |
| `step_update` | Distillation | Learner | Mark a plan step as completed or failed. |
| `memory_admin` | Any (optional) | Librarian | Promote local memories to durable cross-session memory, adjudicate conflicts, edit/delete durable entries. |

### ActivityPub Tools

| Tool | Description | When to Use |
|------|-------------|-------------|
| `ap_post` | Post to the fediverse as the team's ActivityPub actor. | Agents that need to publish results or status updates to federated followers. |
| `ap_reply` | Reply to a specific ActivityPub message. | Agents responding to inbound fediverse messages. |

### Tool Selection Guidelines

**Read-only analysts** (code reviewers, security auditors, documentation
reviewers): `read_file`, `glob`, `grep`, `list_dir`. No write tools, no
`bash`.

**Code workers** (implementers, fixers, refactorers): `read_file`,
`write_file`, `edit_file`, `bash`, `glob`, `grep`, `list_dir`, `git`.

**Narrow specialists** (brand checkers, style validators): `read_file`,
`glob`, `grep`, `list_dir`. Only the tools needed to inspect, never to
modify.

**Knowledge workers** (researchers, analysts): `read_file`, `glob`, `grep`,
`list_dir`, `memory`.

Grant the minimum set of tools needed for the agent's job. An agent with
`bash` can do almost anything, which means it can also do almost anything
wrong. A specialist that only needs to read and search should not have
`bash` or `write_file`.

---

## Roles and How Patterns Assign Them

An agent's role is not set in the JSON-LD agent definition. Roles are
assigned when an agent is placed into a team. The same agent can have
different roles in different teams.

### Available Roles

| Role | Typical Use |
|------|-------------|
| `admin` | Plans and coordinates work. Decomposes tasks, dispatches to workers. Used by the Sequential pattern. |
| `worker` | Executes tasks. The general-purpose role for agents that do hands-on work. |
| `reviewer` | Verifies output quality. Reviews worker output for correctness, style, completeness. |
| `specialist` | Domain expert in a Mixture team. Analyzes problems from a specific perspective. |
| `synthesizer` | Aggregates specialist findings in a Mixture team. Reconciles and unifies. |
| `reflector` | Critiques and iterates in a Deliberation team. Reviews worker output and requests revisions. |
| `expert` | Plans and reasons in a Distillation team. Creates step-by-step plans for the learner. |
| `learner` | Executes plans in a Distillation team. Follows expert guidance step by step. |
| `librarian` | Optional, addable to any pattern. Curates which session-local memories are promoted to durable cross-session memory and resolves conflicts there. See [Knowledge Tools](#knowledge-tools) above. |

### How Patterns Use Roles

When a team launches with a collaboration pattern, the pattern injects
behavior into each agent based on its role:

1. **System prompt suffix** -- pattern-specific instructions appended to the
   agent's expertise prompt. For example, a specialist in a Mixture team gets
   instructions to use `finding_write` and publish completion signals.

2. **Auto-tools** -- tools injected regardless of the agent's `tools` array.
   A Mixture specialist automatically receives `finding_write` and
   `send_message`.

3. **Channel subscriptions** -- bus channels the agent listens on. A
   Sequential worker subscribes to `task` and `control`.

The agent's identity (expertise, tools, model) stays the same. The pattern
adds coordination behavior on top. A `security-analyst` agent placed into a
Specialist slot gets `finding_write` injected. The same agent placed into a
Reflector slot gets `critique_write` and `approve` instead.

---

## Model Overrides

The `model` field in an agent definition overrides the team's default model.
Leave it as an empty string (`""`) to inherit the team default, which is
the most common choice.

Set an explicit model when the agent's task demands a specific capability:

```json
{
  "model": "claude-sonnet-4-6"
}
```

### When to Override

- **Distillation pattern**: The expert role should use a larger model (e.g.,
  `claude-opus-4`) while the learner uses a smaller, faster model. This is
  the pattern's whole point -- the expert reasons, the learner executes.
- **Cost-sensitive specialists**: In a Mixture team, specialists doing simple
  lookups can use a smaller model while the synthesizer uses a larger one.
- **Reasoning-heavy tasks**: An agent doing multi-step logical reasoning
  benefits from a larger model even if the rest of the team does not need it.

### Model in Team Refs

When building a team, the `AgentRef` also supports a `model` field that
overrides the agent's own model for that specific team context. This lets
you reuse the same agent definition at different model tiers:

```json
{
  "ref": "web-platform-specialist",
  "name": "web-platform-specialist",
  "role": "specialist",
  "model": "claude-haiku-4"
}
```

---

## Token Limits

Three settings control how much context an agent uses:

### maxTokens (max_tokens)

Maximum tokens per response. Controls how long the model's output can be.

| Value | Use Case |
|-------|----------|
| `2048` | Short answers, status checks, approvals |
| `4096` | Standard analysis, code review findings, moderate code generation |
| `8192` | Detailed implementation, long-form writing, complex code generation (default) |
| `16384` | Very large code files, comprehensive documentation |

Higher values cost more and are slower. Most agents work well at 4096-8192.

### maxTurns (max_turns)

Maximum conversation turn pairs to keep in context. Oldest turns are dropped
when this limit is exceeded. Default: `30`.

Lower this for agents with large per-turn outputs (code generators) to avoid
hitting context limits. Raise it for agents that need long conversation
history (iterative refinement in Deliberation).

### maxContextTokens (max_context_tokens)

Maximum estimated input tokens. Oldest turns are dropped when the estimated
context size exceeds this limit (estimated at ~4 chars per token). Default:
`32000`.

This is the hard ceiling on context window usage. Set it based on the model's
actual context window minus the space needed for the system prompt and tool
definitions.

---

## Reasoning Mode

Set `"reasoning": true` to enable extended thinking / chain-of-thought mode.
The model takes longer but produces more thorough analysis.

### When to Enable

- Complex architectural decisions where the agent needs to weigh trade-offs.
- Security analysis where the agent must consider attack vectors systematically.
- Code review where subtle bugs require step-by-step reasoning.
- Any task where getting the right answer matters more than response speed.

### When to Skip

- Simple lookups, file reads, and mechanical transformations.
- Agents using small models -- reasoning mode has less impact on smaller models
  and increases latency disproportionately.
- High-throughput tasks where many agents run in parallel and speed matters.

From the examples: `web-platform-specialist`, `dashboard-designer`, and
`rh-brand-specialist` all enable reasoning because they make complex design
decisions. `deno-pro` disables it because its tasks are more mechanical.

---

## Visibility

The `visibility` field controls who can see and use the agent definition.

| Value | Meaning |
|-------|---------|
| `private` | Only the owner can see and use this agent. Default. |
| `shared` | Anyone in the same Porter instance can see and use this agent. |
| `linked` | The agent is published at a stable URI (typically on a Solid Pod) and can be imported by other Porter instances. |

Visibility applies to the agent definition, not to the agent's runtime
behavior. A `private` agent in a team still communicates with other agents
in that team -- `private` means other users cannot browse or import the
agent definition.

### Setting Visibility

In the JSON-LD definition, set the `visibility` field:

```json
{
  "visibility": "shared"
}
```

When stored on a Solid Pod, visibility maps to WAC (Web Access Control) ACLs:

- `private` -- no public ACL; only the Pod owner can read the resource.
- `shared` / `linked` -- `setResourcePublic()` writes a WAC ACL granting
  `acl:Read` to `foaf:Agent` (any user), while the owner retains full
  control.

---

## Importing Agents

Porter supports three ways to bring an agent into your library.

### From a URL (Link or Copy)

If someone has published an agent at a URL (on a Solid Pod, a web server, or
any HTTP endpoint serving JSON-LD or Turtle), you can import it in two modes:

**Link** -- the agent references the original URI via the `linkedFrom`
property. When the source is updated, your linked copy reflects those changes
on the next fetch.

```json
{
  "@context": "https://porter.chapeaux.io/agents/context.jsonld",
  "@id": "porter:default/agents/my-linked-agent",
  "@type": "Agent",
  "name": "web-platform-specialist",
  "linkedFrom": "https://pod.example.com/porter/agents/web-platform-specialist.ttl",
  "expertise": "",
  "tools": []
}
```

The empty `expertise` and `tools` are filled from the linked source at
resolution time.

**Copy** -- the agent is a snapshot via the `derivedFrom` property. The
original URI is recorded for provenance but the agent is fully independent.

```json
{
  "derivedFrom": "https://pod.example.com/porter/agents/web-platform-specialist.ttl"
}
```

### From a File

Agent JSON-LD files (`.jsonld`) can be loaded directly. The Team Builder UI
has an "Upload Agent" button that accepts `.jsonld` files. The CLI's
`porter add-agent` command can also reference a local file path.

### From a Solid Pod

When you authenticate with a Solid Pod (via Solid OIDC), Porter discovers
agents stored at `{podRoot}/porter/agents/{name}.ttl`. Each agent is an
individual Turtle file, enabling fine-grained access control -- you can make
specific agents public while keeping others private.

The Pod sync mechanism reads each `.ttl` file, parses it from Turtle to the
internal agent format, and adds it to your local agent library. Changes sync
bidirectionally: local edits are written back to the Pod as Turtle.

---

## Sharing Agents

### Pod ACL

Each agent stored on a Solid Pod is an individual resource with its own ACL.
To share an agent publicly:

1. Store the agent on your Pod (automatic if Pod sync is configured).
2. Call `setResourcePublic(authFetch, resourceUrl)` or use the share toggle
   in the agent card UI.
3. The agent is now readable at its Pod URL by anyone. Other Porter users
   can import it by URL.

To revoke sharing, call `setResourcePrivate(authFetch, resourceUrl)` or
toggle sharing off. This deletes the public ACL.

### Public URI

When an agent is public on a Pod, its URL is a stable, dereferenceable
linked data resource. You can share the URL directly:

```
https://pod.example.com/porter/agents/web-platform-specialist.ttl
```

Anyone with a Porter instance can import this URL as a linked or copied agent.
The resource serves `text/turtle` and can also be consumed by any linked data
client.

---

## Reference-Based Teams

Teams in Porter do not embed full agent definitions. Instead, they reference
agents by name or URI using `AgentRef` objects. Agent definitions are resolved
at session launch time.

### Team JSON-LD Format

```json
{
  "@context": "https://porter.chapeaux.io/teams/context.jsonld",
  "@id": "porter:default/teams/my-team",
  "@type": "Team",
  "name": "my-team",
  "pattern": "porter:pattern/mixture",
  "agents": [
    {
      "@type": "AgentRef",
      "ref": "web-platform-specialist",
      "name": "web-platform-specialist",
      "role": "specialist"
    },
    {
      "@type": "AgentRef",
      "ref": "dashboard-designer",
      "name": "dashboard-designer",
      "role": "specialist"
    },
    {
      "@type": "AgentRef",
      "ref": "deno-pro",
      "name": "deno-pro",
      "role": "synthesizer",
      "model": "claude-sonnet-4-6"
    }
  ]
}
```

### AgentRef Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ref` | string | yes | Agent name (for local library lookup) or URI (for remote/Pod agents). |
| `name` | string | yes | Display name. Defaults to the ref value if not set. |
| `role` | AgentRole | yes | Role assigned by the team's pattern. |
| `model` | string | no | Model override for this team context. Overrides the agent's own model. |

### Resolution at Launch

When a session starts, Porter resolves each `AgentRef`:

1. **Local lookup** -- if `ref` is a simple name (no `/` or `://`), Porter
   looks it up in the local agent library.
2. **URI fetch** -- if `ref` is a URL, Porter fetches the agent definition
   from that URL (JSON-LD or Turtle).
3. **Missing refs** -- if a ref cannot be resolved, it is flagged with
   `_missing: true` and the session reports an error.

Resolution is lazy -- it happens at launch, not at team save time. This means
linked agents always reflect their latest version.

### Benefits

- **Reuse** -- the same agent appears in multiple teams without duplication.
- **Live updates** -- a linked agent updated on its source Pod is immediately
  available to all teams that reference it.
- **Role flexibility** -- the same agent can serve different roles in
  different teams. A `security-analyst` can be a specialist in one team and a
  reflector in another.
- **Model flexibility** -- the team ref can override the agent's model, so
  the same agent definition can run on different model tiers in different
  teams.

---

## Complete Example: Brand Review Specialist

Putting it all together, here is a well-structured agent definition:

```json
{
  "@context": "https://porter.chapeaux.io/agents/context.jsonld",
  "@id": "porter:default/agents/brand-reviewer",
  "@type": "Agent",
  "name": "brand-reviewer",
  "expertise": "Brand compliance reviewer for web content. Checks HTML, CSS, and copy against the Red Hat brand standards.\n\nCore checks:\n- Logo usage: correct version (A/B/C), clear space, no recoloring, no distortion.\n- Color palette: only approved colors from the Red Hat palette. Red Hat red (#EE0000) for intentional pops, not flooding. Max 1-2 secondary colors per composition.\n- Typography: Red Hat Display for headings, Red Hat Text for body, Red Hat Mono for code. No manual letter-spacing adjustments.\n- Voice: clear, direct, jargon-free. 'open source' lowercase, 'Red Hat' two words, 'Linux' capital L.\n- Accessibility: 4.5:1 contrast for text, 3:1 for large text and UI components. Never color alone for meaning.\n\nOutput format:\n- List each violation with file path, line number, standard reference URL, and suggested fix.\n- Group violations by severity: blocking (logo/trademark), warning (color/typography), advisory (voice/tone).\n\nAnti-patterns:\n- Never approve red text on dark backgrounds without checking contrast ratio.\n- Never allow 'Redhat', 'RedHat', or 'redhat' in any context.\n- Never skip accessibility checks -- they are brand requirements, not optional extras.",
  "tools": [
    "read_file",
    "glob",
    "grep",
    "list_dir"
  ],
  "model": "",
  "reasoning": true,
  "maxTokens": 8192,
  "visibility": "shared"
}
```

This agent:
- Has a clear opening sentence defining its scope.
- Lists concrete checks with specific values (color codes, font names, contrast ratios).
- Specifies an output format so findings are structured and actionable.
- Includes anti-patterns to prevent common mistakes.
- Uses only read-only tools -- it reviews, it does not modify.
- Enables reasoning for thorough analysis.
- Is shared so other users on the same instance can use it.
