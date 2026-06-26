/**
 * Qdrant vector store client.
 *
 * Thin REST client using fetch — no npm dependencies.
 * Implements the VectorStore interface for pluggable backends.
 */

import type { PayloadFilter, ScoredPoint, VectorPoint, VectorStore } from "./mod.ts";

export class QdrantVectorStore implements VectorStore {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(url: string, apiKey?: string) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (apiKey) {
      this.headers["api-key"] = apiKey;
    }
  }

  async ensureCollection(collection: string, vectorSize: number): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/collections/${collection}`, {
      headers: this.headers,
    });

    if (resp.ok) {
      await resp.body?.cancel();
      return;
    }
    await resp.body?.cancel();

    const createResp = await fetch(`${this.baseUrl}/collections/${collection}`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({
        vectors: { size: vectorSize, distance: "Cosine" },
      }),
    });

    if (!createResp.ok) {
      const text = await createResp.text().catch(() => "");
      throw new Error(`Qdrant: failed to create collection '${collection}': ${createResp.status} ${text}`);
    }
    await createResp.body?.cancel();
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    const resp = await fetch(`${this.baseUrl}/collections/${collection}/points`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({
        points: points.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload,
        })),
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[qdrant] Upsert failed: ${resp.status} ${text}`);
    }
    await resp.body?.cancel();
  }

  async search(
    collection: string,
    vector: number[],
    filter?: PayloadFilter,
    limit = 5,
  ): Promise<ScoredPoint[]> {
    const body: Record<string, unknown> = {
      query: vector,
      limit,
      with_payload: true,
    };

    if (filter) {
      body.filter = buildQdrantFilter(filter);
    }

    const resp = await fetch(`${this.baseUrl}/collections/${collection}/points/query`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[qdrant] Search failed: ${resp.status} ${text}`);
      return [];
    }

    const data = await resp.json();
    const points = data.result?.points ?? data.points ?? [];
    return points.map((p: Record<string, unknown>) => ({
      id: String(p.id),
      score: p.score as number,
      payload: (p.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async healthy(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      await resp.body?.cancel();
      return resp.ok;
    } catch {
      return false;
    }
  }
}

function buildQdrantFilter(filter: PayloadFilter): Record<string, unknown> {
  const must: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === "number") {
      must.push({ key, range: { gte: value } });
    } else {
      must.push({ key, match: { value } });
    }
  }
  return { must };
}
