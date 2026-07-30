/**
 * Tests for providers/mod.ts — createProvider() factory routing.
 *
 * Covers the vertex_claude/vertex_gemini/vertex_ai dispatch logic, since a
 * models-corp-style Claude endpoint (hostname containing "claude", not
 * "anthropic") previously fell through to VertexGeminiProvider silently.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createProvider } from "../src/providers/mod.ts";
import type { ProviderConfig } from "../src/providers/types.ts";

const MODELS_CORP_CLAUDE_BASE_URL =
  "https://claude--apicast-production.apps.int.stc.ai.prod.us-east-1.aws.paas.redhat.com";

function withStubbedFetch(fn: (calls: { url: string }[]) => Promise<void>) {
  const calls: { url: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url });
    return Promise.resolve(
      new Response(JSON.stringify({ content: [], stop_reason: "end_turn", usage: {} }), {
        status: 200,
      }),
    );
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

Deno.test("createProvider: vertex_claude routes directly, no heuristic needed", async () => {
  const config: ProviderConfig = {
    type: "vertex_claude",
    base_url: MODELS_CORP_CLAUDE_BASE_URL,
    api_key: "test-user-key",
    tier: "sonnet",
  };
  const provider = createProvider(config);
  assertEquals(provider.name, "vertex_claude");

  await withStubbedFetch(async (calls) => {
    await provider.createMessage({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "test",
      messages: [{ role: "user", content: "hi" }],
    });
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].url, `${MODELS_CORP_CLAUDE_BASE_URL}/sonnet/models/claude-sonnet-4-6:streamRawPredict`);
  });
});

Deno.test("createProvider: vertex_ai with a models-corp-style claude hostname resolves to Claude, not Gemini", () => {
  const config: ProviderConfig = {
    type: "vertex_ai",
    base_url: MODELS_CORP_CLAUDE_BASE_URL,
    api_key: "test-user-key",
    // Note: no "models" array and no "anthropic" substring in base_url —
    // this is exactly the shape that previously fell through to Gemini.
  };
  const provider = createProvider(config);
  assertEquals(provider.name, "vertex_claude");
});

Deno.test("createProvider: vertex_ai with a real GCP anthropic publisher URL still resolves to Claude", () => {
  const config: ProviderConfig = {
    type: "vertex_ai",
    base_url: "https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/publishers/anthropic",
    auth: "adc",
  };
  const provider = createProvider(config);
  assertEquals(provider.name, "vertex_claude");
});

Deno.test("createProvider: vertex_ai with no claude/anthropic signal falls back to Gemini", () => {
  const config: ProviderConfig = {
    type: "vertex_ai",
    base_url: "https://gemini--apicast-production.example.com",
    api_key: "test-user-key",
  };
  const provider = createProvider(config);
  assertEquals(provider.name, "vertex_gemini");
});

Deno.test("createProvider: vertex_gemini routes directly", () => {
  const config: ProviderConfig = {
    type: "vertex_gemini",
    base_url: "https://gemini--apicast-production.example.com",
    api_key: "test-user-key",
  };
  const provider = createProvider(config);
  assertEquals(provider.name, "vertex_gemini");
});
