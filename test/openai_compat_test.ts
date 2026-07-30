/**
 * Tests for providers/openai_compat.ts — extended-thinking opt-in.
 *
 * chat_template_kwargs is a vLLM convention models-corp documents for
 * Granite/Llama/gpt-oss ("thinking") and Qwen3 ("enable_thinking") alike —
 * this used to be hardcoded to fire only for Qwen-named models.
 */

import { assertEquals } from "@std/assert";
import { OpenAICompatProvider } from "../src/providers/openai_compat.ts";

function withStubbedFetch(fn: (bodies: Record<string, unknown>[]) => Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  return fn(bodies).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

const baseParams = {
  max_tokens: 100,
  system: "test",
  messages: [{ role: "user" as const, content: "hi" }],
};

Deno.test("openai_compat: reasoning enables chat_template_kwargs for Granite (thinking)", async () => {
  const provider = new OpenAICompatProvider("https://granite.example.com", "key");
  await withStubbedFetch(async (bodies) => {
    await provider.createMessage({ ...baseParams, model: "ibm-granite/granite-3.3-8b-instruct", reasoning: true });
    assertEquals(bodies[0].chat_template_kwargs, { thinking: true });
  });
});

Deno.test("openai_compat: reasoning enables chat_template_kwargs for Llama (thinking)", async () => {
  const provider = new OpenAICompatProvider("https://llama.example.com", "key");
  await withStubbedFetch(async (bodies) => {
    await provider.createMessage({ ...baseParams, model: "meta/llama-3.3-70b-instruct", reasoning: true });
    assertEquals(bodies[0].chat_template_kwargs, { thinking: true });
  });
});

Deno.test("openai_compat: reasoning uses enable_thinking for Qwen", async () => {
  const provider = new OpenAICompatProvider("https://qwen.example.com", "key");
  await withStubbedFetch(async (bodies) => {
    await provider.createMessage({ ...baseParams, model: "Qwen3-14B", reasoning: true });
    assertEquals(bodies[0].chat_template_kwargs, { enable_thinking: true });
  });
});

Deno.test("openai_compat: reasoning falsy omits chat_template_kwargs", async () => {
  const provider = new OpenAICompatProvider("https://granite.example.com", "key");
  await withStubbedFetch(async (bodies) => {
    await provider.createMessage({ ...baseParams, model: "ibm-granite/granite-3.3-8b-instruct", reasoning: false });
    assertEquals(bodies[0].chat_template_kwargs, undefined);
  });
});

Deno.test("openai_compat: reasoning ignored on overridden chat_endpoint (e.g. Gemini shim)", async () => {
  const provider = new OpenAICompatProvider(
    "https://gemini.example.com",
    "key",
    "/v1beta/openai/chat/completions",
  );
  await withStubbedFetch(async (bodies) => {
    await provider.createMessage({ ...baseParams, model: "gemini-3.5-flash", reasoning: true });
    assertEquals(bodies[0].chat_template_kwargs, undefined);
  });
});
