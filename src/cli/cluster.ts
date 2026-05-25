import { loadConfig } from "../core/config.ts";
import { ClusterManager } from "../cluster/cluster.ts";
import { parseFlag } from "./flags.ts";

export async function cmdLogin(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const server = parseFlag(args, "--server");
  const token = parseFlag(args, "--token");

  let config;
  try {
    config = await loadConfig(configPath);
  } catch {
    config = null;
  }

  if (!config?.remote) {
    console.error("[porter] No 'remote' section in config. Add one to porter.json first.");
    Deno.exit(1);
  }

  const cluster = new ClusterManager(config.remote, config);

  if (!(await cluster.hasOcCli())) {
    console.error("[porter] 'oc' CLI not found. Install it from https://mirror.openshift.com/pub/openshift-v4/clients/ocp/stable/");
    Deno.exit(1);
  }

  if (server && token) {
    console.log(`[porter] Logging in to ${server}...`);
    await cluster.login(server, token);
  }

  const info = await cluster.verifyAuth();
  if (!info.connected) {
    console.error("[porter] Not authenticated. Use --server and --token flags, or run 'oc login' manually.");
    Deno.exit(1);
  }

  console.log(`[porter] Connected to ${info.server} as ${info.user}`);

  await cluster.useNamespace();
  console.log(`[porter] Using namespace: ${config.remote.namespace}`);
}

export async function cmdDeploy(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const busPort = parseInt(parseFlag(args, "--bus-port") ?? "8787");

  const config = await loadConfig(configPath);

  if (!config.remote) {
    console.error("[porter] No 'remote' section in config.");
    Deno.exit(1);
  }

  const cluster = new ClusterManager(config.remote, config);

  const info = await cluster.verifyAuth();
  if (!info.connected) {
    console.error("[porter] Not authenticated. Run 'porter login' first.");
    Deno.exit(1);
  }

  console.log(`[porter] Deploying to ${info.server} (${info.namespace})`);
  console.log(`[porter] Image: ${config.remote.image}`);

  const agentNames = config.agents.map((a) => a.name);
  console.log(`[porter] Deploying ${agentNames.length} worker pod(s)...`);

  const podNames = await cluster.deployWorkers(busPort, agentNames);

  for (const pod of podNames) {
    console.log(`  - ${pod}`);
  }

  console.log("[porter] Waiting for pods to be ready...");
  try {
    await cluster.waitForPods(podNames, 120);
    console.log("[porter] All pods are ready.");
  } catch (err) {
    console.error(`[porter] Warning: some pods may not be ready: ${(err as Error).message}`);
  }

  console.log("");
  console.log("[porter] Deployment complete.");
  console.log(`[porter] Start the orchestrator with: porter start --bus-port ${busPort}`);
  console.log("[porter] Workers will connect to the bus server.");
}

export async function cmdTeardown(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const config = await loadConfig(configPath);

  if (!config.remote) {
    console.error("[porter] No 'remote' section in config.");
    Deno.exit(1);
  }

  const cluster = new ClusterManager(config.remote, config);

  const info = await cluster.verifyAuth();
  if (!info.connected) {
    console.error("[porter] Not authenticated. Run 'porter login' first.");
    Deno.exit(1);
  }

  console.log(`[porter] Tearing down session '${config.session}' from ${info.namespace}...`);
  await cluster.teardown();
  console.log("[porter] All porter pods and secrets removed.");
}
