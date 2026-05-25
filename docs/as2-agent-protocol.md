> **Note:** AS2 is used internally as the bus wire format and is managed
> transparently by the `send_message` and `read_messages` tool handlers.
> Agents interact with plain text messages -- they do not need to construct
> or parse AS2 JSON. This document describes the wire format for system
> developers, not for agent prompts.

# Porter Agent Protocol -- ActivityStreams 2.0 Compact Profile

Porter agents communicate over the message bus using a compact subset of
[ActivityStreams 2.0](https://www.w3.org/TR/activitystreams-core/). Messages are
JSON objects inside the bus `content` field. Agents MUST send and receive AS2
messages on all channels.

## Design principles

1. **Compact** -- Only the fields needed for agent coordination. No `@context`,
   no JSON-LD expansion, no nested `@id`/`@type` boilerplate.
2. **Typed** -- Every message has a `type` that tells the receiver what to do
   without parsing prose.
3. **File-mediated** -- Code and large content live in workspace files, not in
   messages. Messages reference paths.
4. **LLM-friendly** -- Field names and activity types are plain English words
   that models already understand from training data.

## Message envelope

Every message is a JSON object with at minimum:

```json
{
  "type": "<ActivityType>",
  "actor": "<agent-name>",
  "summary": "<one-line human-readable description>"
}
```

All other fields are optional and depend on the activity type.

## Activity types

### Task lifecycle

| Type       | Meaning                              | Sent by    |
|------------|--------------------------------------|------------|
| `Offer`    | Assign a task to an agent            | admin      |
| `Accept`   | Acknowledge a task, work starting    | worker     |
| `Reject`   | Decline a task (with reason)         | worker     |
| `Create`   | Produce a new artifact               | worker     |
| `Update`   | Modify an existing artifact          | worker     |
| `Delete`   | Remove an artifact                   | worker     |
| `Announce` | Broadcast status or findings         | any        |
| `Question` | Ask for input or clarification       | any        |

### Execution lifecycle

| Type       | Meaning                              | Sent by    |
|------------|--------------------------------------|------------|
| `Invoke`   | Execute a bash or git command        | worker     |

An `Invoke` activity represents a command execution. The `object` field
contains the command string, and `result` contains the output:

```json
{
  "type": "Invoke",
  "actor": "worker-1",
  "summary": "Running test suite",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Note",
    "content": "deno test --allow-all"
  },
  "result": {
    "type": "Note",
    "content": "14 tests passed, 0 failures"
  },
  "instrument": ["bash"]
}
```

### Knowledge lifecycle

| Type       | Meaning                              | Sent by    |
|------------|--------------------------------------|------------|
| `Remember` | Store a fact in the knowledge graph  | any        |
| `Recall`   | Query the knowledge graph            | any        |

A `Remember` activity stores an observation as an RDF triple in the shared
knowledge graph. The `object` contains the fact:

```json
{
  "type": "Remember",
  "actor": "worker-1",
  "summary": "Recording dependency relationship",
  "object": {
    "type": "Note",
    "about": "urn:porter:file:server.ts",
    "content": "depends on express module for HTTP routing"
  }
}
```

A `Recall` activity queries the knowledge graph. The `object` contains a
SPARQL query, and `result` contains the matching bindings:

```json
{
  "type": "Recall",
  "actor": "architect",
  "summary": "Checking known dependencies",
  "object": {
    "type": "Note",
    "content": "SELECT ?about ?finding WHERE { ?obs <https://porter.chapeaux.io/vocab#about> ?about ; <https://porter.chapeaux.io/vocab#finding> ?finding }"
  },
  "result": {
    "type": "Collection",
    "items": [
      {"about": "urn:porter:file:server.ts", "finding": "depends on express module"}
    ]
  }
}
```

### Review lifecycle

| Type       | Meaning                              | Sent by    |
|------------|--------------------------------------|------------|
| `Offer`    | Request a review (object = diff)     | worker     |
| `Accept`   | Approve the review                   | reviewer   |
| `Reject`   | Request changes (with reason)        | reviewer   |
| `Note`     | Review comment (inline feedback)     | reviewer   |

## Object types

Objects appear in the `object`, `result`, or `target` fields.

| Type         | Use                                  | Key fields              |
|--------------|--------------------------------------|-------------------------|
| `Document`   | A file in the workspace              | `url` (relative path)   |
| `Collection` | A set of files                       | `items` (array of objects) |
| `Note`       | Free-text content                    | `content`               |
| `Article`    | Longer structured content            | `content`, `name`       |

## Field reference

| Field        | Type             | Description                                        |
|--------------|------------------|----------------------------------------------------|
| `type`       | string           | AS2 activity or object type (required)              |
| `actor`      | string           | Agent name of the sender                            |
| `summary`    | string           | One-line human-readable description                 |
| `object`     | object or string | The thing being acted on (task spec, file, etc.)    |
| `target`     | string           | Recipient agent name or channel                     |
| `result`     | object           | Outcome of the activity                             |
| `instrument` | string or array  | Tools or methods used                               |
| `context`    | string           | Task ID or thread reference for correlation         |
| `tag`        | array            | Labels: priority, language, framework               |

## Task ID convention

Use `context` to correlate messages in a task thread. The admin generates a
task ID when sending an `Offer`. All subsequent messages about that task
include the same `context` value.

Format: `urn:porter:task:<short-id>` where `<short-id>` is a short random
string (e.g. `urn:porter:task:a3f9`).

## Tool-to-AS2 Mapping

The tool handlers translate between the individual tools agents use and the
AS2 activity types documented above. This mapping is transparent — agents
send and receive plain text via `send_message` and `read_messages`.

| Tool             | Agent Calls                                    | AS2 Activity         |
|------------------|------------------------------------------------|----------------------|
| `bash`           | `bash({command: "..."})`                       | `Invoke`             |
| `read_file`      | `read_file({path: "..."})`                     | (internal read)      |
| `write_file`     | `write_file({path: "...", content: "..."})`    | `Create`             |
| `edit_file`      | `edit_file({path: "...", ...})`                | `Update`             |
| `send_message`   | `send_message({channel: "task:...", ...})`     | `Offer`              |
| `send_message`   | `send_message({channel: "log", ...})`          | `Announce`           |
| `read_messages`  | `read_messages()`                              | (internal drain)     |
| `memory_write`   | `memory_write({about: "...", finding: "..."})`  | `Remember`           |
| `memory_query`   | `memory_query({sparql: "..."})`                | `Recall`             |

Agents call individual tools with flat schemas; the system records full AS2
activities in the message log and knowledge graph.

## Examples

### Admin assigns a task

```json
{
  "type": "Offer",
  "actor": "architect",
  "summary": "Add GET /users endpoint",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Note",
    "content": "Add a GET /users endpoint to the API router. Return JSON array of User objects from the database. Include pagination via ?page=&limit= query params."
  },
  "target": "worker-backend",
  "tag": ["api", "backend"]
}
```

### Worker accepts

```json
{
  "type": "Accept",
  "actor": "worker-backend",
  "summary": "Starting work on GET /users",
  "context": "urn:porter:task:a3f9"
}
```

### Worker invokes a command

```json
{
  "type": "Invoke",
  "actor": "worker-backend",
  "summary": "Running database migration",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Note",
    "content": "deno task db:migrate"
  },
  "result": {
    "type": "Note",
    "content": "Migration complete: added users table"
  },
  "instrument": ["bash"]
}
```

### Worker creates files

```json
{
  "type": "Create",
  "actor": "worker-backend",
  "summary": "Added /users route and handler",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Collection",
    "items": [
      {"type": "Document", "url": "src/routes/users.ts", "summary": "Route handler"},
      {"type": "Document", "url": "src/models/user.ts", "summary": "User type definition"}
    ]
  },
  "instrument": ["file"]
}
```

### Worker stores knowledge

```json
{
  "type": "Remember",
  "actor": "worker-backend",
  "summary": "Recording API design decision",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Note",
    "about": "api-design",
    "content": "GET /users returns paginated JSON with {data, page, limit, total} envelope"
  }
}
```

### Admin queries knowledge

```json
{
  "type": "Recall",
  "actor": "architect",
  "summary": "Checking API decisions",
  "object": {
    "type": "Note",
    "content": "SELECT ?about ?finding WHERE { ?obs <https://porter.chapeaux.io/vocab#about> ?about ; <https://porter.chapeaux.io/vocab#finding> ?finding } LIMIT 10"
  }
}
```

### Worker requests review

```json
{
  "type": "Offer",
  "actor": "worker-backend",
  "summary": "Ready for review: GET /users endpoint",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Collection",
    "items": [
      {"type": "Document", "url": "src/routes/users.ts"},
      {"type": "Document", "url": "src/models/user.ts"}
    ]
  },
  "target": "reviewer"
}
```

### Reviewer gives feedback

```json
{
  "type": "Reject",
  "actor": "reviewer",
  "summary": "Missing input validation on pagination params",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Note",
    "content": "The ?limit= param accepts any value including negative numbers. Add validation: limit must be 1-100, page must be >= 1. Also add a test for invalid query params."
  },
  "tag": ["validation", "testing"]
}
```

### Worker updates after feedback

```json
{
  "type": "Update",
  "actor": "worker-backend",
  "summary": "Added pagination validation and tests",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Collection",
    "items": [
      {"type": "Document", "url": "src/routes/users.ts", "summary": "Added validation"},
      {"type": "Document", "url": "tests/users.test.ts", "summary": "Pagination edge cases"}
    ]
  }
}
```

### Reviewer approves

```json
{
  "type": "Accept",
  "actor": "reviewer",
  "summary": "LGTM -- validation and tests look good",
  "context": "urn:porter:task:a3f9"
}
```

### Agent asks a question

```json
{
  "type": "Question",
  "actor": "worker-frontend",
  "summary": "Which auth library should I use?",
  "context": "urn:porter:task:b7c2",
  "object": {
    "type": "Note",
    "content": "The project has both jose and jsonwebtoken in package.json. Which one is preferred for JWT validation?"
  },
  "target": "architect"
}
```

### Status announcement

```json
{
  "type": "Announce",
  "actor": "worker-backend",
  "summary": "All tests passing",
  "context": "urn:porter:task:a3f9",
  "object": {
    "type": "Note",
    "content": "14 tests passing, 0 failures. Coverage: 87%."
  }
}
```

## System prompt integration

AS2 is handled transparently by the tool handlers. Agents do **not** need
AS2 instructions in their system prompts. The `send_message` tool wraps
outgoing plain text into AS2 envelopes, and `read_messages` unwraps incoming
AS2 back to plain text.

The agent system prompt includes a simple messaging section:

```
## Messaging
Use send_message to send messages to other agents or channels.
Use read_messages to check for incoming messages.
Channels: 'log' (status updates), 'task' (broadcast to workers),
'task:<agent-name>' (direct to a specific agent), 'review', 'control'.
```

The team roster is also injected so agents know their teammates by name and
role, and messages from `porter-ui` are identified as coming from the human
user.

## Channel mapping

The AS2 types map naturally to existing Porter bus channels:

| Channel          | Typical activities                              |
|------------------|-------------------------------------------------|
| `task`           | Offer, Accept, Reject, Question                 |
| `task:<agent>`   | Offer (direct assignment), Question             |
| `log`            | Announce, Create, Update, Invoke, Remember      |
| `control`        | system-level commands (non-AS2)                 |

## Fallback

If an agent receives a message that is not valid JSON, treat it as:

```json
{
  "type": "Note",
  "content": "<the raw message text>"
}
```

This ensures backward compatibility with plain-text messages.
