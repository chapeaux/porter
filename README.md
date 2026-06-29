# Porter

<p align="center">
  <img src="src/ui/porter.svg" alt="Porter" width="120">
</p>

A pure-Deno multi-agent orchestration platform. Porter runs agents as V8-isolated workers with crash containment, coordinates them through an in-process message bus, and exposes a browser-based dashboard for real-time monitoring and team management. Agents collaborate via pluggable collaboration patterns (Sequential, Mixture, Deliberation, Distillation), share state through an RDF knowledge graph, and are addressable as linked data resources.

Named in honor of the historic United States railroad Pullman Porters, who coordinated the seamless operation of passenger rail cars.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Deployment Modes](#deployment-modes)
- [CLI Reference](#cli-reference)
- [Feature Highlights](#feature-highlights)
- [Configuration Reference](#configuration-reference)
- [Project Structure](#project-structure)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

---

## Quick Start

```bash
# Install (requires Deno 2+)
git clone https://github.com/chapeaux/porter.git && cd porter
deno install --global --allow-all --name porter --config deno.json cli.ts

# Set your API credentials
export ANTHROPIC_API_KEY=sk-ant-...

# Start the platform and open the dashboard
porter serve
open http://localhost:3000
```

---

## Deployment Modes

| Mode | Command | Description |
|------|---------|-------------|
| **Local single session** | `porter start --config porter.json` | tmux-based, single team. Agents run in tmux panes for direct terminal observation. |
| **Local platform** | `porter serve` | Web dashboard at `http://localhost:3000`. Multiple concurrent sessions, no tmux required. |
| **Cloud pod-per-user** | `porter router` | Multi-tenant on OpenShift. Each SSO user gets an isolated orchestrator pod. See [Deployment Guide](docs/deployment-guide.md). |

See [`examples/`](examples/) for ready-to-use configs covering all four collaboration patterns.

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

## Feature Highlights

### Web Dashboard

Real-time monitoring and full lifecycle management. A flipboard config panel shows live counts for models, MCP servers, agents, teams, and session status. The Team Builder wizard creates agent teams without editing JSON. A persistent metrics footer shows input/output tokens, API calls, errors, and rate limit hits. Porter is also a PWA -- installable and offline-capable.

### Collaboration Patterns

Four built-in patterns inspired by [RecursiveMAS](https://arxiv.org/abs/2502.09601) research: **Sequential** (admin/worker/reviewer pipeline), **Mixture** (parallel specialists + synthesizer), **Deliberation** (iterative critique loop), and **Distillation** (expert plans, learner executes). Agents are portable across patterns -- the same agent definition works in any coordination structure. See [Collaboration Patterns](docs/collaboration-patterns.md) for the full schema reference.

### Agent Authoring

Agents are first-class entities with role-based tool access, system prompt sections, MCP tool bindings, and context tags. The Agent Library supports import/export via JSON-LD, Turtle, or JSON, with URL linking and Solid Pod sharing. See [Agent Authoring Guide](docs/agent-authoring.md) for details.

### Tool System

Agents get individual, purpose-specific tools based on their role. Pattern-specific tools (e.g., `finding_write`, `critique_write`) are auto-injected at session start. See [Tool Gateway](docs/tool-gateway.md) for the full specification.

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

### Model Configuration

Models support Anthropic, Vertex AI, and OpenAI-compatible providers (vLLM, Ollama). Porter auto-detects small models (1B-7B) and enables simplified tool schemas with a tool inference engine. Credentials are stored per-user with AES-256-GCM encryption and managed via the dashboard.

### MCP Integration

Connect external [Model Context Protocol](https://modelcontextprotocol.io/) servers via stdio or Streamable HTTP transport. MCP tools are wrapped as Porter tool entries and granted to agents via the `mcp_tools` array. Supports OIDC-authenticated remote servers. See [Tool Gateway](docs/tool-gateway.md) for the full specification.

### Vector Store

Qdrant-backed semantic search over agent memory and knowledge graph content. Enables retrieval-augmented generation (RAG) workflows within agent sessions. See [Vector Store](docs/vector-store.md) for configuration and usage.

### Solid Pod Sync

User configuration (agents, teams, models, credentials) is stored on Linked Web Storage / Solid Pods. Data persists across pod restarts and is portable across deployments -- log in with the same identity on a different instance and your configuration follows. Supports SSO token exchange and Solid OIDC with DPoP-bound tokens.

### ActivityPub Federation

Teams become fediverse actors discoverable via WebFinger. Fediverse users interact through DMs -- sending commands, routing messages to specific agents via hashtag addressing, and subscribing to agent output channels. See [Federation](docs/federation.md) for configuration and the DM interface reference.

### Internationalization

The dashboard supports multiple locales with a runtime i18n system. Locale strings are loaded on demand and the language picker is available in the UI header.

### Linked Data / Ontology

Agents, teams, and patterns are modeled as linked data resources with stable URIs. Content negotiation supports JSON-LD, Turtle, and JSON. The Porter vocabulary covers agents, teams, patterns, roles, findings, critiques, plans, and steps. See [Ontology](docs/ontology.md) for the vocabulary reference.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System architecture, component diagrams, and design decisions |
| [Agent Authoring](docs/agent-authoring.md) | Guide to creating, configuring, and sharing agents |
| [Collaboration Patterns](docs/collaboration-patterns.md) | Pattern design, schema reference, and the visual pattern editor |
| [Tool Gateway](docs/tool-gateway.md) | Tool system specification and MCP integration |
| [Tools](docs/tools.md) | Runtime tool injection (Python, Node.js, curl) for pods |
| [AS2 Agent Protocol](docs/as2-agent-protocol.md) | ActivityStreams 2.0 wire format for inter-agent messages |
| [Federation](docs/federation.md) | ActivityPub federation setup, DM interface, and approval modes |
| [Vector Store](docs/vector-store.md) | Qdrant vector store configuration and RAG workflows |
| [Ontology](docs/ontology.md) | Porter RDF vocabulary and linked data resource model |
| [Deployment Guide](docs/deployment-guide.md) | OpenShift deployment: secrets, OIDC, RBAC, router mode |
| [Static Deployment](docs/static-deployment.md) | Static file deployment for the dashboard |

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
  "pattern": "sequential",
  "repo": "https://github.com/org/repo.git",
  "models": [],
  "mcp_servers": {},
  "activitypub": {},
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
| `pattern` | no | `"sequential"` | Collaboration pattern: `"sequential"`, `"mixture"`, `"deliberation"`, or `"distillation"` |
| `max_deliberation_rounds` | no | `3` | Maximum critique/revision cycles (deliberation pattern only) |
| `sandbox` | no | | Container sandbox (`true` or `{enabled, image?, runtime?}`) |
| `runtime_tools` | no | | Runtime tools to inject into pods (`["python3", "curl"]`) |
| `env` | no | | Environment variables for the session |
| `activitypub` | no | | ActivityPub federation config (`{enabled, domain, approval_mode, allowlist, ...}`) |
| `remote` | no | | OpenShift remote worker config |
| `agents` | yes | | Array of `AgentConfig` objects or `AgentRef` references |

### Model Entry Fields

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
| `role` | yes | | `"admin"`, `"worker"`, `"reviewer"`, `"specialist"`, `"synthesizer"`, `"reflector"`, `"expert"`, or `"learner"` |
| `system_prompt` | yes | | System prompt for the agent |
| `tools` | yes | | Tools this agent can use |
| `model` | no | session default | Override model for this agent |
| `subscribe` | no | `[]` | Bus channels to subscribe to |
| `max_tokens` | no | `8192` | Max tokens per response |
| `max_turns` | no | unlimited | Max conversation turn pairs to keep in context |
| `max_context_tokens` | no | unlimited | Estimated input token budget (~4 chars/token) |
| `reasoning` | no | `false` | Enable extended thinking |
| `mcp_tools` | no | `[]` | MCP tools this agent can access |
| `small_model` | no | auto-detect | Enable simplified tool schemas and tool inference engine |

### AgentRef (Reference-Based Teams)

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `ref` | yes | | Agent name (local library) or URI (remote/Solid Pod) |
| `name` | yes | | Display name (defaults to ref) |
| `role` | yes | | Role assigned by the team's pattern |
| `model` | no | | Optional model override for this team context |

### ActivityPub Config Block

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable ActivityPub federation |
| `domain` | `string` | | Public domain for actor URLs |
| `approval_mode` | `"open" \| "allowlist" \| "manual"` | `"allowlist"` | How follow requests are handled |
| `allowlist` | `string[]` | `[]` | Domains or `@user@domain` handles to auto-approve |
| `public_summaries` | `boolean` | `false` | Post session summaries publicly |
| `max_sessions_per_follower` | `number` | `1` | Max concurrent AP-initiated sessions per follower |

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
| `PORTER_AP_ENABLED` | Enable ActivityPub federation (`true`) |
| `PORTER_AP_DOMAIN` | Public domain for AP actor URLs |

---

## Project Structure

```
porter/
  cli.ts                CLI entry point
  mod.ts                Public API (re-exports)
  worker.ts             Standalone remote worker (OpenShift pods)
  isolate.ts            V8 Worker entry point
  Dockerfile            Container image for deployment
  deno.json             Deno configuration and task definitions
  src/
    core/               Config types, API client factory, model catalog
    runtime/            Agent loop, message bus, rate limiter, snapshots
    orchestration/      Session management, pattern registry, metrics
    graph/              RDF graph store (Sparq WASM), vocabulary, SHACL validation
    tools/              Tool registry and implementations (bash, file ops, git, memory, patterns)
    sandbox/            Container sandbox executor and path validation
    router/             Multi-user reverse proxy and pod provisioning
    providers/          LLM providers (Anthropic, Vertex, OpenAI-compat)
    mcp/                MCP client and server
    auth/               OIDC, session cookies, CSRF, credentials
    activitypub/        Federation: actors, inbox, delivery, WebFinger
    agents/             Agent JSON-LD context
    teams/              Team JSON-LD context
    ui/                 Web dashboard (SPA, PWA, web components)
  test/                 Test suite
  deploy/               OpenShift manifests (orchestrator, router, worker pods)
  examples/             Ready-to-use configurations for all patterns
  docs/                 Extended documentation (see table above)
```

See [Architecture](docs/architecture.md) for component diagrams and design details.

---

## Development

```bash
deno task check                       # type-check all files
deno task test                        # run tests
deno task compile                     # build standalone binary (./porter)
deno run --allow-all cli.ts serve     # run without installing
deno run --allow-all src/ui/server.ts # standalone dashboard
```

---

## License

MIT
