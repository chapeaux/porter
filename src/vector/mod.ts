/**
 * Vector store module — pluggable vector database for embedding-level
 * agent coordination.
 *
 * Optional: Porter works without a vector store. When QDRANT_URL is
 * set and an embedding provider is available, pattern tools gain
 * semantic similarity search alongside existing SPARQL queries.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface ScoredPoint {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export type PayloadFilter = Record<string, string | number | boolean>;

export interface VectorStore {
  ensureCollection(collection: string, vectorSize: number): Promise<void>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(collection: string, vector: number[], filter?: PayloadFilter, limit?: number): Promise<ScoredPoint[]>;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Collection names
// ---------------------------------------------------------------------------

export const COLLECTIONS = {
  findings: "porter-findings",
  critiques: "porter-critiques",
  observations: "porter-observations",
} as const;

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let _vectorStore: VectorStore | null = null;
let _embedder: EmbeddingProvider | null = null;

export function getVectorStore(): VectorStore | null {
  return _vectorStore;
}

export function setVectorStore(store: VectorStore): void {
  _vectorStore = store;
}

export function getEmbedder(): EmbeddingProvider | null {
  return _embedder;
}

export function setEmbedder(embedder: EmbeddingProvider): void {
  _embedder = embedder;
}

/**
 * Initialize the vector store and embedding provider from environment.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 * Does nothing if QDRANT_URL is not set or no embedding provider is found.
 */
export async function initVectorStore(): Promise<void> {
  if (_vectorStore) return;

  const qdrantUrl = Deno.env.get("QDRANT_URL");
  if (!qdrantUrl) return;

  const { detectEmbeddingProvider } = await import("./embeddings.ts");
  const embedder = await detectEmbeddingProvider();
  if (!embedder) {
    console.error("[porter] Vector store: QDRANT_URL set but no embedding provider found — disabled");
    return;
  }

  const { QdrantVectorStore } = await import("./qdrant.ts");
  const apiKey = Deno.env.get("QDRANT_API_KEY");
  const store = new QdrantVectorStore(qdrantUrl, apiKey);

  const healthy = await (store as InstanceType<typeof QdrantVectorStore>).healthy();
  if (!healthy) {
    console.error(`[porter] Vector store: Qdrant at ${qdrantUrl} not reachable — disabled`);
    return;
  }

  // Ensure all collections exist
  for (const collection of Object.values(COLLECTIONS)) {
    try {
      await store.ensureCollection(collection, embedder.dimensions);
    } catch (err) {
      console.error(`[porter] Vector store: failed to create collection '${collection}': ${(err as Error).message}`);
      return;
    }
  }

  _vectorStore = store;
  _embedder = embedder;
  console.error(`[porter] Vector store: Qdrant at ${qdrantUrl}, embeddings: ${embedder.name} (${embedder.dimensions}d)`);
}

// ---------------------------------------------------------------------------
// Convenience: embed + upsert in one call
// ---------------------------------------------------------------------------

/**
 * Embed text and upsert to a collection. No-op if vector store is unavailable.
 */
export async function embedAndUpsert(
  collection: string,
  id: string,
  text: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!_vectorStore || !_embedder) return;
  try {
    const [vector] = await _embedder.embed([text]);
    await _vectorStore.upsert(collection, [{ id, vector, payload }]);
  } catch (err) {
    console.error(`[vector] embed+upsert failed: ${(err as Error).message}`);
  }
}

/**
 * Embed a query and search a collection. Returns empty if vector store is unavailable.
 */
export async function embedAndSearch(
  collection: string,
  query: string,
  filter?: PayloadFilter,
  limit = 5,
): Promise<ScoredPoint[]> {
  if (!_vectorStore || !_embedder) return [];
  try {
    const [vector] = await _embedder.embed([query]);
    return await _vectorStore.search(collection, vector, filter, limit);
  } catch (err) {
    console.error(`[vector] embed+search failed: ${(err as Error).message}`);
    return [];
  }
}
