/**
 * Tests for providers/vertex_claude.ts — prompt caching parity with anthropic.ts.
 */

import { assertEquals } from "@std/assert";
import { VertexClaudeProvider } from "../src/providers/vertex_claude.ts";

function withStubbedFetch(fn: (bodies: Record<string, unknown>[]) => Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  return fn(bodies).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

Deno.test("vertex_claude: system block carries ephemeral cache_control", async () => {
  const provider = new VertexClaudeProvider("https://claude.example.com", "key", "sonnet");
  await withStubbedFetch(async (bodies) => {
    await provider.createMessage({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hi" }],
    });
    assertEquals(bodies[0].system, [
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
  });
});

Deno.test("vertex_claude: last tool definition carries ephemeral cache_control", async () => {
  const provider = new VertexClaudeProvider("https://claude.example.com", "key", "sonnet");
  await withStubbedFetch(async (bodies) => {
    await provider.createMessage({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "tool_a", description: "a", input_schema: { type: "object", properties: {} } },
        { name: "tool_b", description: "b", input_schema: { type: "object", properties: {} } },
      ],
    });
    const tools = bodies[0].tools as Record<string, unknown>[];
    assertEquals(tools.length, 2);
    assertEquals(tools[0].cache_control, undefined);
    assertEquals(tools[1].cache_control, { type: "ephemeral" });
  });
});
