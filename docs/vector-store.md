# Vector Store Integration

Porter includes an optional vector store layer that adds semantic similarity
search to the mixture-of-agents coordination system. When enabled, pattern
tools automatically embed their outputs into a Qdrant vector database so that
agents can later retrieve related findings, critiques, and observations by
meaning rather than exact keyword match.

The vector store is **fully optional** -- Porter works without it. When
`QDRANT_URL` is not set, all vector operations silently no-op and agents
continue to coordinate through the SPARQL knowledge graph alone.

## Architecture

```
                +-----------------+
                | Pattern tools   |
                | finding_write   |
                | critique_write  |
                | memory_write    |
                +--------+--------+
                         |
              embedAndUpsert(collection, id, text, payload)
                         |
           +-------------+-------------+
           |                           |
   +-------v--------+        +--------v--------+
   | EmbeddingProvider|        |   VectorStore   |
   | (Ollama/OpenAI/ |        | (QdrantVector-  |
   |  custom)        |        |  Store)         |
   +-------+---------+        +--------+--------+
           |                           |
     embed(texts)               REST /collections/...
           |                           |
   +-------v--------+        +--------v--------+
   | Ollama / OpenAI |        |     Qdrant      |
   | / custom API    |        |  (port 6333)    |
   +----------------+        +-----------------+
```

Source files:

| File | Purpose |
|------|---------|
| `src/vector/mod.ts` | `VectorStore` and `EmbeddingProvider` interfaces, collection names, singleton management, `embedAndUpsert` / `embedAndSearch` helpers |
| `src/vector/qdrant.ts` | `QdrantVectorStore` REST client implementing `VectorStore` |
| `src/vector/embeddings.ts` | Auto-detection of embedding providers (Ollama, OpenAI, custom) |
| `src/tools/semantic_search.ts` | `semantic_search` MCP tool exposed to agents |

## Setup

### 1. Start Qdrant

Local development:

```bash
docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant:latest
```

### 2. Provide an embedding provider

Porter auto-detects the embedding provider at startup. The detection priority
is:

1. **Custom endpoint** -- set `EMBEDDING_API` + `EMBEDDING_MODEL`
2. **Ollama** -- local Ollama with `nomic-embed-text` model pulled
3. **OpenAI** -- set `OPENAI_API_KEY`

For Ollama (recommended for local dev):

```bash
ollama pull nomic-embed-text
```

### 3. Set environment variables

```bash
export QDRANT_URL=http://localhost:6333
# Qdrant API key (optional for local, required for hosted/production):
# export QDRANT_API_KEY=your-key
```

Porter calls `initVectorStore()` at startup. It checks `QDRANT_URL`, detects
an embedding provider, verifies Qdrant health via `GET /healthz`, and creates
all collections. If any step fails, the vector store is disabled with a log
message and Porter continues without it.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `QDRANT_URL` | Yes (to enable) | -- | Qdrant REST API base URL (e.g., `http://localhost:6333`) |
| `QDRANT_API_KEY` | No | -- | API key for Qdrant authentication |
| `EMBEDDING_API` | No | -- | Base URL of an OpenAI-compatible embeddings endpoint |
| `EMBEDDING_MODEL` | No | -- | Model name for the custom embedding endpoint |
| `EMBEDDING_DIMS` | No | `768` | Dimensionality of vectors from the custom endpoint |
| `EMBEDDING_API_KEY` | No | `""` | API key for the custom embedding endpoint |
| `OLLAMA_HOST` | No | `http://localhost:11434` | Ollama server URL |
| `OPENAI_API_KEY` | No | -- | OpenAI API key (enables `text-embedding-3-small`, 1536d) |

## Collections

Porter maintains three Qdrant collections, one per pattern-tool output type:

| Collection name | Populated by | Payload fields |
|-----------------|-------------|----------------|
| `porter-findings` | `finding_write` | `about`, `finding`, `domain`, `confidence`, `discoveredBy` |
| `porter-critiques` | `critique_write` | `issue`, `suggestion`, `round`, `discoveredBy` |
| `porter-observations` | `memory_write` | `about`, `finding`, `severity`, `discoveredBy` |

Collections are created automatically on startup via `ensureCollection()` with
the vector size matching the detected embedding provider (768 for Ollama
`nomic-embed-text`, 1536 for OpenAI `text-embedding-3-small`, or the value of
`EMBEDDING_DIMS` for custom endpoints). All collections use cosine distance.

## How Pattern Tools Embed Automatically

Each write tool (`finding_write`, `critique_write`, `memory_write`) follows
the same pattern:

1. Write the structured data to the SPARQL knowledge graph (triples).
2. Call `embedAndUpsert(collection, id, text, payload)` with a concatenated
   text representation of the record.

`embedAndUpsert` is a convenience wrapper in `src/vector/mod.ts` that:

- Returns immediately (no-op) if the vector store or embedder is not
  initialized.
- Embeds the text via the detected `EmbeddingProvider`.
- Upserts the resulting vector + payload into the Qdrant collection.
- Catches and logs errors without propagating them, so a vector-store outage
  never breaks the write path.

The text fed to the embedding model is a simple concatenation of the key
fields:

- **finding_write**: `"{about}: {finding}"`
- **critique_write**: `"{issue}: {suggestion}"`
- **memory_write**: `"{about}: {finding}"`

## semantic_search Tool

The `semantic_search` tool is exposed to agents as an MCP tool. It lets any
agent in the mixture search past findings, critiques, and observations by
natural-language similarity.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | -- | Natural language search query |
| `collection` | string | No | `"all"` | One of `findings`, `critiques`, `observations`, or `all` |
| `limit` | number | No | `5` | Maximum results to return |

### Behavior

- When `collection` is `"all"`, the tool searches all three collections in
  parallel, merges results, sorts by score descending, and returns the top
  `limit` results.
- Each result is formatted as a single line:
  `- [{source}] (score: {score}, by: {agent}) {text}`
- Returns an error message if the vector store is not available, prompting the
  user to set `QDRANT_URL`.

### Example

```
semantic_search({ query: "authentication bypass", collection: "findings", limit: 3 })

3 result(s) for "authentication bypass":

- [finding] (score: 0.892, by: security-specialist) auth/middleware.ts: JWT validation skips expiry check on refresh tokens
- [finding] (score: 0.847, by: security-specialist) auth/oidc.ts: redirect_uri not validated against allowlist
- [finding] (score: 0.803, by: architecture-specialist) auth/session.ts: session fixation possible after OIDC callback
```

## Pluggable Backend

The vector store uses a `VectorStore` interface defined in `src/vector/mod.ts`:

```typescript
interface VectorStore {
  ensureCollection(collection: string, vectorSize: number): Promise<void>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(collection: string, vector: number[], filter?: PayloadFilter, limit?: number): Promise<ScoredPoint[]>;
}
```

`QdrantVectorStore` is the current implementation. The interface is designed so
that alternative backends (e.g., Milvus) can be added by implementing the same
three methods and swapping the constructor in `initVectorStore()`.

The `EmbeddingProvider` interface is similarly pluggable:

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly name: string;
}
```

## Qdrant REST Client

`QdrantVectorStore` in `src/vector/qdrant.ts` is a thin REST client built on
`fetch` with no npm dependencies. It implements:

| Method | Qdrant endpoint | Purpose |
|--------|-----------------|---------|
| `ensureCollection()` | `GET /collections/{name}`, `PUT /collections/{name}` | Check if collection exists; create with cosine distance if not |
| `upsert()` | `PUT /collections/{name}/points` | Batch upsert points with vectors and payloads |
| `search()` | `POST /collections/{name}/points/query` | Vector similarity search with optional payload filters |
| `healthy()` | `GET /healthz` | Health check with 3-second timeout |

Payload filters use Qdrant's `must` clause: string/boolean fields get
`match: { value }` conditions; numeric fields get `range: { gte: value }`
conditions.

## OpenShift Deployment

The file `deploy/qdrant.yaml` provides a Kubernetes/OpenShift manifest for
Qdrant:

- **Deployment**: Single replica of `qdrant/qdrant:latest` with ephemeral
  `emptyDir` storage. Vectors are derived data rebuilt each session, so
  persistence is not required.
- **Service**: Exposes ports 6333 (HTTP REST) and 6334 (gRPC).
- **Resources**: Requests 100m CPU / 256Mi memory, limits 500m CPU / 512Mi.
- **Health checks**: Liveness and readiness probes on `GET /healthz:6333`.

The template uses `${NAMESPACE}` as a placeholder. Deploy with:

```bash
NAMESPACE=porter-dev envsubst < deploy/qdrant.yaml | oc apply -f -
```

Set `QDRANT_URL` in the Porter deployment to point at the in-cluster service:

```bash
QDRANT_URL=http://porter-qdrant.${NAMESPACE}.svc.cluster.local:6333
```

## Startup Sequence

`initVectorStore()` runs during Porter boot and follows this sequence:

1. Check `QDRANT_URL` -- return immediately if not set.
2. Call `detectEmbeddingProvider()` to find a working embedder.
3. Construct `QdrantVectorStore` and call `healthy()` to verify connectivity.
4. Call `ensureCollection()` for each of the three collections.
5. Store the singleton references via `setVectorStore()` and `setEmbedder()`.
6. Log the provider name and dimensionality.

If any step fails, the vector store is disabled and Porter logs the reason.
Subsequent calls to `initVectorStore()` are no-ops (idempotent).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `QDRANT_URL set but no embedding provider found` | No Ollama/OpenAI/custom endpoint available | Pull `nomic-embed-text` in Ollama, or set `OPENAI_API_KEY`, or configure `EMBEDDING_API` + `EMBEDDING_MODEL` |
| `Qdrant at ... not reachable` | Qdrant not running or wrong URL | Verify the Qdrant container is up and the URL is correct |
| `failed to create collection` | Qdrant permissions or version mismatch | Check Qdrant logs; verify API key if authentication is enabled |
| `Vector store not available` (from `semantic_search`) | Vector store did not initialize | Check startup logs for the reason; ensure `QDRANT_URL` and an embedding provider are configured |
| `embed+upsert failed` / `embed+search failed` | Embedding provider error | Check Ollama/OpenAI connectivity and model availability |
