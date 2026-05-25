# Porter Architecture

This document describes Porter's internal architecture: how agents are
isolated, how they communicate, how sessions are managed, and how tools are
dispatched in the execution pipeline.

## V8 Isolate Model

Porter runs each agent as a V8 Worker isolate -- a separate JavaScript
execution context with its own memory, running on an OS-level thread. This
provides crash containment, memory isolation, and true parallelism.

```
orchestrator (main thread)
  |
  +-- SessionManager         manages concurrent sessions (serve mode)
  |     |
  |     +-- Session A
  |     |     +-- MessageBus          owns all agent mailboxes
  |     |     +-- BusServer           WebSocket relay (port 8788)
  |     |     +-- RateLimitCoordinator  global API rate limiting
  |     |     +-- Worker isolates x N   one per agent
  |     |
  |     +-- Session B
  |           +-- MessageBus          independent mailboxes
  |           +-- BusServer           WebSocket relay (port 8789)
  |           +-- RateLimitCoordinator  independent limits
  |           +-- Worker isolates x N   one per agent
  |
  +-- UIServer                HTTP server (port 3000)
  |     +-- REST API          session CRUD, metrics, teams, agents
  |     +-- WebSocket proxy   routes /ws?session=X to session bus
  |     +-- Static assets     HTML, JS, CSS, SVG
  |
  +-- GraphStore              Oxigraph WASM, SPARQL, SHACL
```

### Benefits of Isolation

- **Crash containment** -- A crashed agent isolate does not poison other
  agents. The orchestrator detects the failure via heartbeat and can restart
  the agent.
- **Memory isolation** -- Agents cannot accidentally share state. Each isolate
  has its own heap, tool registry, and SDK client.
- **True parallelism** -- OS-level threads provide genuine parallel execution,
  not just async interleaving on a single thread.

### Disabling Isolates

For debugging, isolates can be disabled. All agents run in the main thread:

```bash
porter start --no-isolates
```

Or in config:

```json
{ "isolates": false }
```

## Agent Execution Pipeline

Each agent runs a loop inside its isolate:

```
                    +------------------+
                    |   System Prompt  |
                    +--------+---------+
                             |
                    +--------v---------+
               +--->|   LLM API Call   |
               |    +--------+---------+
               |             |
               |    +--------v---------+
               |    | Parse Response   |
               |    +--------+---------+
               |             |
               |        tool_use?
               |        /       \
               |      yes        no
               |       |          |
               |  +----v-----+   +----v-----+
               |  | Tool     |   | Text     |
               |  | Dispatch |   | Output   |
               |  +----+-----+   +----------+
               |       |
               |  +----v-----------+
               |  | Tool Execute   |
               |  | (bash, git,    |
               |  |  read_file...) |
               |  +----+-----------+
               |       |
               +-------+
```

The **tool dispatch** step is where `executeTool()` handles each tool call.
Agents see individual tools directly (`bash`, `read_file`, `write_file`,
`edit_file`, `send_message`, `read_messages`, etc.). The `send_message` and
`read_messages` tools transparently wrap/unwrap AS2 envelopes on the wire.
Role-based filtering restricts which tools each agent can access.

## Message Bus

Agents communicate through named channels on an in-process message bus. The
bus supports both in-process delivery (for isolate workers) and WebSocket
relay (for remote workers and the dashboard).

### Channels

| Channel          | Purpose                                        |
|------------------|-------------------------------------------------|
| `task`           | Admin assigns work to workers (broadcast)       |
| `task:<name>`    | Direct message to a specific agent              |
| `log`            | Workers report progress to admin                |
| `review`         | Review requests and feedback                    |
| `control`        | System directives (pause, resume, priority)     |
| `activity`       | Internal: agent roster and lifecycle events     |

### Bus Architecture

```
                       MessageBus
                     (in-process)
                          |
          +---------------+---------------+
          |               |               |
     agent-A          agent-B          agent-C
     mailbox          mailbox          mailbox
          |               |               |
          +-------+-------+-------+-------+
                  |               |
             BusServer        BusServer
           (port 8788)      (port 8789)
                  |               |
              Session A       Session B
```

Each session has its own `MessageBus` with isolated mailboxes. The
`BusServer` component exposes a WebSocket endpoint for:

- Remote workers running in OpenShift pods
- The web dashboard UI
- External tooling connecting via WebSocket

### WebSocket Proxy

In cloud deployments, the UI server proxies WebSocket connections to the
correct session's bus:

```
browser --> /ws?session=myteam --> UI server proxy --> session bus (localhost:8788)
```

No bus ports need to be exposed externally. All traffic routes through the
single UI port (3000). The proxy uses the `session` query parameter to look
up the correct `BusServer` port from the `SessionManager`.

## Session Manager

The `SessionManager` coordinates multiple concurrent sessions in `porter
serve` mode. Each session is a fully independent runtime:

- Its own `MessageBus` with isolated agent mailboxes
- Its own `BusServer` on a unique port (auto-allocated starting at 8788)
- Its own `RateLimitCoordinator`
- Its own set of V8 Worker isolates

### Port Allocation

The session manager finds free ports by attempting to bind each port starting
from 8788. It increments until a genuinely free port is found (up to 100
attempts). This catches ports held by not-yet-closed BusServers from previous
sessions.

### Session Lifecycle

```
Create Session
  |
  +-- Allocate bus port
  +-- Create MessageBus
  +-- Create BusServer
  +-- Create RateLimitCoordinator
  +-- Provision repo (if configured)
  +-- Start agent isolates
  +-- Register in ~/.porter/sessions.json
  |
  v
Running
  |
  +-- API: GET /api/sessions/<name>/metrics
  +-- API: GET /api/sessions/<name>/messages
  +-- WebSocket: /ws?session=<name>
  |
  v
Stop Session
  |
  +-- Save snapshot to ~/.porter/snapshots/<name>/latest.json
  +-- Terminate agent isolates
  +-- Close BusServer
  +-- Unregister from sessions.json
```

### Session vs. Team

Teams and sessions are decoupled:

- **Teams** are reusable configuration templates stored in
  `~/.porter/teams/`. They define agents, models, and settings.
- **Sessions** are named running instances created from teams. Multiple
  sessions can run from the same team config with auto-generated names
  (`myteam-1`, `myteam-2`, etc.).

## Graph Store

Porter includes an in-memory RDF graph store powered by Oxigraph (WASM). It
serves three purposes:

### SPARQL Query Access

All bus messages are stored as ActivityStreams 2.0 RDF triples alongside the
JSONL persistence. The REST API exposes a query endpoint:

```
GET /api/sparql?query=SELECT ?agent ?msg WHERE { ... }
```

### SHACL Config Validation

Team configurations are validated against SHACL shapes before launching
sessions. The shapes enforce required fields, valid roles, and structural
constraints:

```
POST /api/validate
Content-Type: application/json

{ "session": "myteam", "agents": [...] }
```

### Agent Memory

The `memory` gateway tool writes to and queries from the graph store. This
gives agents persistent, shared knowledge within a session. A planner can
record architectural decisions; workers can query them later.

## UI Server

The UI server (`src/ui/server.ts`) is a Deno HTTP server that handles:

- **Static assets** -- HTML, JS, CSS, SVG from `src/ui/`
- **REST API** -- session CRUD, metrics, teams, agents, models, credentials
- **WebSocket proxy** -- routes `/ws?session=X` to the session bus
- **Auth middleware** -- OIDC token validation, session cookies, CSRF

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions` | GET | List all sessions |
| `/api/sessions` | POST | Create a new session |
| `/api/sessions/:name/stop` | POST | Stop a session |
| `/api/sessions/:name/agents/:agent/restart` | POST | Restart a single agent |
| `/api/sessions/:name/metrics` | GET | Session metrics |
| `/api/sessions/:name/messages` | GET | Message history |
| `/api/teams` | GET/POST | List/save teams |
| `/api/agents` | GET/POST | Agent library CRUD |
| `/api/models/available` | GET | Configured models |
| `/api/sparql` | GET | SPARQL query |
| `/api/validate` | POST | SHACL validation |
| `/auth/callback` | GET | OIDC callback |
| `/auth/logout` | GET | Logout (revokes refresh token, ends SSO session) |
| `/auth/me` | GET | Current user info (includes `pod_url` for LWS) |
| `/auth/lws-token` | POST | Retrieve LWS access token for Pod operations |
| `/healthz` | GET | Health check |
| `/ws` | WS | WebSocket proxy |

## Multi-user isolation

Porter's `serve` mode supports multiple concurrent users, each with their own
sessions. Isolation is enforced at two levels:

### Session ownership

Every session is associated with the `ownerId` of the user who created it.
All session API endpoints and the WebSocket proxy enforce ownership:

- `GET /api/sessions` returns only sessions belonging to the authenticated user
- Session mutation endpoints (stop, delete, edit) require ownership
- Read endpoints (config, metrics, messages) require ownership
- The WebSocket proxy at `/ws` verifies session ownership before upgrading

Sessions created without authentication (local development) have no owner and
are accessible to all users for backwards compatibility.

### Bus isolation

Each session runs its own `MessageBus` and `BusServer` on a dedicated port.
Agent messages within a session never cross session boundaries. The WebSocket
proxy routes each client to the correct session's bus based on the `?session=`
query parameter.

## Pod-per-user isolation

For production deployments requiring stronger isolation, Porter supports a
**pod-per-user** model where each authenticated user gets their own
orchestrator pod running in a dedicated container.

### Architecture

```
Browser --> Router Pod (auth + provisioning + proxy)
              +--> User-A Pod (porter serve --single-user)
              +--> User-B Pod (porter serve --single-user)
              +--> ...
```

The **Router Pod** is a thin reverse proxy (`porter router`) that handles:

1. OIDC authentication (login, callback, session cookies)
2. Pod provisioning via the `oc` CLI (creates Deployment + Service per user)
3. HTTP and WebSocket reverse proxying to the user's pod
4. Idle pod reaping (deprovisions pods after configurable inactivity)

Each **User Pod** runs `porter serve --headless --single-user`, which skips
OIDC setup (the router already authenticated the user) and provides a fully
independent orchestrator environment.

### Security properties

- **Memory isolation** -- Each user's agents, sessions, and state live in a
  separate container with its own memory space. No shared heap, no shared V8
  isolates between users.
- **Network isolation** -- User pods are exposed only via ClusterIP Services,
  reachable only from within the cluster. The router is the sole entry point.
- **Resource quotas** -- Each user pod has CPU and memory limits (default:
  500m-2 CPU, 512Mi-1Gi memory). A runaway session in one pod cannot starve
  other users.
- **Credential isolation** -- API keys and secrets are scoped to individual
  pods. The router does not forward credentials to user pods; each pod manages
  its own.

### Complement to code-level ownership

Pod-per-user isolation complements the session ownership model (Phase A):

- **Session ownership** provides code-level access control within a shared
  process -- efficient for trusted environments or small teams.
- **Pod-per-user** provides container-boundary isolation -- required for
  untrusted multi-tenant environments where users should not share a process.

Both can be used together: the router provisions isolated pods, and within
each pod, session ownership ensures that only the pod's designated user can
access its sessions.

### Login chooser

In router mode, unauthenticated users see a login chooser page
(`src/ui/auth-choose.html`) with two options:

- **SSO** -- redirects to the configured OIDC provider
- **Solid / LWS** -- enter a Solid identity provider URL for decentralized
  login

### Logout

The `GET /auth/logout` endpoint revokes the Keycloak refresh token via the
OIDC revocation endpoint before redirecting to the provider's end-session
URL. This ensures proper SSO logout rather than only clearing the local
session cookie.

### LWS token exchange

When `PORTER_LWS_BASE_URL` is configured, SSO users get Pod storage via a
server-side token exchange:

1. User authenticates with the OIDC provider (Keycloak)
2. At login time, the server exchanges the Keycloak ID token for a
   Tudor/LWS access token using the
   `urn:ietf:params:oauth:grant-type:token-exchange` grant type
3. The LWS token is stored server-side in the session (not in the cookie,
   which has a 4 KB limit)
4. The browser calls `POST /auth/lws-token` to retrieve the access token
   for Pod operations
5. Pod writes use `POST` for creation and `PUT` with `If-Match` (ETag) for
   updates to prevent write conflicts

## Local sandbox isolation

For local development, the `--sandbox` flag (or `sandbox: true` in config)
restricts agents to the workspace directory using two defense layers:

### Container auto-detection

When Porter is already running inside a container (e.g., an OpenShift pod
provisioned by `porter router`), the container sandbox is automatically
skipped at session init -- the pod itself provides isolation. Path
validation for Deno-native tools still applies in all environments.

### Container sandbox for subprocesses

`bash` and `git` commands execute inside a long-lived podman/docker
container with only the workspace directory bind-mounted at `/workspace`.
The host filesystem, SSH keys, GPG keys, and host environment variables are
not accessible inside the container. The container is started at session
init and shared across all agents via `podman exec`.

```
Host filesystem
  ├── ~/.ssh/           ← NOT mounted
  ├── ~/.gnupg/         ← NOT mounted
  └── /workspace/       ← mounted at /workspace inside container
        └── (agent files)
```

### Path validation for Deno-native tools

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, and `list_dir` use
`validatePath()` from `src/sandbox/paths.ts` to verify that all resolved
paths (after symlink resolution and traversal normalization) remain within
the workspace directory. Absolute paths, `../` escapes, and symlinks
pointing outside the workspace are rejected with a `PathEscapeError`.

### Runtime configuration

```json
{
  "sandbox": {
    "enabled": true,
    "image": "registry.access.redhat.com/ubi9/ubi:latest",
    "runtime": "podman"
  }
}
```

Requires `podman` (preferred) or `docker` on the host. Podman is recommended
for rootless operation on Fedora/RHEL.

## Runtime tool injection

Porter can inject additional tools (Python, curl, Node.js, etc.) into agent
pods or sandbox containers at provisioning time. Each requested tool becomes
an init container that copies a binary from a Red Hat UBI image into a
shared `emptyDir` volume at `/porter/tools`. See [`docs/tools.md`](tools.md)
for the full configuration guide.
