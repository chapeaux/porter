import { loadConfig } from "../core/config.ts";
import { start } from "../orchestration/orchestrator.ts";
import { loadSnapshot, restoreAgentStates, snapshotPath } from "../runtime/snapshot.ts";
import { LocalTransport } from "../orchestration/transport.ts";
import { ClusterManager } from "../cluster/cluster.ts";
import { BusServer, getBus } from "../runtime/bus.ts";
import { getCoordinator } from "../runtime/rate_limiter.ts";
import { parseFlag } from "./flags.ts";

export async function cmdStart(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const prompt = parseFlag(args, "--prompt");
  const logFile = parseFlag(args, "--log");
  const restorePath = parseFlag(args, "--restore");
  const noIsolates = args.includes("--no-isolates");

  const term = Deno.env.get("TERM");
  const autoHeadless = !term || term === "dumb";
  const headless = args.includes("--headless") || autoHeadless;

  if (headless) {
    console.log("[porter] Running in headless mode (no tmux)");
  }

  const repoUrl = parseFlag(args, "--repo");
  const repoBranch = parseFlag(args, "--branch");

  console.log(`[porter] Loading config from ${configPath}`);
  const config = await loadConfig(configPath);

  if (repoUrl) {
    config.repo = { url: repoUrl, branch: repoBranch };
  }

  if (noIsolates) {
    config.isolates = false;
  }

  const sandboxFlag = args.includes("--sandbox");
  if (sandboxFlag && !config.sandbox) {
    config.sandbox = { enabled: true };
  }

  if (args.includes("--split-panes")) {
    config.tmux_layout = "panes";
  }

  const { findAvailablePort, registerSession, unregisterSession } = await import("../orchestration/registry.ts");
  const configBusPort = (config as unknown as Record<string, unknown>).bus_port as number | undefined;
  const busPort = parseFlag(args, "--bus-port")
    ? parseInt(parseFlag(args, "--bus-port")!)
    : await findAvailablePort(configBusPort ?? 8787);

  if (restorePath) {
    console.log(`[porter] Restoring session from ${restorePath}`);
  }

  console.log(`[porter] Starting session '${config.session}' with ${config.agents.length} agent(s)`);
  for (const agent of config.agents) {
    console.log(`  - ${agent.name} (${agent.role}): ${agent.tools.length} tools`);
  }

  const bus = getBus();
  const busServer = new BusServer(bus);
  busServer.start(busPort);
  console.log(`[porter] Bus server listening on ws://0.0.0.0:${busPort}`);

  const coordinator = getCoordinator();
  coordinator.onCooldown = (state) => {
    busServer.broadcast({
      type: "rate_limit",
      cooldownRemainingMs: state.cooldownRemainingMs,
    });
  };

  const { NullTransport } = await import("../orchestration/transport.ts");
  const transport = headless ? new NullTransport() : undefined;

  const porter = await start(config, { prompt, logFile, restoreFrom: restorePath, transport });

  const roster = config.agents.map((a) => ({
    name: a.name,
    role: a.role,
    model: a.model ?? config.model,
    tools: a.tools,
    subscribe: a.subscribe,
  }));
  busServer.addStickyMessage(
    "activity",
    JSON.stringify({ event: "roster", agents: roster }),
    "porter",
  );

  let uiPort: number | undefined;
  if (args.includes("--ui")) {
    uiPort = parseInt(parseFlag(args, "--port") ?? "3000");
  }

  await registerSession({
    session: config.session,
    configPath: new URL(configPath, `file://${Deno.cwd()}/`).pathname,
    workingDir: config.working_dir ?? Deno.cwd(),
    repoUrl: config.repo?.url,
    busPort,
    uiPort,
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    agentCount: config.agents.length,
    status: "running",
  });

  const shutdown = async () => {
    console.log("\n[porter] Shutting down...");
    await unregisterSession(config.session);
    await busServer.stop();
    await porter.stop();
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  if (uiPort !== undefined) {
    const { startUiServer } = await import("../ui/server.ts");
    await startUiServer({ port: uiPort, busUrl: `ws://localhost:${busPort}` });
    console.log(`[porter] Dashboard: http://localhost:${uiPort}`);
  }

  console.log(`[porter] Session '${config.session}' is running.`);
  if (!headless) {
    console.log(`[porter] Attach with: tmux attach -t ${config.session}`);
  }
  console.log("[porter] Press Ctrl+C to stop.");

  await new Promise(() => {});
}

export async function cmdSessions(args: string[]): Promise<void> {
  const { listSessions, pruneStale } = await import("../orchestration/registry.ts");

  const pruned = await pruneStale();
  if (pruned > 0) {
    console.error(`[porter] Pruned ${pruned} stale session(s)`);
  }

  const sessions = await listSessions();

  if (args.includes("--json")) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }

  console.log("");
  console.log("  " + "SESSION".padEnd(20) + "REPO/DIR".padEnd(45) + "AGENTS".padEnd(10) + "BUS".padEnd(8) + "STATUS");
  console.log("  " + "─".repeat(80));

  for (const s of sessions) {
    const repo = s.repoUrl
      ? s.repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "")
      : `(local) ${s.workingDir}`;
    const repoTrunc = repo.length > 42 ? repo.slice(0, 39) + "..." : repo;
    console.log(
      `  ${s.session.padEnd(18)}${repoTrunc.padEnd(45)}${String(s.agentCount).padEnd(10)}${String(s.busPort).padEnd(8)}${s.status}`,
    );
  }
  console.log("");
}

export async function cmdStop(args: string[]): Promise<void> {
  if (args.includes("--all")) {
    const { listSessions, unregisterSession: unregSess } = await import("../orchestration/registry.ts");
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("[porter] No active sessions to stop.");
      return;
    }
    for (const s of sessions) {
      try {
        Deno.kill(s.pid, "SIGTERM");
        console.log(`[porter] Sent stop signal to '${s.session}' (PID ${s.pid})`);
      } catch {
        console.error(`[porter] Could not signal PID ${s.pid} for '${s.session}' — may already be stopped`);
        await unregSess(s.session);
      }
    }
    return;
  }

  const sessionName = args.find((a) => !a.startsWith("--"));
  if (sessionName && !sessionName.endsWith(".json")) {
    const { getSession, unregisterSession: unregSess } = await import("../orchestration/registry.ts");
    const record = await getSession(sessionName);
    if (!record) {
      console.error(`[porter] Session '${sessionName}' not found in registry`);
      Deno.exit(1);
    }
    try {
      Deno.kill(record.pid, "SIGTERM");
      console.log(`[porter] Sent stop signal to session '${sessionName}' (PID ${record.pid})`);
    } catch {
      console.error(`[porter] Could not signal PID ${record.pid} — process may already be stopped`);
      await unregSess(sessionName);
    }
    return;
  }

  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const config = await loadConfig(configPath);
  const transport = new LocalTransport();

  if (await transport.hasSession(config.session)) {
    console.log(`[porter] Stopping session '${config.session}'`);
    await transport.killSession(config.session);
    console.log("[porter] Session stopped.");
  } else {
    console.log(`[porter] No active session '${config.session}' found.`);
  }
}

export async function cmdStatus(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const config = await loadConfig(configPath);
  const transport = new LocalTransport();

  const hasLocal = await transport.hasSession(config.session);
  console.log(`Session: ${config.session}`);
  console.log(`Local: ${hasLocal ? "running" : "not running"}`);

  if (hasLocal) {
    const panes = await transport.listPanes(config.session);
    console.log(`Panes: ${panes.length}`);
    console.log("");
    for (const pane of panes) {
      const active = pane.active ? " (active)" : "";
      console.log(`  ${pane.id} [${pane.title}]${active}`);
    }
  }

  if (config.remote) {
    console.log("");
    const cluster = new ClusterManager(config.remote, config);
    const info = await cluster.verifyAuth();

    if (info.connected) {
      console.log(`Remote: ${info.server} (${info.user})`);
      console.log(`Namespace: ${info.namespace}`);

      const pods = await cluster.getPodStatuses();
      if (pods.length > 0) {
        console.log(`Pods: ${pods.length}`);
        for (const pod of pods) {
          const ready = pod.ready ? "ready" : "not ready";
          console.log(`  ${pod.name} [${pod.status}] ${ready} (restarts: ${pod.restarts})`);
        }
      } else {
        console.log("Pods: none deployed");
      }
    } else {
      console.log("Remote: not connected (run 'porter login')");
    }
  }
}

export async function cmdSnapshot(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "save";
  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const config = await loadConfig(configPath);

  if (subcommand === "save") {
    const path = parseFlag(args, "--path") ??
      snapshotPath(config.session, config.working_dir);
    console.log(`[porter] Snapshot would be saved to ${path}`);
    console.log("[porter] Note: Full snapshot requires a running session. Use 'porter start' first.");
  } else if (subcommand === "restore") {
    const path = parseFlag(args, "--path") ??
      snapshotPath(config.session, config.working_dir);
    try {
      const snapshot = await loadSnapshot(path);
      const states = restoreAgentStates(snapshot);
      console.log(`[porter] Loaded snapshot from ${snapshot.timestamp}`);
      console.log(`[porter] Agents: ${[...states.keys()].join(", ")}`);
      console.log("[porter] Use 'porter start --restore' to resume from this snapshot.");
    } catch (err) {
      console.error(`[porter] Error loading snapshot: ${(err as Error).message}`);
      Deno.exit(1);
    }
  } else {
    console.error(`Unknown snapshot subcommand: ${subcommand}`);
    Deno.exit(1);
  }
}
