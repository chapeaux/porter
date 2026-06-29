# ActivityPub Federation

Porter teams can be followed from Mastodon or any ActivityPub-compatible service. Each team becomes a `Service`-type actor on the fediverse, discoverable via WebFinger. Fediverse users interact with agent teams through DMs -- sending commands, routing messages to specific agents, and receiving responses in-thread.

## Configuration

Add an `activitypub` block to `porter.json`:

```json
{
  "activitypub": {
    "enabled": true,
    "domain": "porter.example.com",
    "approval_mode": "allowlist",
    "allowlist": ["mastodon.social"],
    "public_summaries": false,
    "max_sessions_per_follower": 1
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable ActivityPub federation |
| `domain` | `string` | | Public domain for actor URLs (e.g. `porter.example.com`) |
| `approval_mode` | `"open" \| "allowlist" \| "manual"` | `"allowlist"` | How follow requests are handled |
| `allowlist` | `string[]` | `[]` | Domains or `@user@domain` handles to auto-approve |
| `public_summaries` | `boolean` | `false` | Post session summaries publicly (default: followers-only) |
| `max_sessions_per_follower` | `number` | `1` | Max concurrent AP-initiated sessions per follower |

Federation is also configurable from the web dashboard via the **FEDERATION** flipboard cell, which opens a dialog for enabling/disabling federation, configuring the domain and approval mode, managing the allowlist, and publishing or unpublishing individual teams. The Team Builder's Get Started wizard includes federation setup as part of the team creation flow.

### Environment Variables

AP can be enabled entirely through environment variables, without modifying `porter.json`:

| Variable | Description |
|----------|-------------|
| `PORTER_AP_ENABLED` | Set to `"true"` to enable ActivityPub federation. Equivalent to `activitypub.enabled` in `porter.json`. |
| `PORTER_AP_DOMAIN` | The public domain for actor URLs (e.g. `porter.example.com`). Equivalent to `activitypub.domain` in `porter.json`. |

Environment variables serve as fallbacks -- if the `activitypub` block in `porter.json` explicitly sets `enabled` or `domain`, the config file values take precedence. If neither source provides a domain when AP is enabled, Porter logs an error and disables federation:

```
[activitypub] AP enabled but no domain configured.
Set activitypub.domain in porter.json or PORTER_AP_DOMAIN env var.
```

Resolution order for each field:

1. Explicit value in `porter.json` (`activitypub.enabled`, `activitypub.domain`)
2. Environment variable (`PORTER_AP_ENABLED`, `PORTER_AP_DOMAIN`)
3. Default (`false` for enabled, empty string for domain)

### Config Persistence

Federation configuration and state are persisted differently depending on the deployment mode.

**Standalone mode** (`porter serve`): Configuration is saved as JSON files under `~/.porter/activitypub/`:

```
~/.porter/activitypub/
  config.json          # AP config (domain, approval_mode, allowlist, etc.)
  registry.json        # Published teams and their owners
  {teamSlug}/
    followers.json     # Approved followers for the team
    pending_follows.json  # Follow requests awaiting approval
    conversations.json # Active DM-to-session conversation mappings
```

The `PUT /api/activitypub/config` REST endpoint writes to `~/.porter/activitypub/config.json`. The `GET /api/activitypub/config` endpoint reads from this file, falling back to the in-memory config.

**Router mode** (`porter router`) with S3/MinIO: When S3 credentials are configured, Porter uses a SPARQL-backed store (`SparqApStore`) that persists all federation state as RDF triples to MinIO. The store maintains an in-memory SPARQL graph and flushes mutations to an N-Triples file (`porter-ap/graph.nt`) in the configured S3 bucket.

The S3 client is configured via environment variables:

| Variable | Description |
|----------|-------------|
| `S3_ENDPOINT` | MinIO/S3 endpoint URL (e.g. `http://minio:9000`) |
| `S3_BUCKET` | Bucket name for AP state storage |
| `S3_ACCESS_KEY` | Access key for authentication |
| `S3_SECRET_KEY` | Secret key for authentication |
| `S3_REGION` | Region (default: `us-east-1`) |

The SPARQL store holds all AP state in a single graph: federation registry (published teams), followers, pending follow requests, conversation mappings, HTTP signature key pairs, and federation config. On every mutation (new follower, conversation update, config change), the graph is serialized to N-Triples and written to S3 within 100ms via a debounced flush. On startup, the store loads the graph from S3 to restore state.

This architecture means router-mode deployments survive pod restarts without losing federation state, while standalone-mode deployments use the simpler filesystem approach.

## Porter as a Solid Agent

Porter identifies itself as a Solid agent, enabling authenticated access to users' Solid Pods for team configuration sync. This identity is established through two well-known documents.

### Client Identifier Document

Porter serves a Solid Client Identifier Document at `/.well-known/solid/client-id`. This tells Solid identity providers who Porter is and how it authenticates:

```json
{
  "@context": "https://www.w3.org/ns/solid/oidc-context.jsonld",
  "client_id": "https://porter.example.com/.well-known/solid/client-id",
  "client_name": "Porter Agent Orchestrator",
  "redirect_uris": ["https://porter.example.com/auth/solid-callback"],
  "grant_types": ["authorization_code", "client_credentials", "refresh_token"],
  "scope": "openid webid offline_access",
  "token_endpoint_auth_method": "none",
  "client_uri": "https://porter.example.com",
  "logo_uri": "https://porter.example.com/porter.svg"
}
```

The `client_id` field points to this same document's URL, following the Solid-OIDC convention where the Client Identifier Document URL is used as the `client_id` in OAuth flows.

### WebID Profile

Porter also serves a WebID profile at `/.well-known/solid/webid` (and at `/ap/porter`), identifying itself as a `foaf:Agent`:

```turtle
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<https://porter.example.com/ap/porter#id>
  a foaf:Agent ;
  rdfs:label "Porter Agent Orchestrator" ;
  solid:oidcIssuer <https://porter.example.com> .
```

### Key Pair Management

Porter uses an EC P-256 key pair for Solid-OIDC authentication (`client_credentials` / `private_key_jwt`), DPoP proofs (RFC 9449), and client assertions.

Key pair loading priority:

1. `PORTER_SOLID_PRIVATE_KEY` / `PORTER_SOLID_PUBLIC_KEY` environment variables (JWK JSON)
2. File at `~/.porter/solid/keypair.json`
3. Generate a new pair and save to `~/.porter/solid/keypair.json`

In router mode, Porter uses this identity to fetch team configurations from users' Solid Pods when the team config is not available locally. The flow is: obtain a bearer token using `client_credentials` grant with the Solid IDP, then fetch the team's Turtle representation from the Pod (e.g. `{podUrl}/porter/teams/{teamSlug}.ttl`).

## DM Interface

Fediverse users interact with Porter teams by sending direct messages to the team's actor account.

**Commands:**

| Command | Description |
|---------|-------------|
| `/start` | Begin a new session |
| `/stop` | End the current session |
| `/status` | Check session status (uptime, agent count, token usage) |
| `/teams` | List available federated teams |

**Addressing:**

| Syntax | Routing |
|--------|---------|
| `#agentname message` | Route to a specific agent by name |
| `#role message` | Route to all agents with that role (`admin`, `worker`, `reviewer`) |
| No hashtag | Broadcast to the whole team |

Hashtag routing checks agent names first (exact match, case-insensitive), then falls back to role matching. The hashtag is stripped from the message before delivery.

**Channel subscriptions:**

Users can opt into receiving agent output from specific bus channels:

| Command | Description |
|---------|-------------|
| `#follow #logs` | Receive agent status updates |
| `#follow #activity` | Receive all agent output (verbose) |
| `#follow #errors` | Receive only error/retry events |
| `#follow #tasks` | Receive inter-agent task assignments |
| `#follow #review` | Receive review channel output |
| `#unfollow #channel` | Stop receiving from a channel |
| `#subscriptions` | List current subscriptions |

By default, users only receive explicit `ap_reply` responses from agents. Subscriptions are opt-in for visibility into the agent workflow.

Relayed messages include agent attribution: `[log] coder: refactored auth module`. Messages are batched within 10-second windows to prevent flooding.

**Info commands:**

| Command | Description |
|---------|-------------|
| `#help` | Show the full command/hashtag reference |
| `#who` / `#roster` | Show active agents and their current status |

## DM-to-Session Flow

When a fediverse user sends a DM to a Porter team actor, the message passes through the session bridge, which translates AP interactions into Porter session operations.

### The /start Flow

The full lifecycle of a DM-initiated session:

1. **DM arrives at inbox.** A fediverse user sends `/start` as a DM to `@teamname@porter.example.com`. The inbox handler (`POST /ap/actors/{teamName}/inbox`) verifies HTTP signatures, parses the activity, and detects it as a direct message (the team actor is in `to` and `as:Public` is not in `to` or `cc`).

2. **Message parsing.** The session bridge strips HTML tags from the note content and parses the plain text. The `/start` prefix is recognized as a command.

3. **Stale session cleanup.** The bridge checks for an existing conversation mapping for this user. If one exists, it verifies the session is still running. If the session is gone, the stale mapping is removed and the flow proceeds.

4. **Team owner resolution.** The bridge resolves which user owns the team via the federation registry. In router mode, this also involves looking up the team's Pod URL if one was registered.

5. **Session creation.** The backend creates a new session:
   - **Standalone mode:** Calls `SessionManager.createSession()` in-process, which starts the agent orchestration loop with the team's config.
   - **Router mode:** Provisions a pod for the team owner via `PodRegistry` (or reuses an existing one), waits for it to become ready (up to 60 seconds with 2-second polling), then POST to the pod's `/api/sessions/launch` endpoint with the team config. In router mode, the backend may also fetch the team config from the user's Solid Pod using Porter's Solid agent credentials if it is not available locally.

6. **Conversation mapping.** The bridge saves a `ConversationMap` linking the AP conversation ID (derived from the fediverse user's actor URL) to the Porter session name. This mapping is what allows subsequent DMs from the same user to route to the same session.

7. **Welcome message.** Porter sends back a welcome DM listing the team name, pattern, agent roster, available commands, addressing syntax, and subscription options. The welcome message is also appended to the team's outbox and delivered via HTTP signature-authenticated POST to the user's inbox.

### Message Routing

After a session is active, subsequent DMs are routed as follows:

1. The session bridge looks up the conversation mapping for the sender.
2. If no mapping exists, the user is told to `/start` first.
3. The message is parsed for hashtag routing:
   - Hashtags in the AP `tags` array (type `Hashtag`) are checked first.
   - Fallback: regex extraction of `#word` patterns from the text.
   - Reserved hashtags (`#follow`, `#unfollow`, `#subscriptions`, `#help`, `#who`, `#roster`) are handled before agent/role matching.
   - Remaining hashtags are matched against agent names (exact, case-insensitive), then against role names (`admin`, `worker`, `reviewer`).
4. The message is published to the resolved bus channel(s):
   - `#agentname message` publishes to `task:{agentname}`
   - `#role message` publishes to `task:{name}` for each agent with that role
   - No hashtag publishes to `task` (broadcast)
5. The conversation's `lastActivityAt` timestamp is updated.
6. No synchronous reply is sent -- agent output is delivered asynchronously via `ap_reply` tool calls or passive relay.

### Passive Relay

When agents don't explicitly use `ap_reply`, the relay system provides a fallback. The bridge subscribes to the session's `activity` and `log` bus channels. Messages on subscribed channels are forwarded to the fediverse user as DMs, with the format `[channel] agentname: content`.

Relay behavior:

- Messages are batched in 10-second windows, with a maximum of 5 messages per batch (excess messages show a count like `(and 3 more...)`).
- Batched messages are truncated to 500 characters (Mastodon's post limit).
- If the user recently received an `ap_reply`, relay for the `activity` channel is suppressed to avoid echo.
- Error-only subscriptions (`activity:errors`) filter activity content to messages containing "error" or "retrying".

## Agent AP Tools

During AP-initiated sessions, agents gain two additional tools for interacting with the fediverse:

| Tool | Description |
|------|-------------|
| `ap_post` | Post a message to the team's followers. Supports `public` or `followers_only` visibility and optional content warning summaries. |
| `ap_reply` | Reply directly to the fediverse user who initiated the session. Supports file attachments (images, diffs, logs). |

Agents are instructed via system prompt that they're communicating with a fediverse user and should use `ap_reply` for responses. The system prompt suffix injected into AP-bridged sessions reads:

> You are communicating with a fediverse user via ActivityPub DMs. Use the ap_reply tool to respond directly to the user with your findings and results. Use ap_post to share notable findings with the team's followers. The user does not see your internal tool calls or inter-agent messages unless they explicitly subscribe to those channels.

The passive relay serves as a fallback when agents don't explicitly reply.

## Approval Modes

| Mode | Behavior |
|------|----------|
| `open` | All follow requests are accepted automatically. |
| `allowlist` | Accept if the requester's domain or full `@user@domain` handle is in the `allowlist` array; reject otherwise. |
| `manual` | Follow requests are queued for human approval via the dashboard or API. |

When a follow request is approved (whether automatically or manually), Porter immediately sends a welcome DM to the new follower with the team's roster, commands, and addressing instructions.

Manual approval is managed through the dashboard or the REST API:

- `GET /api/activitypub/{teamName}/followers` -- lists approved followers and pending follow requests.
- `POST /api/activitypub/{teamName}/followers/{encodedActorId}/approve` -- approves a pending follow request.
- `POST /api/activitypub/{teamName}/followers/{encodedActorId}/reject` -- rejects a pending follow request.
- `DELETE /api/activitypub/{teamName}/followers/{encodedActorId}` -- removes an approved follower.

## Deployment Modes

In **standalone** mode (`porter serve`), the HTTP server handles ActivityPub endpoints directly -- WebFinger, actor documents, inbox, outbox, and HTTP signature verification.

In **router** mode (`porter router`), the router handles AP at the edge and provisions user pods as needed. AP endpoints are served by the router itself, with session lifecycle delegated to the per-user orchestrator pods.

### AP HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/webfinger` | GET | WebFinger discovery. Resolves `acct:teamname@domain` to the team's actor URL. |
| `/ap/actors/{name}` | GET | Actor document. Returns the team's `Service`-type AP actor with public key, inbox/outbox URLs, and roster summary. |
| `/ap/actors/{name}/inbox` | POST | Inbox. Receives activities (Follow, Create/Note, Undo, etc.) with HTTP signature verification. |
| `/ap/actors/{name}/outbox` | GET | Outbox collection. Lists the team's published activities. |
| `/ap/actors/{name}/followers` | GET | Followers collection. |
| `/ap/media/{id}` | GET | Media attachments uploaded via `ap_reply`. |
| `/.well-known/solid/client-id` | GET | Solid Client Identifier Document (see above). |
| `/.well-known/solid/webid` | GET | Porter's WebID profile. |

### REST API for Federation Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/activitypub/config` | GET | Read current AP config. |
| `/api/activitypub/config` | PUT | Update AP config (requires auth). |
| `/api/activitypub/teams` | GET | List federated teams for the current user. |
| `/api/activitypub/publish` | POST | Publish a team for federation. |
| `/api/activitypub/unpublish` | POST | Unpublish a team. |

## Example Interaction

```
1. Search @devteam@porter.example.com from Mastodon
2. Follow the account -> approved (per approval_mode)
3. DM: /start
   -> Porter replies with welcome message:

     devteam -- AI agent team on Porter

     Pattern: Sequential

     Agents:
       #planner (admin)
       #coder (worker)
       #reviewer (reviewer)

     Commands:
       /start -- Begin a new session
       /stop -- End the current session
       /status -- Check session status
       /teams -- List available teams

     Addressing:
       #agentname message -- routes to that agent
       #role message -- routes to all agents with that role
       No hashtag -- broadcast to the whole team

     Subscriptions:
       #follow #logs -- agent status updates
       #follow #activity -- all agent output
       #follow #errors -- error notifications only
       #follow #tasks -- inter-agent task assignments
       #unfollow #channel -- stop receiving
       #subscriptions -- list current

     Info:
       #help -- show this reference
       #who -- show active agents

4. DM: #coder fix the login bug
   -> Message routed to the coder agent's task channel
   -> Agent responds via ap_reply in the DM thread

5. DM: #follow #logs
   -> Now receiving agent status updates as DMs
   -> [log] coder: analyzing login flow...
   -> [log] coder: found issue in auth middleware

6. DM: /stop
   -> Session ends, conversation mapping cleared
```

## Known Limitations

- **Single team per actor.** Each team is exposed as a separate AP actor. There is no shared inbox across teams -- each team has its own inbox, outbox, followers, and key pair.

- **No outbound follows.** Porter teams are followable actors but do not follow other accounts. Federation is inbound-only: users follow teams, not the other way around.

- **Mastodon post length.** Relay messages and aggregated responses are truncated to 500 characters to fit Mastodon's default post limit. Longer agent output may be cut off with an ellipsis.

- **No threaded replies for relay.** Relay messages (from channel subscriptions) are delivered as new DMs, not as threaded replies to the original conversation. Only explicit `ap_reply` responses from agents are threaded.

- **Session concurrency.** The `max_sessions_per_follower` setting (default 1) limits how many simultaneous sessions a single fediverse user can have with a team. Attempting to `/start` while a session is active returns an error.

- **No federation of agent-to-agent messages.** Inter-agent communication stays on the internal message bus. Federation only covers the boundary between fediverse users and agent teams.

- **HTTP signature verification is basic.** Porter verifies HTTP signatures on incoming activities but does not implement the full caveat system or LD Signatures. Some AP implementations with non-standard signature schemes may not interoperate.

- **No migration.** Moving a team to a different domain (changing `PORTER_AP_DOMAIN`) does not send `Move` activities to followers. Followers on the old domain will lose access.

- **Standalone-mode state is local.** In standalone mode, federation state (followers, conversations, keys) is stored in `~/.porter/activitypub/` as JSON files. These are not replicated or backed up automatically. Only router mode with S3/MinIO provides durable, restart-safe persistence.
