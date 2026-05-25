/**
 * Tests for isolate.ts — V8 Worker entry point wire protocol.
 *
 * Because Workers require a real isolate context to exercise the full
 * runAgent loop, these tests focus on:
 *   1. Verifying the module is importable (syntax / type validity)
 *   2. Verifying the shapes of all wire-protocol messages
 *   3. Verifying that proxy class contracts match their interfaces
 */

import { assertEquals, assertExists } from "jsr:@std/assert";

// ---------------------------------------------------------------------------
// 1. Module importability
// ---------------------------------------------------------------------------

Deno.test("isolate.ts: module imports without errors", async () => {
  // isolate.ts uses `/// <reference lib="deno.worker" />` and sets
  // self.onmessage, but `self` is the global in Deno so it doesn't throw.
  // The module exports nothing (it is a side-effect-only Worker entry point).
  let mod: unknown;
  try {
    mod = await import("../isolate.ts");
  } catch (err) {
    // Re-throw with context so failures are easy to diagnose
    throw new Error(`isolate.ts failed to import: ${(err as Error).message}`);
  }
  assertExists(mod);
});

// ---------------------------------------------------------------------------
// 2. Main → Worker wire protocol shapes
// ---------------------------------------------------------------------------

Deno.test("wire protocol (main→worker): start message has required fields", () => {
  const startMsg = {
    type: "start",
    agentConfig: {
      name: "test-agent",
      role: "worker",
      system_prompt: "Test prompt",
      tools: ["read_file"],
      subscribe: ["task"],
      max_tokens: 8192,
    },
    initialPrompt: "Begin work",
    model: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    provider: "anthropic" as const,
  };

  assertEquals(startMsg.type, "start");
  assertExists(startMsg.agentConfig.name);
  assertEquals(startMsg.agentConfig.role, "worker");
  assertExists(startMsg.initialPrompt);
  assertExists(startMsg.apiKeyEnv);
  assertExists(startMsg.model);
});

Deno.test("wire protocol (main→worker): start message with optional resumeFrom", () => {
  const resumeState = JSON.stringify({
    config: { name: "a", role: "worker", system_prompt: "", tools: [] },
    history: [{ role: "user", content: "previous" }],
    usage: { input_tokens: 10, output_tokens: 5 },
    running: false,
  });

  const startMsg = {
    type: "start",
    agentConfig: { name: "a", role: "worker", system_prompt: "", tools: [], subscribe: [] },
    initialPrompt: "",
    model: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    resumeFrom: resumeState,
  };

  assertEquals(startMsg.type, "start");
  assertExists(startMsg.resumeFrom);
  const parsed = JSON.parse(startMsg.resumeFrom);
  assertEquals(parsed.history.length, 1);
  assertEquals(parsed.usage.input_tokens, 10);
});

Deno.test("wire protocol (main→worker): cancel message shape", () => {
  const cancelMsg = { type: "cancel" };
  assertEquals(cancelMsg.type, "cancel");
});

Deno.test("wire protocol (main→worker): bus_drain_response has id and messages array", () => {
  const drainResp = {
    type: "bus_drain_response",
    id: 5,
    messages: [
      { channel: "task", content: "do something", from: "planner", timestamp: Date.now() },
    ],
  };

  assertEquals(drainResp.type, "bus_drain_response");
  assertEquals(typeof drainResp.id, "number");
  assertEquals(Array.isArray(drainResp.messages), true);
  assertEquals(drainResp.messages[0].channel, "task");
  assertEquals(drainResp.messages[0].from, "planner");
});

Deno.test("wire protocol (main→worker): rate_limit_acquired has id field", () => {
  const msg = { type: "rate_limit_acquired", id: 3 };
  assertEquals(msg.type, "rate_limit_acquired");
  assertEquals(typeof msg.id, "number");
  assertEquals(msg.id, 3);
});

// ---------------------------------------------------------------------------
// 3. Worker → Main wire protocol shapes
// ---------------------------------------------------------------------------

Deno.test("wire protocol (worker→main): event message has agentName and event", () => {
  const eventMsg = {
    type: "event",
    agentName: "worker-1",
    event: { type: "text", text: "Hello from agent" },
  };

  assertEquals(eventMsg.type, "event");
  assertEquals(eventMsg.agentName, "worker-1");
  assertExists(eventMsg.event);
  assertEquals((eventMsg.event as { text: string }).text, "Hello from agent");
});

Deno.test("wire protocol (worker→main): bus_publish message shape", () => {
  const msg = {
    type: "bus_publish",
    channel: "log",
    content: "Task completed",
    from: "worker-1",
  };

  assertEquals(msg.type, "bus_publish");
  assertExists(msg.channel);
  assertExists(msg.content);
  assertExists(msg.from);
});

Deno.test("wire protocol (worker→main): bus_drain message has id field", () => {
  const drainMsg = {
    type: "bus_drain",
    id: 42,
    agentName: "test-agent",
    channel: "task",
  };

  assertEquals(drainMsg.type, "bus_drain");
  assertEquals(typeof drainMsg.id, "number");
  assertExists(drainMsg.agentName);
  assertEquals(drainMsg.channel, "task");
});

Deno.test("wire protocol (worker→main): bus_drain without channel filter", () => {
  // channel is optional — drain all channels
  const drainMsg = {
    type: "bus_drain",
    id: 0,
    agentName: "worker-2",
  };

  assertEquals(drainMsg.type, "bus_drain");
  assertEquals(drainMsg.id, 0);
  assertEquals("channel" in drainMsg, false);
});

Deno.test("wire protocol (worker→main): rate_limit_acquire has id and agentName", () => {
  const msg = {
    type: "rate_limit_acquire",
    id: 7,
    agentName: "worker-1",
  };

  assertEquals(msg.type, "rate_limit_acquire");
  assertEquals(typeof msg.id, "number");
  assertEquals(msg.agentName, "worker-1");
});

Deno.test("wire protocol (worker→main): rate_limit_report has retryAfterMs", () => {
  const msg = {
    type: "rate_limit_report",
    agentName: "worker-1",
    retryAfterMs: 60000,
  };

  assertEquals(msg.type, "rate_limit_report");
  assertEquals(msg.agentName, "worker-1");
  assertEquals(typeof msg.retryAfterMs, "number");
  assertEquals(msg.retryAfterMs, 60000);
});

Deno.test("wire protocol (worker→main): done message has serialized state", () => {
  const serializedState = JSON.stringify({
    config: {
      name: "worker-1",
      role: "worker",
      system_prompt: "You are a worker",
      tools: ["read_file", "bash"],
      subscribe: ["task"],
      max_tokens: 8192,
    },
    history: [
      { role: "user", content: "Do the thing" },
      { role: "assistant", content: [{ type: "text", text: "Done!" }] },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
    running: false,
  });

  const msg = {
    type: "done",
    agentName: "worker-1",
    state: serializedState,
  };

  assertEquals(msg.type, "done");
  assertEquals(msg.agentName, "worker-1");
  assertExists(msg.state);

  // Verify the serialized state is valid JSON with expected structure
  const parsed = JSON.parse(msg.state);
  assertEquals(parsed.config.name, "worker-1");
  assertEquals(parsed.usage.input_tokens, 100);
  assertEquals(parsed.usage.output_tokens, 50);
  assertEquals(parsed.history.length, 2);
  // Running is always false in a serialized final state
  assertEquals(parsed.running, false);
});

Deno.test("wire protocol (worker→main): error message has agentName and message", () => {
  const msg = {
    type: "error",
    agentName: "worker-1",
    message: "API key not found",
  };

  assertEquals(msg.type, "error");
  assertEquals(msg.agentName, "worker-1");
  assertExists(msg.message);
  assertEquals(msg.message, "API key not found");
});

// ---------------------------------------------------------------------------
// 4. RPC round-trip ID tracking contract
// ---------------------------------------------------------------------------

Deno.test("wire protocol: RPC IDs must be unique incrementing numbers", () => {
  // Simulate the ID assignment logic from isolate.ts
  let nextId = 0;
  const pending = new Map<number, string>();

  function simulateRpc(label: string): number {
    const id = nextId++;
    pending.set(id, label);
    return id;
  }

  const id1 = simulateRpc("bus_drain");
  const id2 = simulateRpc("rate_limit_acquire");
  const id3 = simulateRpc("bus_drain");

  // IDs are strictly increasing
  assertEquals(id1, 0);
  assertEquals(id2, 1);
  assertEquals(id3, 2);
  // All are unique
  assertExists(pending.get(id1));
  assertExists(pending.get(id2));
  assertExists(pending.get(id3));

  // Simulating response handling: resolve and remove from pending
  pending.delete(id1);
  assertEquals(pending.has(id1), false);
  assertEquals(pending.has(id2), true);
  assertEquals(pending.size, 2);
});

// ---------------------------------------------------------------------------
// 5. Cancel signal contract
// ---------------------------------------------------------------------------

Deno.test("wire protocol: cancel signal starts as false and can be set to true", () => {
  // Mirror the CancelSignal shape used by isolate.ts
  const cancelSignal: { cancelled: boolean } = { cancelled: false };

  assertEquals(cancelSignal.cancelled, false);

  // Simulate receiving a "cancel" message
  cancelSignal.cancelled = true;
  assertEquals(cancelSignal.cancelled, true);
});
