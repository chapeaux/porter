/**
 * Porter CLI -- command-line interface for the Pullman Porter orchestrator.
 *
 * Usage:
 *   porter init    [--config porter.json]
 *   porter start   [--config porter.json] [--prompt "..."] [--log porter.log] [--bus-port 8787]
 *   porter stop    [--config porter.json]
 *   porter status  [--config porter.json]
 *   porter snapshot [save|restore] [--path snapshot.json]
 *   porter login   [--server URL] [--token TOKEN]
 *   porter deploy  [--config porter.json] [--bus-port 8787]
 *   porter teardown [--config porter.json]
 *   porter router  [--port 3000] [--idle-timeout 30] [--namespace NS]
 *
 * Command implementations are in src/cli/ modules.
 */

const HELP = `
Pullman Porter -- pure-Deno tmux agent orchestrator

     _______________
    /               \\
   /                 \\
  |___________________|
  |___________________|

USAGE:
  deno run --allow-all cli.ts <command> [options]

COMMANDS:
  init        Create a porter.json config in the current directory
  add-agent   Add a new agent to an existing porter.json
  start       Launch a Porter session from config
  send        Send a message to agents in a running session
  stop        Stop the active session (auto-snapshots); or stop <session> by name
  status      Show agent panes and health
  snapshot    Save or restore session state
  serve       Start Porter Platform — UI + dynamic session management (no default session)
  sessions    List all running Porter sessions
  ui          Launch the Porter Station web dashboard
  login       Authenticate with a remote OpenShift cluster
  deploy      Deploy agent worker pods to OpenShift
  teardown    Remove all porter pods and secrets from cluster
  router      Start the multi-user router (pod-per-user mode)

OPTIONS:
  --config <path>     Config file path (default: porter.json)
  --prompt <text>     Initial prompt for agents
  --log <path>        Log file path
  --path <path>       Snapshot file path (for snapshot command)
  --bus-port <port>   WebSocket bus port for remote workers (default: auto)
  --port <port>       Web UI server port (default: 3000)
  --ui                Start web dashboard alongside session (with start)
  --restore <path>    Resume agents from a snapshot file (with start)
  --no-isolates       Run agents in the main process instead of V8 isolate Workers
  --sandbox           Enable container sandbox for workspace isolation
  --headless          Run without tmux (for containers/headless environments)
  --repo <url>        Git repository URL to clone for the session
  --branch <name>     Branch to checkout (used with --repo)
  --json              Output sessions list as JSON (for sessions command)
  --server <url>      OpenShift server URL (for login)
  --token <token>     OpenShift auth token (for login)
  --idle-timeout <m>  Idle timeout in minutes for user pods (default: 30, router only)
  --namespace <ns>    OpenShift namespace (for router)
  --single-user       Run in single-user mode (no OIDC, used by user pods)
  --help, -h          Show this help
`.trim();

export { parseFlag } from "./src/cli/flags.ts";

async function main(): Promise<void> {
  const args = Deno.args;

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "init": {
      const { cmdInit } = await import("./src/cli/init.ts");
      await cmdInit(rest);
      break;
    }
    case "add-agent": {
      const { cmdAddAgent } = await import("./src/cli/init.ts");
      await cmdAddAgent(rest);
      break;
    }
    case "start": {
      const { cmdStart } = await import("./src/cli/session.ts");
      await cmdStart(rest);
      break;
    }
    case "send": {
      const { cmdSend } = await import("./src/cli/send.ts");
      await cmdSend(rest);
      break;
    }
    case "stop": {
      const { cmdStop } = await import("./src/cli/session.ts");
      await cmdStop(rest);
      break;
    }
    case "status": {
      const { cmdStatus } = await import("./src/cli/session.ts");
      await cmdStatus(rest);
      break;
    }
    case "snapshot": {
      const { cmdSnapshot } = await import("./src/cli/session.ts");
      await cmdSnapshot(rest);
      break;
    }
    case "sessions": {
      const { cmdSessions } = await import("./src/cli/session.ts");
      await cmdSessions(rest);
      break;
    }
    case "serve": {
      const { cmdServe } = await import("./src/cli/serve.ts");
      await cmdServe(rest);
      break;
    }
    case "ui": {
      const { cmdUi } = await import("./src/cli/serve.ts");
      await cmdUi(rest);
      break;
    }
    case "login": {
      const { cmdLogin } = await import("./src/cli/cluster.ts");
      await cmdLogin(rest);
      break;
    }
    case "deploy": {
      const { cmdDeploy } = await import("./src/cli/cluster.ts");
      await cmdDeploy(rest);
      break;
    }
    case "teardown": {
      const { cmdTeardown } = await import("./src/cli/cluster.ts");
      await cmdTeardown(rest);
      break;
    }
    case "router": {
      const { cmdRouter } = await import("./src/cli/serve.ts");
      await cmdRouter(rest);
      break;
    }
    case "mcp": {
      const { cmdMcp } = await import("./src/cli/mcp.ts");
      await cmdMcp(rest);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help for usage.');
      Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
