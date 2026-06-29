# Porter Ontology and Linked Data

Porter models its entire runtime state -- teams, agents, models, messages,
observations, and collaboration patterns -- as an RDF knowledge graph.  This
document describes the formal ontology, SHACL validation shapes, JSON-LD
contexts, and extension points.

## Namespace

| Prefix   | IRI |
|----------|-----|
| `porter` | `https://porter.chapeaux.io/vocab#` |
| `as`     | `https://www.w3.org/ns/activitystreams#` |
| `prov`   | `http://www.w3.org/ns/prov#` |
| `rdfs`   | `http://www.w3.org/2000/01/rdf-schema#` |
| `xsd`    | `http://www.w3.org/2001/XMLSchema#` |
| `sh`     | `http://www.w3.org/ns/shacl#` |
| `rdf`    | `http://www.w3.org/1999/02/22-rdf-syntax-ns#` |

All Porter-specific terms live under `https://porter.chapeaux.io/vocab#`.
Standard W3C vocabularies (ActivityStreams, PROV-O, RDFS, XSD, SHACL) are
reused where they already define the concept.

## Named Graphs

The store partitions data into purpose-specific named graphs:

| Graph constant      | IRI | Purpose |
|----------------------|-----|---------|
| `GRAPHS.config`     | `porter:graph/config`   | Team, Agent, and Model configuration |
| `GRAPHS.messages`   | `porter:graph/messages`  | Bus messages (AS2 Notes) |
| `GRAPHS.memory`     | `porter:graph/memory`    | Shared agent observations |
| `GRAPHS.metrics`    | `porter:graph/metrics`   | Token usage, API call counts |
| `GRAPHS.shapes`     | `porter:graph/shapes`    | SHACL shape definitions |
| `GRAPHS.patterns`   | `porter:graph/patterns`  | Collaboration pattern definitions |

## Classes

### porter:Team

A running session composed of agents. Created from a `PorterConfig`.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `as:name` | `xsd:string` | 1..1 | Session name (required, non-empty) |
| `porter:hasAgent` | `porter:Agent` | 1..* | At least one agent required |
| `porter:defaultModel` | `xsd:string` | 0..1 | Model id used when an agent does not specify one |
| `porter:workingDir` | `xsd:string` | 0..1 | Filesystem working directory |
| `porter:teamPattern` | `porter:Pattern` | 0..1 | Link to the collaboration pattern used |
| `porter:hasAgentRef` | (blank node) | 0..* | Reference-based agent slots (used in team JSON-LD) |
| `porter:startedAt` | `xsd:dateTime` | 0..1 | Session start timestamp |
| `porter:busPort` | `xsd:integer` | 0..1 | Port number for the message bus |
| `porter:fromTeam` | IRI | 0..1 | Parent team reference |

### porter:Agent

An LLM-backed agent that belongs to a team.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `as:name` | `xsd:string` | 1..1 | Unique agent name (required, non-empty) |
| `porter:hasRole` | `{"admin","worker","reviewer"}` | 1..1 | One of: `admin`, `worker`, `reviewer` |
| `porter:systemPrompt` | `xsd:string` | 1..* | System prompt text |
| `porter:usesModel` | `xsd:string` | 0..1 | Model id override |
| `porter:hasTool` | enumerated string | 0..* | Allowed tool names (see below) |
| `porter:subscribes` | `xsd:string` | 0..* | Bus channels the agent listens on |
| `porter:maxTokens` | `xsd:integer` | 0..1 | Max output tokens override |
| `porter:agentExpertise` | `xsd:string` | 0..1 | Domain expertise descriptor |
| `porter:agentUri` | IRI | 0..1 | Canonical URI for the agent |
| `porter:derivedFrom` | IRI | 0..1 | Agent this definition was derived from |
| `porter:linkedFrom` | IRI | 0..1 | External link source |
| `porter:visibility` | `xsd:string` | 0..1 | Visibility scope |

**Allowed tool names** (enforced by SHACL): `read_file`, `write_file`,
`edit_file`, `bash`, `glob`, `grep`, `list_dir`, `send_message`,
`read_messages`, `git`, `memory_write`, `memory_query`.

### porter:Model

An LLM model endpoint configuration.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `rdfs:label` | `xsd:string` | 1..* | Display name |
| `porter:providerType` | enumerated string | 1..1 | One of: `openai`, `openai_compat`, `azure_openai`, `anthropic`, `aws_bedrock`, `vertex_ai`, `groq`, `ollama` |
| `porter:baseUrl` | `xsd:string` | 1..1 | HTTP(S) URL (pattern-validated) |
| `porter:authMethod` | `{"bearer","adc","aws_iam"}` | 1..1 | Authentication method |
| `porter:contextWindow` | `xsd:integer` | 1..1 | Context window size (positive) |
| `porter:maxTokens` | `xsd:integer` | 1..1 | Max output tokens (positive) |
| `porter:apiKeyEnv` | `xsd:string` | 0..1 | Environment variable holding the API key |
| `porter:region` | `xsd:string` | 0..1 | Cloud region |
| `porter:apiVersion` | `xsd:string` | 0..1 | Provider API version |
| `porter:toolCalling` | `xsd:boolean` | 0..1 | Supports tool/function calling |
| `porter:reasoning` | `xsd:boolean` | 0..1 | Supports chain-of-thought reasoning |
| `porter:vision` | `xsd:boolean` | 0..1 | Supports image input |
| `porter:jsonMode` | `xsd:boolean` | 0..1 | Supports structured JSON output |
| `porter:pricingInputPerM` | `xsd:float` | 0..1 | Cost per 1M input tokens |
| `porter:pricingOutputPerM` | `xsd:float` | 0..1 | Cost per 1M output tokens |

### porter:Pattern

A collaboration pattern that defines how agents interact.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `porter:name` | `xsd:string` | 1..1 | Pattern name |
| `porter:description` | `xsd:string` | 0..1 | Human-readable description |
| `porter:busFlow` | `xsd:string` | 1..1 | Message flow DSL expression |
| `porter:hasRole` | `porter:PatternRole` | 1..* | At least one role definition |
| `porter:maxRounds` | `xsd:integer` | 0..1 | Iteration limit (e.g., deliberation rounds) |
| `porter:isBuiltin` | `xsd:boolean` | 0..1 | Whether the pattern ships with Porter |

Built-in patterns: **Sequential**, **Deliberation**, **Mixture**, **Distillation**.

### porter:PatternRole

A role slot within a pattern that agents fill at runtime.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `porter:roleId` | `xsd:string` | 1..1 | Identifier (e.g., `worker`, `reflector`) |
| `porter:name` | `xsd:string` | 1..1 | Display name |
| `porter:description` | `xsd:string` | 0..1 | What this role does |
| `porter:minCount` | `xsd:integer` | 1..1 | Minimum agents in this role |
| `porter:maxCount` | `xsd:integer` | 1..1 | Maximum agents in this role |
| `porter:systemPromptSuffix` | `xsd:string` | 0..1 | Text appended to agent system prompts |
| `porter:autoTool` | `xsd:string` | 0..* | Tools injected automatically |
| `porter:subscribeDynamic` | `xsd:string` | 0..1 | Dynamic channel subscription template |
| `porter:defaultTool` | `xsd:string` | 0..* | Default tool set for agents in this role |

### porter:Observation

A piece of shared agent memory stored in the memory graph.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `porter:about` | `xsd:string` | 1..* | Subject of the observation |
| `porter:finding` | `xsd:string` | 1..* | The observation text |
| `porter:discoveredBy` | `porter:Agent` | 1..* | Agent that created the observation |
| `porter:severity` | `{"info","low","medium","high","critical"}` | 0..1 | Severity level |
| `prov:generatedAtTime` | `xsd:dateTime` | 0..1 | Timestamp |

### porter:McpServer

An MCP (Model Context Protocol) server endpoint.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `porter:mcpUrl` | `xsd:string` | 0..1 | Server URL |
| `porter:mcpCommand` | `xsd:string` | 0..1 | Command to launch the server |
| `porter:transport` | `xsd:string` | 0..1 | Transport type |
| `porter:authType` | `xsd:string` | 0..1 | Authentication type |
| `porter:tokenEnv` | `xsd:string` | 0..1 | Env var holding auth token |

### porter:FederationConfig

Configuration for ActivityPub federation.

| Property | Range | Card. | Notes |
|----------|-------|-------|-------|
| `porter:approvalMode` | `xsd:string` | 0..1 | How follow requests are handled |
| `porter:allowlistEntry` | `xsd:string` | 0..* | Allowed remote actors |
| `porter:publicSummaries` | `xsd:boolean` | 0..1 | Whether summaries are publicly visible |

### Collaboration Classes

These classes support the graph-tracked collaboration patterns:

| Class | Purpose |
|-------|---------|
| `porter:Finding` | Domain-specific finding from a specialist (Mixture pattern) |
| `porter:Critique` | Review critique from a reflector (Deliberation pattern) |
| `porter:PlanStep` | A step in an expert's plan (Distillation pattern) |
| `porter:StepStatus` | Execution status of a plan step |
| `porter:Session` | A running Porter session |
| `porter:Provider` | An LLM provider (parent concept for Model) |
| `porter:Tool` | A tool definition |
| `porter:TaskThread` | A thread of task execution |
| `porter:ErrorEvent` | A recorded error |

**Collaboration properties:**

| Property | Range | Notes |
|----------|-------|-------|
| `porter:domain` | `xsd:string` | Specialist domain name |
| `porter:confidence` | `xsd:float` | Confidence score for a finding |
| `porter:round` | `xsd:integer` | Deliberation round number |
| `porter:approved` | `xsd:boolean` | Whether work was approved |
| `porter:stepOrder` | `xsd:integer` | Ordering of plan steps |
| `porter:stepState` | `xsd:string` | Current state of a plan step |
| `porter:addresses` | IRI | What a critique or response addresses |

### Metrics Properties

Token usage and call count tracking stored in `GRAPHS.metrics`:

| Property | Range | Notes |
|----------|-------|-------|
| `porter:inputTokens` | `xsd:integer` | Input tokens consumed |
| `porter:outputTokens` | `xsd:integer` | Output tokens generated |
| `porter:apiCalls` | `xsd:integer` | Number of LLM API calls |
| `porter:toolCalls` | `xsd:integer` | Number of tool invocations |
| `porter:errorCount` | `xsd:integer` | Number of errors |
| `porter:retryCount` | `xsd:integer` | Number of retries |

### Message Properties (ActivityStreams Mapping)

Bus messages are serialized as `as:Note` instances in `GRAPHS.messages`:

| Property | Vocabulary | Notes |
|----------|------------|-------|
| `as:content` | ActivityStreams | Message body |
| `as:published` | ActivityStreams | ISO 8601 timestamp |
| `porter:channel` | Porter | Bus channel name |
| `porter:from` | Porter | Sender agent name |
| `porter:acknowledged` | Porter | Whether the message has been read |

## SHACL Validation

Porter validates configuration data at startup using SHACL shapes.  Two
shape files define the constraints:

### src/graph/shapes.ttl -- Core Shapes

Validates Team, Agent, Model, and Observation configuration:

- **porter:ModelShape** -- Ensures every Model has a display name, a valid
  provider type (one of eight providers), an HTTP(S) base URL (regex
  validated), an auth method, positive integer context window and max
  tokens.  Boolean capability flags (tool calling, reasoning, vision, JSON
  mode) are optional but single-valued.

- **porter:AgentShape** -- Ensures every Agent has a non-empty name, exactly
  one role from `{admin, worker, reviewer}`, at least one system prompt, and
  that any listed tools come from the allowed set.

- **porter:TeamShape** -- Ensures every Team has a non-empty name and at
  least one agent.

- **porter:ObservationShape** -- Ensures every Observation has an `about`
  subject, a `finding` text, a `discoveredBy` agent reference, and that
  severity (if present) is one of `{info, low, medium, high, critical}`.

### src/orchestration/patterns/pattern-shapes.ttl -- Pattern Shapes

Validates collaboration pattern definitions:

- **porter:PatternShape** -- Requires a name, bus flow expression, and at
  least one role.  Optional: description, max rounds, builtin flag.

- **porter:PatternRoleShape** -- Requires a role id, name, min count, and
  max count.  Optional: description, system prompt suffix.

### How Validation Runs

```typescript
import { validateConfig } from "./graph/validate.ts";

const result = await validateConfig(porterConfig);
if (!result.conforms) {
  for (const v of result.violations) {
    console.error(`${v.path}: ${v.message}`);
  }
}
```

The `validateConfig` function:

1. Creates a fresh `GraphStore` (which auto-loads `shapes.ttl`).
2. Converts the `PorterConfig` to RDF triples in `GRAPHS.config`.
3. Runs SHACL validation of the config graph against the shapes graph.
4. Returns a `ValidationResult` with `conforms: boolean` and a list of
   violations, each carrying `path`, `message`, and optional `value`.

Callers decide whether violations are fatal or advisory.

## JSON-LD Contexts

Porter provides three JSON-LD context files that map JSON property names to
ontology IRIs.  These enable content negotiation: clients requesting
`application/ld+json` receive data that can be expanded to full RDF.

### src/agents/context.jsonld -- Agent Context

Maps agent configuration fields:

```json
{
  "@context": {
    "porter": "https://porter.chapeaux.io/vocab#",
    "Agent": "porter:Agent",
    "name": "porter:name",
    "expertise": "porter:agentExpertise",
    "model": "porter:usesModel",
    "tools": { "@id": "porter:hasTool", "@container": "@set" },
    "reasoning": { "@id": "porter:reasoning", "@type": "xsd:boolean" },
    "maxTokens": { "@id": "porter:maxTokens", "@type": "xsd:integer" },
    "derivedFrom": { "@id": "porter:derivedFrom", "@type": "@id" },
    "linkedFrom": { "@id": "porter:linkedFrom", "@type": "@id" }
  }
}
```

Usage: reference from agent JSON-LD documents or include via HTTP `Link`
header as `rel="http://www.w3.org/ns/json-ld#context"`.

### src/teams/context.jsonld -- Team Context

Maps team composition fields.  Uses `@container: @set` for the agents
array and `@type: @id` for IRI-valued references:

```json
{
  "@context": {
    "Team": "porter:Team",
    "pattern": { "@id": "porter:teamPattern", "@type": "@id" },
    "agents": { "@id": "porter:hasAgentRef", "@container": "@set" },
    "ref": { "@id": "porter:agentRef", "@type": "@id" },
    "role": "porter:assignedRole"
  }
}
```

### src/orchestration/patterns/context.jsonld -- Pattern Context

Maps pattern definition fields.  Each built-in pattern (sequential,
deliberation, mixture, distillation) also has its own `.jsonld` file that
embeds this context and contains the full pattern definition as linked data.

```json
{
  "@context": {
    "Pattern": "porter:Pattern",
    "PatternRole": "porter:PatternRole",
    "busFlow": "porter:busFlow",
    "hasRole": { "@id": "porter:hasRole", "@container": "@set" },
    "autoTool": { "@id": "porter:autoTool", "@container": "@set" },
    "defaultTool": { "@id": "porter:defaultTool", "@container": "@set" }
  }
}
```

### Content Negotiation

When serving the ontology over HTTP, use the `Accept` header to select the
response format:

| Accept | Response |
|--------|----------|
| `text/turtle` | Turtle serialization of the ontology |
| `application/ld+json` | JSON-LD with the appropriate context |
| `application/n-triples` | N-Triples dump from the store |
| `text/html` | Human-readable documentation |

The JSON-LD context files can be served at stable URLs and referenced via
`Link` headers, enabling clients to resolve compact IRIs without embedding
the full context in every response.

## Internationalization (i18n)

At present, no translation files exist in the repository.  The ontology is
designed to support i18n through standard RDF language tagging.

### How Translations Work

RDF supports language-tagged literals natively.  To add translations for
ontology labels and descriptions, create Turtle files that attach
`@lang`-tagged `rdfs:label` and `rdfs:comment` values to existing class
and property IRIs:

```turtle
@prefix porter: <https://porter.chapeaux.io/vocab#> .
@prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .

porter:Team
  rdfs:label "Equipo"@es ;
  rdfs:comment "Un equipo de agentes con IA que colaboran en una sesion."@es .

porter:Agent
  rdfs:label "Agente"@es ;
  rdfs:comment "Un agente respaldado por un modelo de lenguaje."@es .

porter:Model
  rdfs:label "Modelo"@es ;
  rdfs:comment "Configuracion de un punto de acceso a un modelo de lenguaje."@es .
```

### Adding a New Language

1. Create a file at `src/graph/i18n/<lang>.ttl` (e.g., `src/graph/i18n/ja.ttl`).
2. Use the `porter:` prefix and attach `rdfs:label` and `rdfs:comment`
   triples with the appropriate `@lang` tag to each class and property IRI.
3. Load the file into the graph store at startup:

   ```typescript
   const i18nPath = new URL("./i18n/ja.ttl", import.meta.url);
   const i18nText = await Deno.readTextFile(i18nPath);
   store.load(i18nText, GRAPHS.config);
   ```

4. Query for translated labels using a SPARQL `FILTER(lang(?label) = "ja")`
   clause.

## TypeScript Constants (vocabulary.ts)

The file `src/graph/vocabulary.ts` exports all ontology terms as plain
string constants, organized into objects by vocabulary:

| Export | Contents |
|--------|----------|
| `RDF` | `rdf:type` |
| `RDFS` | `rdfs:label`, `rdfs:comment` |
| `XSD` | `xsd:string`, `xsd:integer`, `xsd:boolean`, `xsd:float`, `xsd:dateTime` |
| `AS` | ActivityStreams activity types, object types, and properties |
| `PROV` | `prov:Entity`, `prov:generatedAtTime`, `prov:wasGeneratedBy`, `prov:wasAttributedTo` |
| `PORTER` | All Porter-specific classes and properties |
| `PREFIXES` | Namespace prefix map for SPARQL and Turtle serialization |
| `GRAPHS` | Named graph URI constants |

Usage in converters and tools:

```typescript
import { PORTER, RDF, GRAPHS } from "./graph/vocabulary.ts";

store.addTriple(uri, RDF.type, PORTER.Agent, GRAPHS.config);
store.addLiteral(uri, PORTER.hasRole, "worker", GRAPHS.config);
```

## Extending the Ontology

### Adding a New Class

1. **vocabulary.ts** -- Add the class IRI to the `PORTER` object:

   ```typescript
   MyNewClass: `${NS}MyNewClass`,
   ```

2. **shapes.ttl** -- Add a SHACL shape if the class carries required
   properties:

   ```turtle
   porter:MyNewClassShape a sh:NodeShape ;
     sh:targetClass porter:MyNewClass ;
     sh:property [
       sh:path porter:someProperty ;
       sh:minCount 1 ;
       sh:datatype xsd:string ;
       sh:message "MyNewClass must have someProperty"
     ] .
   ```

3. **converters.ts** -- Add `toTriples` / `triplesToX` functions following
   the existing pattern for Model, Agent, and Observation.

4. **context.jsonld** -- If the class will be served as JSON-LD, add
   mappings to the appropriate context file or create a new one.

### Adding a New Property

1. Add the property IRI to `PORTER` in `vocabulary.ts`.
2. If it has validation constraints, add an `sh:property` block to the
   relevant shape in `shapes.ttl`.
3. Update the converter functions to read/write the property.

### Adding a New Collaboration Pattern

1. Create a `.jsonld` file in `src/orchestration/patterns/` following the
   structure of the existing patterns (deliberation, mixture, distillation,
   sequential).
2. Define the pattern's `@id`, name, description, bus flow, and roles.
3. If the pattern introduces new role behaviors, add any new tool names or
   properties to `vocabulary.ts` and `shapes.ttl`.

### Adding a New Named Graph

1. Add the graph IRI to the `GRAPHS` object in `vocabulary.ts`:

   ```typescript
   export const GRAPHS = {
     // ...existing...
     myGraph: `${NS}graph/myGraph`,
   } as const;
   ```

2. Use the new constant when loading, querying, or dumping data.

## URI Patterns

Porter generates URIs for runtime entities using the namespace and
type-based path segments:

| Entity | URI Pattern |
|--------|-------------|
| Model | `porter:model/{id}` |
| Agent | `porter:agent/{name}` |
| Team | `porter:team/{session}` |
| Message | `porter:msg/{uuid}` |
| Observation | `porter:obs/{uuid}` |
| Pattern | `porter:pattern/{id}` |

All identifiers are URI-encoded via `encodeURIComponent`.

## Reused W3C Vocabularies

Porter deliberately reuses standard vocabularies rather than reinventing
terms:

- **ActivityStreams 2.0** (`as:`) -- Agent names (`as:name`), message
  content (`as:content`), timestamps (`as:published`), and the full
  ActivityPub actor model (inbox, outbox, followers, following) for
  federation.

- **PROV-O** (`prov:`) -- Provenance tracking for observations
  (`prov:generatedAtTime`, `prov:wasAttributedTo`).

- **RDFS** (`rdfs:`) -- Display labels (`rdfs:label`) and descriptions
  (`rdfs:comment`).

- **SHACL** (`sh:`) -- Declarative constraint validation.

This alignment means Porter data can interoperate with any system that
understands these W3C standards.
