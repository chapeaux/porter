# Porter

<p align="center">
  <img src="src/ui/porter.svg" alt="Porter" width="120">
</p>

A pure-Deno multi-agent orchestration platform. Porter runs agents as V8-isolated workers with crash containment, coordinates them through an in-process message bus, and exposes a browser-based dashboard for real-time monitoring and team management.

Named in honor of the historic United States railroad Pullman Porters, who coordinated the seamless operation of passenger rail cars.

## Quick Start

```bash
# Install (requires Deno 2+)
git clone https://github.com/chapeaux/porter.git
cd porter
deno install --global --allow-all --name porter cli.ts

# Set your API credentials
export ANTHROPIC_API_KEY=sk-ant-...

# Start the platform
porter serve

# Open the dashboard
open http://localhost:3000
```

The web dashboard opens with a Team Builder wizard. Create agents, configure models, and launch sessions from the browser -- no config file required.

To use a config file instead:

```bash
porter start --config examples/solo-dev.json
porter start --ui                             # with web dashboard
```

See [`examples/`](examples/) for ready-to-use configs: `solo-dev.json`, `full-team.json`, `multi-model.json`.

### Three Deployment Modes

| Mode | Command | Description |
|------|---------|-------------|
| **Local single session** | `porter start --config porter.json` | tmux-based, single team. Agents run in tmux panes for direct terminal observation. |
| **Local platform** | `porter serve` | Web dashboard at `http://localhost:3000`. Multiple concurrent sessions, no tmux required. |
| **Cloud pod-per-user** | `porter router` | Multi-tenant on OpenShift. Each SSO user gets an isolated orchestrator pod. See [Deployment](#deployment). |

---

## CLI Reference

```
porter init          Create a porter.json via interactive wizard
porter add-agent     Add a new agent to an existing porter.json
porter start         Launch a session from config file
porter serve         Start Porter Platform (serve mode -- dynamic sessions)
porter send          Send a message to agents in a running session
porter stop          Stop the active session (auto-snapshots)
porter status        Show agent panes and health
porter sessions      List all running sessions
porter snapshot      Save or restore session state
porter ui            Launch the web dashboard (standalone)
porter login         Authenticate with a remote OpenShift cluster
porter router        Start the multi-user router (pod-per-user mode)
porter deploy        Deploy agent worker pods to OpenShift
porter teardown      Remove all porter pods and secrets from cluster
```

### Common Flags

```
--config <path>     Config file path (default: porter.json)
--prompt <text>     Initial prompt for all agents
--log <path>        Log file path
--bus-port <port>   WebSocket bus port (default: 8787)
--port <port>       Web UI server port (default: 3000)
--headless          Disable tmux display (for containers)
--ui                Start web dashboard alongside session
--no-isolates       Disable V8 isolates (run agents in same thread)
--sandbox           Enable container sandbox for workspace isolation
--single-user       Run in single-user mode (no OIDC, used by user pods)
```

---

## Web Dashboard

The dashboard provides real-time monitoring and full lifecycle management for agent sessions.

### Header

A gear button toggles the **flipboard config panel** -- a row of split-flap cells showing live counts for models, MCP servers, agents, teams, and session status. Click any cell to open its management dialog.

### Main Area

- **Agent deck** -- cards per agent showing role, message count, and last activity
- **Message feed** -- real-time bus timeline, filterable by channel, with persistent history across session switches
- **Dispatch** -- send messages to channels from the browser (Ctrl+Enter)

### Session Management

In `porter serve` mode, the session dropdown shows all running sessions:

- **Switch** -- click to reconnect the WebSocket (message history is restored)
- **+ New Session** -- launch from a saved team or build a new one
- **Stop / Delete** -- graceful shutdown with snapshot

### Team Builder

A 3-step wizard for creating agent teams without editing JSON:

1. **Session** -- name, working directory, default model, MCP servers, git repo
2. **Agents** -- add/edit/remove agents with role-based defaults; drag-drop import from `porter.json`
3. **Review** -- JSON preview with copy/download/save

Click **Save & Launch** to start immediately.

### Agent Library

Agents are saved independently of teams. When creating a new team, browse the agent library to reuse agents across teams. Agents include their full configuration: role, system prompt sections, tools, channels, and MCP tool bindings.

- **Multi-select** -- checkboxes on each agent card for batch operations
- **Build Team** -- select agents and click "Build Team" to create a new team from the selection
- **Add Selected** -- when the agent picker is open inside the Team Builder, select multiple agents and click "Add Selected" to batch-add them to the current team

### Agent Restart

Each agent card in the dashboard has a restart button (circular arrow icon). Clicking it terminates the agent's V8 isolate and relaunches it with a fresh conversation. The restart is also available via the REST API:

```
POST /api/sessions/{name}/agents/{agent}/restart
```

### Metrics Footer

A persistent footer bar shows live session metrics: input/output tokens, API calls, errors, and rate limit hits. Click the detail button for a per-agent breakdown table.

---

## Authentication

Porter supports three login methods, selectable in the dashboard header:

### Login Chooser (Router Mode)

In `porter router` mode, unauthenticated users see a login chooser page with two options:

- **Sign in with SSO** -- redirects to the configured OIDC provider (Keycloak, Auth0, Okta)
- **Solid / LWS login** -- enter a Solid identity provider URL for decentralized login

The chooser page is served from `src/ui/auth-choose.html`.

### Email

Simple identity via localStorage. No server configuration needed. Suitable for local development.

### SSO / OIDC

Server-side authentication via any OpenID Connect provider (Keycloak, Auth0, Okta). Provides per-user credential storage, team persistence, and session data keyed to SSO identity.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORTER_OIDC_ISSUER_URL` | yes | OIDC issuer URL |
| `PORTER_OIDC_CLIENT_ID` | yes | OIDC client ID |
| `PORTER_OIDC_CLIENT_SECRET` | no | Client secret (confidential clients) |
| `PORTER_OIDC_REDIRECT_URI` | no | Callback URL (default: `http://localhost:3000/auth/callback`) |
| `PORTER_SESSION_KEY` | no | 64 hex chars for session cookie encryption |

Logout (`GET /auth/logout`) revokes the Keycloak refresh token via the OIDC revocation endpoint before redirecting to the provider's end-session URL. This ensures proper SSO logout rather than only clearing the local session cookie.

### Solid Pod

Client-side Solid OIDC with DPoP-bound tokens. Uses the WebID as identity and syncs configuration to the user's Pod. See [Solid Pod Sync](#solid-pod-sync) for details.

---

## Agent Tool System

Porter exposes individual, purpose-specific tools to each agent. Each tool has a flat input schema with no sub-action discriminators, following the standard tool_use pattern.

### Tools

| Tool | Purpose |
|------|---------|
| `bash` | Run shell commands (git, deno, node, unix tools) |
| `read_file` | Read a file with line numbers |
| `write_file` | Create or overwrite a file |
| `edit_file` | Exact string replacement in a file |
| `glob` | Find files by pattern |
| `grep` | Search file contents by regex |
| `list_dir` | List directory contents |
| `git` | Run git commands |
| `send_message` | Send a message to a channel or agent |
| `read_messages` | Read pending messages from the bus |
| `memory_write` | Store a finding in the knowledge graph |
| `memory_query` | Query the knowledge graph with SPARQL |

### Examples

```json
bash({command: "git clone https://oauth2:$GITLAB_TOKEN@example.com/repo.git"})

read_file({path: "src/app.js"})
write_file({path: "src/hello.ts", content: "export const hi = 'world';"})
edit_file({path: "src/app.js", old_string: "old text", new_string: "new text"})

send_message({channel: "task:worker-1", message: "Implement the login form"})
read_messages()
send_message({channel: "log", message: "All tasks complete"})

memory_write({about: "architecture", finding: "Using Deno + Oak for the API"})
memory_query({sparql: "SELECT ?about ?finding WHERE { ... }"})
```

### Role-Based Access

| Role | Tools Available |
|------|----------------|
| `admin` | `send_message`, `read_messages`, `memory_write`, `memory_query` |
| `worker` | All tools |
| `reviewer` | All tools |

Admins cannot run commands or modify files directly. They delegate work to workers via `send_message` to the worker's task channel. When an agent tries to use a tool outside its role, the error message names other agents that have the needed capability.

### Smart Error Handling

When a tool call fails (e.g., command not found, file missing), the error is automatically stored in the shared memory graph so other agents can learn from failures.

### AS2 Wire Format

Inter-agent messages use ActivityStreams 2.0 as the bus wire format. This is handled transparently by the `send_message` and `read_messages` tool handlers — agents send and receive plain text and never interact with AS2 directly.

See [`docs/tool-gateway.md`](docs/tool-gateway.md) for the full specification.

---

## Sandbox Isolation

Porter can run agent commands inside a container sandbox, preventing access to
the host filesystem outside the workspace directory.

### Enable

Add `sandbox: true` to your config, or use the `--sandbox` CLI flag:

```bash
porter start --sandbox --config my-project.json
```

Or in config:

```json
{
  "session": "my-project",
  "sandbox": true,
  "agents": [...]
}
```

### What's isolated

- **bash/git commands** run inside a container with only the workspace
  directory mounted at `/workspace`. No access to `~/.ssh`, `~/.gnupg`,
  host PATH, or any host files.
- **File operations** (read_file, write_file, edit_file, glob, grep,
  list_dir) are validated to stay within the workspace directory. Absolute
  paths, symlink escapes, and `../` traversals are rejected.
- **Network access** is allowed by default.

### Container auto-detection

When Porter is already running inside a container (e.g., an OpenShift pod provisioned by `porter router`), the container sandbox is automatically skipped -- the pod itself is the sandbox. Path validation for Deno-native tools still applies.

### Requirements

Requires `podman` (preferred) or `docker` on the host. Podman is
recommended for rootless operation on Fedora/RHEL.

### Advanced configuration

```json
{
  "sandbox": {
    "enabled": true,
    "image": "registry.access.redhat.com/ubi9/ubi:latest",
    "runtime": "podman"
  }
}
```

---

## Agent Message Protocol

Agents communicate using a compact profile of [ActivityStreams 2.0](https://www.w3.org/TR/activitystreams-core/). Messages are JSON objects with typed activities:

| Type | Meaning | Sent by |
|------|---------|---------|
| `Offer` | Assign a task | admin |
| `Accept` | Acknowledge a task | worker |
| `Reject` | Decline a task | worker |
| `Create` | Produce an artifact | worker |
| `Update` | Modify an artifact | worker |
| `Invoke` | Execute a command | worker |
| `Question` | Ask for clarification | any |
| `Announce` | Broadcast status | any |
| `Remember` | Store knowledge | any |
| `Recall` | Query knowledge | any |

AS2 is handled transparently by the `send_message` and `read_messages` tool handlers — agents send and receive plain text and never interact with AS2 directly. The UI renders AS2 messages with typed badges, file reference chips, and task context threading.

See [`docs/as2-agent-protocol.md`](docs/as2-agent-protocol.md) for the full specification.

---

## Agent Library

Agents are first-class entities that exist independently of teams. The dashboard stores agent definitions via the `/api/agents` endpoint and renders them as reusable cards in the Team Builder.

Each saved agent includes:
- Name, role, and model override
- System prompt organized into sections (Job Description, Communication, Memory, Processing)
- Tool list and channel subscriptions
- MCP tool bindings
- Context tags for environment compatibility

The library supports multi-select with checkboxes on each agent card:

- **Build Team** -- select agents and click "Build Team" to create a new team from the selection
- **Add Selected** -- when the agent picker is open inside the Team Builder, use checkboxes to batch-add agents to the current team
- **Add from Library** -- browse saved agents and add them individually

---

## Model Configuration

Models are configured in the `models` array of `porter.json`. Each entry specifies a provider, endpoint, and authentication method.

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-6",
      "display_name": "Claude Sonnet 4.6",
      "provider_type": "anthropic",
      "base_url": "https://api.anthropic.com",
      "api_key_env": "ANTHROPIC_API_KEY",
      "auth": "bearer",
      "context_window": 200000,
      "max_tokens": 8192,
      "capabilities": { "tool_calling": true, "reasoning": true, "vision": true, "json_mode": true }
    }
  ]
}
```

### Provider Types

| Type | Use | Auth |
|------|-----|------|
| `anthropic` | Anthropic API | `x-api-key` header (default) or Bearer token |
| `vertex` | Google Cloud Vertex AI | Application Default Credentials |
| `openai_compat` | vLLM, Ollama, etc. | Bearer token via `api_key_env` |

### Authentication Methods

The `auth` field controls how API credentials are sent:

| Value | Header | Use case |
|-------|--------|----------|
| `x-api-key` | `x-api-key: <key>` | Standard Anthropic API (default for `anthropic` provider) |
| `bearer` | `Authorization: Bearer <key>` | API gateways, proxies, and OpenAI-compatible endpoints |
| `adc` | Google ADC | Vertex AI (automatic via `gcloud` CLI) |

The `api_key` field accepts a raw API key string directly. Alternatively, `api_key_env` names an environment variable to read the key from.

### Custom API Paths

The `chat_endpoint` field overrides the default chat completions path. This is useful for Vertex AI-style endpoints or custom API gateways:

```json
{
  "provider_type": "vertex",
  "base_url": "https://us-east5-aiplatform.googleapis.com",
  "chat_endpoint": "/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict",
  "auth": "adc"
}
```

### Vertex AI Setup

```bash
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID=my-gcp-project-id
export CLOUD_ML_REGION=us-east5
gcloud auth application-default login
```

Models are managed in the dashboard via the **MODELS** flipboard cell, which opens a dialog for adding, editing, and testing model configurations. Credentials are stored per-user with AES-256-GCM encryption.

---

## MCP Integration

Porter connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and wraps their tools as Porter tool entries available to agents.

### Configuration

Add MCP servers to `porter.json` or configure them in the dashboard via the **MCP** flipboard cell:

```json
{
  "mcp_servers": {
    "my-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "remote-server": {
      "transport": "http",
      "url": "https://mcp.example.com/sse",
      "auth": {
        "type": "oidc",
        "issuer_url": "https://auth.example.com/realms/myorg"
      }
    }
  }
}
```

### Transports

- **stdio** -- spawns a subprocess, communicates via stdin/stdout JSON-RPC
- **http** -- Streamable HTTP transport with optional OIDC authentication

When `auth.type` is `"oidc"`, Porter injects the user's access token from the current OIDC session into the MCP request headers.

### Agent Access

Add MCP tool names to an agent's `mcp_tools` array to grant access:

```json
{
  "name": "researcher",
  "role": "worker",
  "mcp_tools": ["my-server:search", "my-server:read"]
}
```

### Tool Naming

MCP tool names use `__` (double underscore) as the separator between server name and tool name in the API (e.g., `my-server__search`). Dots are not allowed in Anthropic tool names, so Porter uses the double-underscore convention. In the `mcp_tools` config array you can use colon notation (`my-server:search`) for readability -- Porter maps both forms internally.

### Runtime Tools

Porter can inject runtime tools (Python, Node.js, curl, wget, jq) into agent pods and sandbox containers. In the Team Builder UI, checkboxes for each tool appear in the session configuration step. In config:

```json
{
  "runtime_tools": ["python3", "nodejs", "curl", "wget", "jq"]
}
```

See [`docs/tools.md`](docs/tools.md) for details on how tools are injected via init containers.

---

## Linked Web Storage (LWS) / Solid Pod Sync

Porter stores user configuration on Linked Web Storage so data persists across pod restarts and is portable across deployments.

### SSO Users

When `PORTER_LWS_BASE_URL` is configured, SSO-authenticated users automatically get Pod storage at `{LWS_BASE_URL}/{userId}/`. Configuration is synced to the Pod on every save — teams, agents, models, MCP servers, and credentials all persist even when the user's orchestrator pod is deprovisioned.

```bash
# Set in the router deployment or as an env var
PORTER_LWS_BASE_URL=https://lws.example.com/pods
```

The `/auth/me` endpoint returns the user's `pod_url`, and the browser initializes Pod sync automatically after SSO login.

### Token Exchange Flow

SSO users access LWS Pods through a server-side token exchange:

1. **SSO login** -- user authenticates with Keycloak (or other OIDC provider)
2. **Token exchange at login time** -- the server exchanges the Keycloak ID token for a Tudor/LWS access token using the `urn:ietf:params:oauth:grant-type:token-exchange` grant type
3. **Server-side storage** -- the LWS token is stored in the server-side session (not in the cookie, which has a 4 KB limit)
4. **Browser access** -- the browser calls `POST /auth/lws-token` to retrieve the LWS access token for Pod operations
5. **Pod writes** -- `POST` for container/resource creation; `PUT` with `If-Match` (ETag) for updates to prevent conflicts

### Solid / LWS Users

When logged in via a Solid identity provider directly, Porter discovers the Pod URL from the user's WebID profile and syncs identically.

### What's Synced

- `{pod}/porter/config.json` -- models, teams, MCP servers, agents as JSON
- `{pod}/porter/config.ttl` -- same config as Turtle/RDF for Linked Data interop
- Real-time sync via Solid Notifications (SSE) -- changes on the Pod are reflected in Porter automatically

This makes configuration portable across Porter instances: log in with the same identity on a different deployment and your models, teams, and credentials follow.

---

## Context Management

Porter provides controls to limit input token usage, which is important for pay-per-token endpoints like vLLM on Vultr or RHOAI.

### History Trimming

Set `max_turns` or `max_context_tokens` on any agent to automatically drop oldest conversation turns:

```json
{
  "name": "worker-1",
  "role": "worker",
  "max_turns": 30,
  "max_context_tokens": 24000
}
```

| Use Case | Max Turns | Max Context Tokens | Notes |
|---|---|---|---|
| Quick tasks (lint, format) | 10 | 16,000 | Low cost, short memory |
| Standard development | 30 | 64,000 | Good balance |
| Deep analysis / research | 100 | 128,000 | Higher cost, long memory |
| Large context models (Claude, Gemini) | — | — | Default: unlimited |

Rule of thumb: set `max_context_tokens` to ~75% of the model's context window.

### Tool Result Truncation

Tool results exceeding 20,000 characters are automatically truncated to prevent a single large file read or command output from consuming the entire context window.

---

## Shared Memory Persistence

Agent observations written via `memory_write` are persisted across session restarts. When a session stops, the memory graph is serialized as Turtle into the session snapshot. On restart, it is restored automatically.

For SSO and Solid users, the memory graph is also synced to the user's LWS/Solid Pod at `{pod}/porter/memory/{session}.ttl`, enabling persistence across pod restarts and device portability.

### API

```
GET /api/sessions/<name>/memory     # Export as text/turtle
POST /api/sessions/<name>/memory    # Import text/turtle into running session
```

---

## Progressive Web App

Porter is a PWA — installable, offline-capable, and optimized for background operation.

- **Installable** — browser shows an install prompt; works as a standalone app on desktop and mobile
- **Offline shell** — cached app shell loads even without network, reconnects when back online
- **Background polling** — metrics and session list polling run in the service worker, keeping the main thread responsive
- **Cache-first assets** — static assets (JS, CSS, SVG) are served from cache with background updates (stale-while-revalidate)
- **Network-first API** — API calls hit the server with cache fallback for offline reads

---

## Metrics and Observability

Porter collects per-session operational metrics automatically.

### Per-Agent Metrics

- Token usage (input/output)
- API calls and tool calls
- Errors and retries
- First/last event timestamps

### Per-Session Metrics

- Total messages and messages by channel
- Rate limit hits

### API Access

```
GET /api/sessions/<name>/metrics
```

Returns a JSON object with per-agent breakdowns and session-level counters.

### Message Persistence

All bus messages are persisted to JSONL files (`~/.porter/messages/<session>.jsonl`), enabling session switching without data loss and post-mortem analysis.

```
GET /api/sessions/<name>/messages?limit=500
```

---

## Configuration Reference

### `porter.json` Format

```json
{
  "session": "myproject",
  "model": "claude-sonnet-4-6",
  "api_key_env": "ANTHROPIC_API_KEY",
  "working_dir": ".",
  "isolates": true,
  "repo": "https://github.com/org/repo.git",
  "models": [],
  "mcp_servers": {},
  "env": {},
  "agents": []
}
```

### Session Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `session` | yes | | Session name |
| `model` | no | `claude-sonnet-4-6` | Default model for all agents |
| `api_key_env` | no | `ANTHROPIC_API_KEY` | Env var name for the API key |
| `working_dir` | no | derived | Working directory for file operations |
| `isolates` | no | `true` | Run agents as V8 Worker isolates |
| `repo` | no | | Git repository to clone |
| `bus_port` | no | auto | Bus WebSocket port |
| `heartbeat_timeout_ms` | no | `120000` | Agent liveness timeout (ms) |
| `provider` | no | auto-detect | `"anthropic"` or `"vertex"` |
| `vertex.project_id` | no | from env | GCP project ID |
| `vertex.region` | no | from env | GCP region |
| `models` | no | | Model configurations array |
| `mcp_servers` | no | | External MCP server definitions |
| `sandbox` | no | | Container sandbox (`true` or `{enabled, image?, runtime?}`) |
| `runtime_tools` | no | | Runtime tools to inject into pods (`["python3", "curl"]`) |
| `env` | no | | Environment variables for the session |
| `remote` | no | | OpenShift remote worker config |
| `agents` | yes | | Array of agent definitions |

#### Model Entry Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | yes | | Model identifier (e.g., `claude-sonnet-4-6`) |
| `display_name` | no | | Human-readable name |
| `provider_type` | yes | | `anthropic`, `vertex`, or `openai_compat` |
| `base_url` | yes | | Provider API base URL |
| `api_key_env` | no | | Env var name containing the API key |
| `api_key` | no | | Raw API key string (alternative to `api_key_env`) |
| `auth` | no | `x-api-key` | Auth method: `x-api-key`, `bearer`, or `adc` |
| `chat_endpoint` | no | | Custom API path (e.g., `/:streamRawPredict` for Vertex) |
| `context_window` | no | | Context window size in tokens |
| `max_tokens` | no | `8192` | Max output tokens per response |
| `capabilities` | no | | Object: `tool_calling`, `reasoning`, `vision`, `json_mode` |

### Agent Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | | Agent name (unique within session) |
| `role` | yes | | `"admin"`, `"worker"`, or `"reviewer"` |
| `system_prompt` | yes | | System prompt for the agent |
| `tools` | yes | | Tools this agent can use |
| `model` | no | session default | Override model for this agent |
| `subscribe` | no | `[]` | Bus channels to subscribe to |
| `max_tokens` | no | `8192` | Max tokens per response |
| `max_turns` | no | unlimited | Max conversation turn pairs to keep in context |
| `max_context_tokens` | no | unlimited | Estimated input token budget (~4 chars/token) |
| `reasoning` | no | `false` | Enable extended thinking |
| `mcp_tools` | no | `[]` | MCP tools this agent can access |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLAUDE_CODE_USE_VERTEX` | Set to `1` for Vertex AI |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP project ID |
| `CLOUD_ML_REGION` | GCP region |
| `PORTER_OIDC_ISSUER_URL` | OIDC issuer URL |
| `PORTER_OIDC_CLIENT_ID` | OIDC client ID |
| `PORTER_OIDC_CLIENT_SECRET` | OIDC client secret |
| `PORTER_OIDC_REDIRECT_URI` | OIDC callback URL |
| `PORTER_SESSION_KEY` | Session cookie encryption key |
| `PORTER_LWS_BASE_URL` | LWS Pod storage base URL for SSO users |

---

## Deployment

### Local

```bash
porter serve                          # platform mode (recommended)
porter start --config porter.json     # single session with tmux
porter start --ui                     # single session with dashboard
```

### Cloud (OpenShift)

Porter runs as a container in serve mode. Sessions are created dynamically via the dashboard.

For multi-tenant deployments, use `porter router` (pod-per-user mode) where each SSO user gets an isolated orchestrator pod. The router handles OIDC authentication, pod provisioning, and reverse proxying. Unauthenticated users see a login chooser page with SSO and Solid/LWS options.

See [`docs/deployment-guide.md`](docs/deployment-guide.md) for the full guide covering secrets, manifests, OIDC, RBAC, NetworkPolicy, CA bundle configuration, LWS setup, router deployment, and troubleshooting.

### Hybrid Remote

Orchestrator runs locally; agent workers run as OpenShift pods:

```bash
porter start --config team.json       # local orchestrator
porter deploy                         # deploy worker pods
porter teardown                       # remove pods
```

---

## Development

```bash
deno task check                       # type-check all files
deno task test                        # run tests (231 tests)
deno task compile                     # build standalone binary (./porter)
deno run --allow-all cli.ts serve     # run without installing
deno run --allow-all src/ui/server.ts # standalone dashboard
```

---

## Project Structure

```
porter/
  cli.ts                CLI entry point (thin dispatcher)
  src/cli/
    flags.ts            Shared CLI flag parser
    init.ts             porter init, add-agent (interactive wizard)
    session.ts          porter start, stop, status, snapshot, sessions
    serve.ts            porter serve, ui, router
    cluster.ts          porter login, deploy, teardown
    send.ts             porter send
    mcp.ts              porter mcp
  mod.ts                Public API (re-exports)
  worker.ts             Standalone remote worker (OpenShift pods)
  isolate.ts            V8 Worker entry point (BusProxy, CoordinatorProxy, RPC)
  Dockerfile            Container image for deployment
  src/
    core/
      config.ts         Config types (PorterConfig, AgentConfig)
      client.ts         API client factory (Anthropic / Vertex)
      catalog.ts        Model catalog and provider inference
    runtime/
      agent.ts          Agent loop (prompt -> tool_use -> execute -> repeat)
      bus.ts            MessageBus + BusServer (WebSocket relay) + BusClient
      rate_limiter.ts   Global rate limit coordinator
      heartbeat.ts      Agent health monitoring
      snapshot.ts       Conversation state persistence
    orchestration/
      orchestrator.ts   Session startup (provisionRepo, start())
      session_manager.ts Multi-session manager (create/stop/delete)
      registry.ts       Session file registry (~/.porter/sessions.json)
      transport.ts      Display transport (LocalTransport, NullTransport)
      display.ts        Agent event -> tmux pane streaming
      metrics.ts        Session metrics collection
      message_store.ts  Persistent JSONL message store
    graph/
      store.ts          Oxigraph WASM graph store wrapper
      vocabulary.ts     RDF vocabulary (AS2 + PROV-O + Porter ontology)
      shapes.ttl        SHACL validation shapes
      converters.ts     JSON <-> RDF bidirectional converters
      validate.ts       SHACL config validation
    tools/
      mod.ts            Tool registry and lazy loader
      shapes.ts         Tool call validation and repair
      bash.ts           Shell command execution (sandbox-aware)
      read_file.ts      File reading (path-validated in sandbox)
      write_file.ts     File creation/overwrite (path-validated)
      edit_file.ts      Exact string replacement (path-validated)
      glob.ts           File pattern matching (path-validated)
      grep.ts           Regex search across files (path-validated)
      list_dir.ts       Directory listing (path-validated)
      git.ts            Git operations (sandbox-aware)
      send_message.ts   Publish to bus channel
      read_messages.ts  Drain messages from subscribed channels
      memory_write.ts   Write to shared knowledge graph
      memory_query.ts   SPARQL query against knowledge graph
    sandbox/
      mod.ts            Sandbox module exports
      paths.ts          Path validation (workspace boundary enforcement)
      executor.ts       Container sandbox executor (podman/docker)
    router/
      server.ts         Multi-user reverse proxy (pod-per-user)
      pod_registry.ts   User pod provisioning and lifecycle
      tool_registry.ts  Runtime tool registry (UBI images)
    providers/
      mod.ts            Provider factory
      types.ts          Shared provider types
      openai_compat.ts  vLLM provider (Granite, Mistral, Qwen, Llama)
      vertex_claude.ts  Vertex AI Claude proxy
      vertex_gemini.ts  Vertex AI Gemini proxy
      tool_shim.ts      Legacy tool call parser
    mcp/
      mcp_client.ts     Connect to external MCP servers
      mcp_server.ts     Porter as MCP endpoint for editors
    auth/
      mod.ts            Authentication module exports
      oidc.ts           OIDC discovery, auth URL, code exchange
      session.ts        AES-256-GCM encrypted session cookies
      csrf.ts           CSRF protection (HMAC-SHA256 + PKCE)
      middleware.ts     JWT validation, JWKS fetching
      credentials.ts    Per-user encrypted credential storage
      user_store.ts     Per-user team persistence
    ui/
      server.ts         HTTP server (API, /ws proxy, assets)
      index.html        Single-page app shell
      loading.html      Pod provisioning loading page (router mode)
      auth-choose.html  Login chooser page (SSO + Solid options)
      logged-out.html   Post-logout landing page
      mcp-auth-result.html  MCP OAuth callback result page
      app.js            State management, WebSocket, Team Manager
      flipboard.js      Split-flap config panel component
      porter.css        Pullman Porter theme (dark mahogany, brass)
      cpx-store.js      Reactive state store base class
      cpx-model-config.js  Model configuration component
      solid-auth.js     Solid OIDC authentication
      porter-dialog.js  Dialog component
      constants.js      UI constants and helpers
      dom.js            Safe DOM construction helpers (replaces innerHTML)
      sw.js             Service worker (PWA caching + background polling)
      manifest.json     Web app manifest (PWA metadata)
      dialogs/
        team-builder.js   Team Builder wizard (3-step)
        agent-editor.js   Agent create/edit dialog
        agent-library.js  Agent library with multi-select and Build Team
        session-launcher.js  Session launch dialog
        model-setup.js    Model configuration dialog
        mcp-editor.js     MCP server configuration dialog
        dialog-helpers.js Shared dialog utilities
      stores/
        config-store.js   Configuration state store
        model-store.js    Model registry state store
        project-store.js  Project state store
        runtime-stores.js Runtime state stores
      sync/
        pod-sync.js       LWS/Solid Pod sync (ETag-based writes)
        sync-helpers.js   Sync utility functions
  test/                 231 tests (deno task test)
  deploy/
    orchestrator.yaml   Single-instance orchestrator deployment
    deployment.yaml     Worker pod template
    service.yaml        Bus ClusterIP service
    router.yaml         Multi-user router deployment + RBAC
    user-pod-template.yaml  Per-user orchestrator pod template
  examples/             Ready-to-use configurations
  docs/
    as2-agent-protocol.md  ActivityStreams 2.0 wire format reference
    tool-gateway.md        Tool system specification
    architecture.md        System architecture and diagrams
    deployment-guide.md    OpenShift deployment guide
    tools.md               Runtime tool injection guide
```

---

## License

MIT
