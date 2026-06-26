/**
 * Embedding providers for converting text to dense vectors.
 *
 * Auto-detects available providers from environment variables.
 * Supports Ollama (local), OpenAI, and any OpenAI-compatible endpoint.
 */

import type { EmbeddingProvider } from "./mod.ts";

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

const OLLAMA_MODEL = "nomic-embed-text";
const OLLAMA_DIMS = 768;

class OllamaEmbedding implements EmbeddingProvider {
  readonly name = `ollama/${OLLAMA_MODEL}`;
  readonly dimensions = OLLAMA_DIMS;

  constructor(private readonly host: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const resp = await fetch(`${this.host}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        throw new Error(`Ollama embed failed: ${resp.status} ${err}`);
      }
      const data = await resp.json();
      const embedding = data.embeddings?.[0] ?? data.embedding;
      if (!embedding) throw new Error("Ollama returned no embedding");
      results.push(embedding);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (covers OpenAI, Vertex AI embeddings, custom endpoints)
// ---------------------------------------------------------------------------

class OpenAICompatEmbedding implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    dims: number,
    providerName: string,
  ) {
    this.dimensions = dims;
    this.name = `${providerName}/${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new Error(`Embedding API failed: ${resp.status} ${err}`);
    }
    const data = await resp.json();
    return (data.data as Array<{ embedding: number[] }>)
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        (a.index as number) - (b.index as number))
      .map((d) => d.embedding);
  }
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

/**
 * Detect the best available embedding provider from environment variables.
 *
 * Priority:
 *   1. EMBEDDING_API + EMBEDDING_MODEL (explicit custom endpoint)
 *   2. Ollama at OLLAMA_HOST (local, no API key)
 *   3. OpenAI (OPENAI_API_KEY)
 *
 * Returns null if no provider is available.
 */
export async function detectEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  // 1. Explicit custom endpoint
  const embeddingApi = Deno.env.get("EMBEDDING_API");
  const embeddingModel = Deno.env.get("EMBEDDING_MODEL");
  if (embeddingApi && embeddingModel) {
    const dims = parseInt(Deno.env.get("EMBEDDING_DIMS") ?? "768");
    const apiKey = Deno.env.get("EMBEDDING_API_KEY") ?? "";
    return new OpenAICompatEmbedding(embeddingApi, embeddingModel, apiKey, dims, "custom");
  }

  // 2. Ollama (check if running and has the embedding model)
  const ollamaHost = Deno.env.get("OLLAMA_HOST") ?? "http://localhost:11434";
  try {
    const resp = await fetch(`${ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const models = (data.models ?? []) as Array<{ name: string }>;
      const hasEmbedModel = models.some((m) =>
        m.name.startsWith(OLLAMA_MODEL)
      );
      if (hasEmbedModel) {
        return new OllamaEmbedding(ollamaHost);
      }
    } else {
      await resp.body?.cancel();
    }
  } catch {
    // Ollama not running
  }

  // 3. OpenAI
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (openaiKey) {
    return new OpenAICompatEmbedding(
      "https://api.openai.com",
      "text-embedding-3-small",
      openaiKey,
      1536,
      "openai",
    );
  }

  return null;
}
