import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  saveSnapshot,
  loadSnapshot,
  restoreAgentStates,
  snapshotPath,
} from "../src/runtime/snapshot.ts";
import { serializeState, deserializeState } from "../src/runtime/agent.ts";
import type { AgentState } from "../src/runtime/agent.ts";

const TEST_DIR = await Deno.makeTempDir({ prefix: "porter-snapshot-test-" });

Deno.test("serializeState and deserializeState round trip", () => {
  const state: AgentState = {
    config: {
      name: "test-agent",
      role: "worker",
      system_prompt: "Test",
      tools: ["read_file"],
      subscribe: ["task"],
      max_tokens: 8192,
    },
    history: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
    running: true,
  };

  const json = serializeState(state);
  const restored = deserializeState(json);

  assertEquals(restored.config.name, "test-agent");
  assertEquals(restored.history.length, 2);
  assertEquals(restored.usage.input_tokens, 100);
  assertEquals(restored.running, false); // deserialize always sets running=false
});

Deno.test("saveSnapshot and loadSnapshot round trip", async () => {
  const agents = new Map<string, AgentState>();
  agents.set("agent-1", {
    config: {
      name: "agent-1",
      role: "worker",
      system_prompt: "Test",
      tools: ["bash"],
      subscribe: [],
      max_tokens: 8192,
    },
    history: [{ role: "user", content: "Do work" }],
    usage: { input_tokens: 200, output_tokens: 100 },
    running: false,
  });

  const path = `${TEST_DIR}/snapshot.json`;
  await saveSnapshot(path, "test-session", agents);

  const snapshot = await loadSnapshot(path);
  assertEquals(snapshot.session, "test-session");
  assertEquals(Object.keys(snapshot.agents).length, 1);
  assertEquals(snapshot.agents["agent-1"] !== undefined, true);
});

Deno.test("restoreAgentStates rebuilds state map", async () => {
  const agents = new Map<string, AgentState>();
  agents.set("a", {
    config: {
      name: "a",
      role: "admin",
      system_prompt: "Admin",
      tools: ["read_file"],
      subscribe: ["log"],
      max_tokens: 4096,
    },
    history: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    running: false,
  });
  agents.set("b", {
    config: {
      name: "b",
      role: "worker",
      system_prompt: "Worker",
      tools: ["bash"],
      subscribe: ["task"],
      max_tokens: 8192,
    },
    history: [{ role: "user", content: "test" }],
    usage: { input_tokens: 50, output_tokens: 25 },
    running: false,
  });

  const path = `${TEST_DIR}/multi_snapshot.json`;
  await saveSnapshot(path, "multi-session", agents);

  const snapshot = await loadSnapshot(path);
  const states = restoreAgentStates(snapshot);

  assertEquals(states.size, 2);
  assertEquals(states.get("a")!.config.role, "admin");
  assertEquals(states.get("b")!.usage.input_tokens, 50);
});

Deno.test("snapshotPath generates expected path", () => {
  // Phase 7: snapshotPath now uses the global ~/.porter/snapshots/<session>/latest.json
  // The workingDir argument is ignored (kept for backwards-compatibility).
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  const path = snapshotPath("my-session", "/workspace");
  assertEquals(path, `${home}/.porter/snapshots/my-session/latest.json`);
});

Deno.test("cleanup temp dir", async () => {
  await Deno.remove(TEST_DIR, { recursive: true });
});
