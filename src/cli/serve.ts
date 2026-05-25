import { parseFlag } from "./flags.ts";

export async function cmdServe(args: string[]): Promise<void> {
  const port = parseInt(parseFlag(args, "--port") ?? "3000");
  const singleUser = args.includes("--single-user") || Deno.env.get("PORTER_SINGLE_USER") === "true";
  const sandboxDefault = args.includes("--sandbox");

  const term = Deno.env.get("TERM");
  const headless = args.includes("--headless") || !term || term === "dumb";

  console.log("[porter] Starting Porter Platform (dynamic session mode)");
  if (headless) {
    console.log("[porter] Running in headless mode");
  }
  if (singleUser) {
    console.log("[porter] Running in single-user mode (OIDC disabled)");
  }
  if (sandboxDefault) {
    console.log("[porter] Sandbox enabled by default for all sessions");
  }

  const { SessionManager } = await import("../orchestration/session_manager.ts");
  const sessionManager = new SessionManager(sandboxDefault ? { defaultSandbox: true } : undefined);

  const { startUiServer } = await import("../ui/server.ts");
  await startUiServer({
    port,
    busUrl: "ws://localhost:8787",
    sessionManager,
    singleUser,
  });

  console.log(`[porter] Porter Station: http://localhost:${port}`);
  console.log("[porter] No sessions running. Create a team via the UI.");
  console.log("[porter] Press Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\n[porter] Shutting down all sessions...");
    await sessionManager.stopAll();
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await new Promise(() => {});
}

export async function cmdUi(args: string[]): Promise<void> {
  const port = parseInt(parseFlag(args, "--port") ?? "3000");
  const busPort = parseInt(parseFlag(args, "--bus-port") ?? "8787");
  const busUrl = `ws://localhost:${busPort}`;

  const { startUiServer } = await import("../ui/server.ts");
  await startUiServer({ port, busUrl });

  console.log(`[porter] Porter Station dashboard: http://localhost:${port}`);
  console.log(`[porter] Bus URL: ${busUrl}`);
  console.log("[porter] Press Ctrl+C to stop.");

  await new Promise(() => {});
}

export async function cmdRouter(args: string[]): Promise<void> {
  const port = parseInt(parseFlag(args, "--port") ?? "3000");
  const idleTimeout = parseInt(parseFlag(args, "--idle-timeout") ?? Deno.env.get("PORTER_IDLE_TIMEOUT") ?? "30");
  const namespace = parseFlag(args, "--namespace") ?? Deno.env.get("PORTER_NAMESPACE");

  console.log("[porter] Starting multi-user router (pod-per-user mode)");
  console.log(`[porter] Port: ${port}, Idle timeout: ${idleTimeout}m`);
  if (namespace) {
    console.log(`[porter] Namespace: ${namespace}`);
  }

  const { startRouter } = await import("../router/server.ts");
  const server = await startRouter({ port, idleTimeoutMinutes: idleTimeout, namespace });

  console.log("[porter] Press Ctrl+C to stop.");

  const shutdown = () => {
    console.log("\n[porter] Shutting down router...");
    server.shutdown();
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await new Promise(() => {});
}
