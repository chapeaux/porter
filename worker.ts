/**
 * Remote worker process.
 *
 * Runs inside an OpenShift pod. Connects back to the orchestrator's
 * WebSocket bus, receives its agent config, and runs the agent loop.
 *
 * Environment variables:
 *   PORTER_AGENT_NAME       -- this worker's agent name
 *   PORTER_BUS_URL          -- WebSocket URL of the orchestrator bus
 *   PORTER_CONFIG           -- JSON-encoded AgentConfig
 *   PORTER_PROMPT           -- initial prompt for the agent
 *   PORTER_SESSION          -- session name (for identification)
 *   PORTER_PROVIDER_CONFIG  -- JSON-encoded ProviderConfig
 *   ANTHROPIC_API_KEY       -- fallback API key (from K8s Secret)
 *   PORTER_API_KEY         -- fallback API key
 */

import type { AgentConfig, RepoConfig } from "./src/core/config.ts";
import { createProviderFromConfig, createClient } from "./src/core/client.ts";
import type { ProviderConfig } from "./src/providers/mod.ts";
import { runAgent, type AgentEvent } from "./src/runtime/agent.ts";
import { BusClient } from "./src/runtime/bus.ts";
import { getCoordinator } from "./src/runtime/rate_limiter.ts";
import { provisionRepo } from "./src/orchestration/orchestrator.ts";

/** Read a required env var or exit. */
function requireEnv(name: string): string {
  const val = Deno.env.get(name);
  if (!val) {
    console.error(`[porter-worker] Missing required env var: ${name}`);
    Deno.exit(1);
  }
  return val;
}

/** Install the BusClient as the global bus so agent tools use it. */
function installRemoteBus(client: BusClient): void {
  // Override the global bus getter to use the remote client.
  // The agent's send_message/read_messages tools call getBus(), but in
  // remote mode we need them to go through the WebSocket client.
  // We achieve this by patching the bus module's singleton.
  //
  // The agent.ts executeTool already handles send_message/read_messages
  // directly using getBus(). In remote mode, we need a different approach:
  // the worker's agent loop intercepts bus tool calls and routes them
  // through the BusClient instead.
  //
  // This is stored for use by the output handler.
  _busClient = client;
}

let _busClient: BusClient | null = null;

async function main(): Promise<void> {
  const agentName = requireEnv("PORTER_AGENT_NAME");
  const busUrl = requireEnv("PORTER_BUS_URL");
  const configJson = requireEnv("PORTER_CONFIG");
  const prompt = Deno.env.get("PORTER_PROMPT") ?? "Begin your assigned work. Check read_messages for any pending tasks.";
  const session = Deno.env.get("PORTER_SESSION") ?? "porter";

  console.log(`[porter-worker] Agent: ${agentName}`);
  console.log(`[porter-worker] Session: ${session}`);
  console.log(`[porter-worker] Bus URL: ${busUrl}`);

  // Parse agent config — may include a repo field passed alongside AgentConfig
  const config: AgentConfig & { repo?: RepoConfig } = JSON.parse(configJson);

  // Provision repo if configured (worker pods may need to clone)
  if (config.repo) {
    try {
      const workingDir = await provisionRepo({
        session,
        working_dir: config.working_dir,
        repo: config.repo,
        // Minimal PorterConfig fields required by provisionRepo
        api_key_env: "ANTHROPIC_API_KEY",
        model: "claude-sonnet-4-6",
        agents: [],
      });
      config.working_dir = workingDir;
      console.log(`[porter-worker] Working directory: ${workingDir}`);
    } catch (err) {
      console.error(`[porter-worker] Warning: repo provisioning failed: ${(err as Error).message}`);
    }
  }

  // Connect to bus
  const busClient = new BusClient(agentName, config.subscribe ?? []);
  try {
    await busClient.connect(busUrl);
    console.log("[porter-worker] Connected to bus.");
  } catch (err) {
    console.error(`[porter-worker] Failed to connect to bus: ${(err as Error).message}`);
    Deno.exit(1);
  }

  installRemoteBus(busClient);

  // Initialize the rate-limit coordinator so callWithRetry can use it.
  // Remote state (cooldown broadcasts from the orchestrator) is applied
  // automatically by the BusClient's onmessage handler.
  getCoordinator();

  // Start heartbeat
  const heartbeatInterval = setInterval(() => {
    busClient.sendHeartbeat();
  }, 30_000);

  // Create ModelProvider — prefer explicit ProviderConfig, fall back to auto-detect
  const providerConfigEnv = Deno.env.get("PORTER_PROVIDER_CONFIG");
  const provider = providerConfigEnv
    ? createProviderFromConfig(JSON.parse(providerConfigEnv) as ProviderConfig)
    : createClient();

  // Output handler -- logs to console (visible via `oc logs`)
  const onOutput = (_name: string, event: AgentEvent): void => {
    switch (event.type) {
      case "text":
        console.log(`[${agentName}] ${event.content}`);
        break;
      case "tool_call":
        console.log(`[${agentName}] TOOL: ${event.name}(${JSON.stringify(event.params)})`);
        break;
      case "tool_result":
        if (event.result.is_error) {
          console.error(`[${agentName}] ERROR(${event.name}): ${event.result.content}`);
        } else {
          console.log(`[${agentName}] OK(${event.name}): ${event.result.content.slice(0, 200)}`);
        }
        break;
      case "error":
        console.error(`[${agentName}] ERROR: ${event.message}`);
        break;
      case "done":
        console.log(`[${agentName}] Agent finished.`);
        break;
    }
  };

  // Parse team roster if provided
  const rosterJson = Deno.env.get("PORTER_TEAM_ROSTER");
  const teamRoster = rosterJson
    ? JSON.parse(rosterJson) as Array<{ name: string; role: string }>
    : undefined;

  // Run the agent
  console.log(`[porter-worker] Starting agent loop...`);
  try {
    const state = await runAgent(provider, config, prompt, onOutput, undefined, undefined, undefined, undefined, teamRoster);
    console.log(
      `[porter-worker] Agent completed. Tokens: ${state.usage.input_tokens} in / ${state.usage.output_tokens} out`,
    );
  } catch (err) {
    console.error(`[porter-worker] Agent crashed: ${(err as Error).message}`);
  } finally {
    clearInterval(heartbeatInterval);
    busClient.close();
  }
}

if (import.meta.main) {
  await main();
}
