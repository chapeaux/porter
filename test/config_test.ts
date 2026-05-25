import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadConfig } from "../src/core/config.ts";

const TEST_DIR = await Deno.makeTempDir({ prefix: "porter-config-test-" });

Deno.test("loadConfig - loads valid config", async () => {
  const path = `${TEST_DIR}/valid.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      session: "test-session",
      working_dir: "/tmp/test",
      agents: [
        {
          name: "agent-1",
          role: "worker",
          system_prompt: "You are a test agent.",
          tools: ["read_file", "bash"],
        },
      ],
    }),
  );

  const config = await loadConfig(path);
  assertEquals(config.session, "test-session");
  assertEquals(config.working_dir, "/tmp/test");
  assertEquals(config.model, "claude-sonnet-4-6"); // default
  assertEquals(config.api_key_env, "ANTHROPIC_API_KEY"); // default
  assertEquals(config.heartbeat_timeout_ms, 120_000); // default
  assertEquals(config.agents.length, 1);
  assertEquals(config.agents[0].name, "agent-1");
  assertEquals(config.agents[0].tools.length, 2);
  assertEquals(config.agents[0].max_tokens, 8192); // default
});

Deno.test("loadConfig - applies overrides", async () => {
  const path = `${TEST_DIR}/overrides.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      session: "custom",
      model: "claude-opus-4-6",
      api_key_env: "MY_API_KEY",
      working_dir: "/workspace",
      heartbeat_timeout_ms: 60000,
      agents: [
        {
          name: "agent-1",
          role: "admin",
          system_prompt: "Admin agent.",
          tools: ["read_file"],
          max_tokens: 4096,
          subscribe: ["task"],
        },
      ],
    }),
  );

  const config = await loadConfig(path);
  assertEquals(config.model, "claude-opus-4-6");
  assertEquals(config.api_key_env, "MY_API_KEY");
  assertEquals(config.heartbeat_timeout_ms, 60000);
  assertEquals(config.agents[0].max_tokens, 4096);
  assertEquals(config.agents[0].subscribe, ["task"]);
});

Deno.test("loadConfig - rejects missing session", async () => {
  const path = `${TEST_DIR}/no_session.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      working_dir: "/tmp",
      agents: [{ name: "a", role: "worker", system_prompt: "x", tools: [] }],
    }),
  );

  await assertRejects(() => loadConfig(path), Error, "session");
});

Deno.test("loadConfig - rejects missing agents", async () => {
  const path = `${TEST_DIR}/no_agents.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      session: "test",
      working_dir: "/tmp",
      agents: [],
    }),
  );

  await assertRejects(() => loadConfig(path), Error, "agents");
});

Deno.test("loadConfig - rejects missing working_dir", async () => {
  const path = `${TEST_DIR}/no_dir.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      session: "test",
      agents: [{ name: "a", role: "worker", system_prompt: "x", tools: [] }],
    }),
  );

  await assertRejects(() => loadConfig(path), Error, "working_dir");
});

Deno.test("cleanup temp dir", async () => {
  await Deno.remove(TEST_DIR, { recursive: true });
});
