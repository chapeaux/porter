# Porter Tool System

Porter exposes individual tools directly to LLM agents, filtered by role.
Each agent sees only the tools its role permits. AS2 (ActivityStreams 2.0)
is used internally as the bus wire format but is fully transparent to agents
-- they send and receive plain text messages.

## History

Porter previously used a 4-tool gateway pattern (`execute`, `file`,
`message`, `memory`) that collapsed 12+ individual tools behind 4
aggregated gateway tools with sub-action discriminators. This was dissolved
in favor of exposing individual tools directly, which works better with
smaller models and avoids the cognitive overhead of sub-action routing.

## Individual Tools

### bash

Run a shell command. Full shell access with `git`, `deno`, `node`, and
standard unix tools. Environment variables like `$GITLAB_TOKEN` are
available.

```
bash({command: "ls -la src/"})
bash({command: "deno test --allow-all"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `command` | yes | Shell command to run |

### read_file

Read the contents of a file.

```
read_file({path: "src/app.ts"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `path` | yes | File path (relative to working directory or absolute) |

### write_file

Create or overwrite a file.

```
write_file({path: "src/hello.ts", content: "export const hi = 'world';"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `path` | yes | File path |
| `content` | yes | File content |

### edit_file

Apply a find-and-replace edit to a file.

```
edit_file({path: "src/app.ts", old_string: "old text", new_string: "new text"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `path` | yes | File path |
| `old_string` | yes | Text to find |
| `new_string` | yes | Replacement text |

### glob

Find files matching a glob pattern.

```
glob({pattern: "src/**/*.ts"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `pattern` | yes | Glob pattern |
| `path` | no | Base directory (defaults to working directory) |

### grep

Search file contents for a pattern.

```
grep({pattern: "TODO", path: "src/"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `pattern` | yes | Search pattern |
| `path` | no | Directory to search (defaults to working directory) |

### list_dir

List files and directories.

```
list_dir({path: "src/"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `path` | no | Directory path (defaults to working directory) |

### git

Run a git command.

```
git({command: "status"})
git({command: "diff HEAD~1"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `command` | yes | Git subcommand and arguments |

### send_message

Send a message to another agent or channel on the bus.

```
send_message({channel: "task:worker-1", message: "Implement the login form"})
send_message({channel: "log", message: "All tasks assigned"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `channel` | yes | Channel: `log`, `task`, `review`, `control`, or `task:<agent-name>` |
| `message` | yes | Message text |

### read_messages

Check for incoming messages from subscribed channels.

```
read_messages({})
read_messages({channel: "task"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `channel` | no | Filter to a specific channel |

### memory

Save or semantically search team memory. Replaces the older `memory_write`/
`memory_query`/`semantic_search` tools with a single minimal interface —
deliberately small so weaker models don't have to first decide *which* tool
to use before even getting to parameters.

```
memory({method: "save", type: "semantic", text: "Using Deno + Oak for the API"})
memory({method: "search", text: "what API framework are we using"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `method` | yes | `"save"` to record a memory, `"search"` to recall relevant ones |
| `type` | yes | `"semantic"` (stable fact), `"episodic"` (something that happened), or `"procedural"` (a reusable lesson). Required for save; an optional filter for search |
| `text` | yes | For save: the memory to record. For search: what you're looking for |
| `scope` | no | `"local"` (this session only, default for save), `"durable"` (shared across sessions), or `"both"` (default for search) |
| `limit` | no | Max results for search (default 5) |

`search` is semantic (vector similarity via Qdrant), not SPARQL — there's no
raw query mode on this tool. `about` is not a model-facing field; it's
derived server-side from `text` so agents don't have to think about it.

### memory_admin

Librarian-only (see the optional `librarian` role, addable to any pattern).
Promotes local memories to durable, cross-session memory, adjudicates
conflicts there, and edits/deletes durable entries directly. Kept as a
separate tool from `memory` so the common path every other agent uses stays
minimal — only the librarian needs this extra surface.

```
memory_admin({method: "promote", id: "<local-memory-id>"})
memory_admin({method: "adjudicate", id: "<local-memory-id>", resolution: "supersede", supersedes_id: "<durable-id>"})
memory_admin({method: "edit", id: "<durable-id>", text: "corrected text"})
memory_admin({method: "delete", id: "<durable-id>"})
```

| Param | Required | Description |
|-------|----------|-------------|
| `method` | yes | `"promote"`, `"adjudicate"`, `"edit"`, or `"delete"` |
| `id` | yes | Local memory id for promote/adjudicate; durable entry id for edit/delete |
| `resolution` | for adjudicate | `"supersede"`, `"merge"`, or `"reject"` |
| `supersedes_id` | for adjudicate supersede/merge | The existing durable entry being resolved against |
| `text` | for edit, optional for merge | New/merged content |

Only `semantic`-typed promotions are checked for conflicts (episodic and
procedural entries are additive by nature). Durable memory is keyed by team
identity — `config.session` as originally saved via `/api/teams`, not the
per-launch uniquified session name — and persisted to
`~/.porter/durable-memory/{team}.ttl`, so it survives session restarts and is
visible to any future session launched from the same team. It is not yet
synced to the user's Solid Pod the way models/agents/teams are — see
`docs/vector-store.md` and the durable-memory design notes for the open
follow-up.

## Role-Based Access

The `applyRoleFilter()` function in `src/runtime/agent.ts` restricts tool
access based on the agent's role:

| Role | Available Tools | Rationale |
|------|-----------------|-----------|
| `admin` | `send_message`, `read_messages`, `memory` | Admins plan and delegate; they do not execute directly |
| `worker` | all 12 tools | Workers have full capabilities |
| `reviewer` | all 12 tools | Reviewers can read code and run tests |

When an agent attempts to use a tool outside its role, the error includes
the names of other agents that have the required capability:

```
You (admin-1) cannot use 'bash'. Your available tools are: send_message, read_messages, memory.
To use 'bash', delegate to: worker-1, worker-2.
Example: send_message({channel: "task:worker-1", message: "Please run: ..."})
```

This teaches the agent to delegate rather than retry the forbidden tool.

## AS2 as Transparent Wire Format

AS2 (ActivityStreams 2.0) is used as the internal wire format on the
message bus. It is managed entirely by the `send_message` and
`read_messages` tool handlers in `executeTool()`:

- **send_message** wraps plain text messages in an AS2 envelope before
  publishing to the bus. Messages to `task:*` channels get type `Offer`;
  other channels get type `Announce`.
- **read_messages** unwraps AS2 JSON back to plain `actor: summary`
  format before returning to the agent. Non-JSON messages fall through
  as raw text.

Agents never see or construct AS2 JSON. They send and receive plain text.

## Error Enhancement

When a tool call produces a "not found" or "No such file or directory"
error, the `executeTool()` function automatically stores the error in the
shared memory graph via the `memory` tool (as an `episodic` entry). Other
agents can search memory to discover known failures before attempting
similar operations.

## Path Resolution

The `executeTool()` function resolves relative file paths against the
session working directory:

- `bash` and `git` commands receive the working directory as `cwd`
- `glob`, `grep`, and `list_dir` receive it as the base `path`
- `write_file`, `edit_file`, and `read_file` have relative paths prefixed
  with the working directory; absolute paths are passed through unchanged

## Sandbox Isolation

When sandbox mode is enabled (`sandbox: true` in config or `--sandbox` CLI
flag), tools are restricted to the workspace directory:

### Container auto-detection

When Porter is already running inside a container (e.g., an OpenShift pod
provisioned by `porter router`), the container sandbox is automatically
skipped -- the pod itself provides isolation. Path validation for
Deno-native tools still applies in all environments.

### Path validation (Deno-native tools)

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, and `list_dir` all
validate paths via `validatePath()` from `src/sandbox/paths.ts`. The
validator resolves symlinks, normalizes traversals, and confirms the final
path is within the workspace. Attempts to access paths outside the workspace
return a `PathEscapeError`.

### Container sandbox (subprocess tools)

`bash` and `git` commands run inside a podman/docker container with only the
workspace directory bind-mounted at `/workspace`. The host filesystem,
`~/.ssh`, `~/.gnupg`, and host environment variables are not accessible
inside the container. Only explicitly configured session env vars (e.g.,
`GITLAB_TOKEN`) are passed through.

## Model chat_endpoint

The `chat_endpoint` field on a model configuration overrides the default API
path used for chat completions. This is useful for providers that use
non-standard paths:

- **Vertex AI**: `/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:streamRawPredict`
- **Custom gateways**: any path that the gateway expects

The `chat_endpoint` is passed to the provider constructor and used as the
request path instead of the default `/v1/messages` (Anthropic) or
`/v1/chat/completions` (OpenAI-compatible).

### Team roster in memory

At session startup, the orchestrator seeds the shared knowledge graph with
observations about each team member (`team:<name>` with role and tools) and
a `team:porter-ui` entry identifying the human dashboard user. Agents can
recall this via `memory({method: "search", text: "team roster"})`.
