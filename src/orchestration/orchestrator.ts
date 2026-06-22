/**
 * Orchestrator -- wires everything together.
 *
 * Reads config, creates the tmux session, spawns panes, launches agent
 * loops as concurrent async tasks (or V8 Worker isolates when
 * `config.isolates` is not false), and manages lifecycle.
 */

import type { PorterConfig } from "../core/config.ts";
import type { ProviderConfig } from "../providers/mod.ts";
import { createProvider } from "../providers/mod.ts";
import { type AgentState, type CancelSignal, runAgent, serializeState, deserializeState } from "../runtime/agent.ts";
import { type MessageBus, getBus } from "../runtime/bus.ts";
import { type RateLimitCoordinator, getCoordinator } from "../runtime/rate_limiter.ts";
import { DisplayManager } from "./display.ts";
import { HeartbeatMonitor } from "../runtime/heartbeat.ts";
import { LocalTransport, type Transport } from "./transport.ts";
import { saveSnapshot, loadSnapshot, restoreAgentStates, snapshotPath } from "../runtime/snapshot.ts";
import { MetricsCollector } from "./metrics.ts";
import { MessageStore } from "./message_store.ts";

// ---------------------------------------------------------------------------
// Repo provisioning
// ---------------------------------------------------------------------------

/** Run a command and throw on failure. */
async function runCommand(args: string[]): Promise<void> {
  const cmd = new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`Command failed: ${args.join(" ")}\n${stderr}`);
  }
}

/**
 * Ensure the working directory exists and clone/pull the repo if configured.
 * Returns the resolved working directory path.
 */
export async function provisionRepo(config: PorterConfig): Promise<string> {
  const workingDir = config.working_dir ??
    `${Deno.env.get("HOME") ?? Deno.cwd()}/.porter/workspaces/${config.session}`;

  if (!config.repo) {
    // No repo — just ensure the directory exists
    await Deno.mkdir(workingDir, { recursive: true });
    return workingDir;
  }

  // Check if the directory already exists and is a git repo
  let isGitRepo = false;
  try {
    const stat = await Deno.stat(`${workingDir}/.git`);
    isGitRepo = stat.isDirectory;
  } catch { /* not a git repo or directory doesn't exist */ }

  if (isGitRepo) {
    // Pull latest
    console.error(`[porter] Pulling latest in ${workingDir}`);
    await runCommand(["git", "-C", workingDir, "fetch", "origin"]);
    if (config.repo.branch) {
      await runCommand(["git", "-C", workingDir, "checkout", config.repo.branch]);
      await runCommand(["git", "-C", workingDir, "pull", "--ff-only"]);
    }
  } else {
    // Clone fresh
    console.error(`[porter] Cloning ${config.repo.url} into ${workingDir}`);
    await Deno.mkdir(workingDir, { recursive: true });

    const cloneArgs = ["git", "clone"];
    if (config.repo.shallow) cloneArgs.push("--depth", "1");
    if (config.repo.branch) cloneArgs.push("--branch", config.repo.branch);

    // Inject token for HTTPS auth
    let url = config.repo.url;
    if (config.repo.token_env) {
      const token = Deno.env.get(config.repo.token_env);
      if (token && url.startsWith("https://")) {
        url = url.replace("https://", `https://x-access-token:${token}@`);
      }
    }

    cloneArgs.push(url, workingDir);
    await runCommand(cloneArgs);
  }

  return workingDir;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Running orchestrator instance. */
export interface Porter {
  /** Session name. */
  session: string;
  /** Resolved config. */
  config: PorterConfig;
  /** Map of agent name -> running state. */
  agents: Map<string, AgentState>;
  /** The display manager. */
  display: DisplayManager;
  /** The heartbeat monitor. */
  heartbeat: HeartbeatMonitor;
  /** V8 Worker isolates (when isolates mode is enabled). */
  workers?: Map<string, Worker>;
  /** Session metrics collector. */
  metrics: MetricsCollector;
  /** Persistent message store. */
  messageStore: MessageStore;
  /** Stop the session gracefully. */
  stop: () => Promise<void>;
  /** Save a snapshot. */
  snapshot: (path?: string) => Promise<string>;
  /** Restart a single agent by name (terminates and respawns). */
  restartAgent: (name: string) => Promise<void>;
}

/**
 * Start a Porter session from config.
 */
export async function start(
  config: PorterConfig,
  options?: {
    /** Initial prompt for all agents. Default: "Begin your assigned work." */
    prompt?: string;
    /** Custom transport. Default: LocalTransport. */
    transport?: Transport;
    /** Log file path. */
    logFile?: string;
    /** Path to a snapshot to restore from. */
    restoreFrom?: string;
    /**
     * Per-session MessageBus instance. When provided, this bus is used
     * instead of the global singleton — required for multi-session mode
     * so sessions don't share a single bus.
     */
    bus?: MessageBus;
    /**
     * Per-session RateLimitCoordinator instance. When provided, this
     * coordinator is used instead of the global singleton — required for
     * multi-session mode so each session has independent rate limiting.
     */
    coordinator?: RateLimitCoordinator;
  },
): Promise<Porter> {
  // Provision repo and resolve working_dir before anything else
  const workingDir = await provisionRepo(config);
  config.working_dir = workingDir;

  const transport = options?.transport ?? new LocalTransport();
  const prompt = options?.prompt ?? "You are an agent in a Porter swarm. You will receive tasks via messages. Read each task carefully and execute it using your available tools.";

  // Determine mode: isolates on by default, disabled only when explicitly false
  const useIsolates = config.isolates !== false;

  // Build a default ProviderConfig from the top-level config fields.
  // Agents can override this via per-agent model selection (resolved later).
  const defaultProviderConfig: ProviderConfig = resolveDefaultProviderConfig(config);

  // Resolve bus: use injected per-session instance or fall back to global singleton.
  // Multi-session mode always injects its own bus so sessions are fully isolated.
  const bus = options?.bus ?? getBus();

  // Resolve coordinator: use injected per-session instance or global singleton.
  const coordinator = options?.coordinator ?? getCoordinator();

  // Initialize metrics and persistent message store
  const metrics = new MetricsCollector(config.session, new Date().toISOString());
  const messageStore = new MessageStore(config.session);
  await messageStore.init();

  // Initialize RDF graph store (optional — continues without if Oxigraph fails)
  let graphStoreRef: import("../graph/store.ts").GraphStore | null = null;
  try {
    const { initGraphStore } = await import("../graph/store.ts");
    const { porterConfigToTriples, seedTeamMemory } = await import("../graph/converters.ts");
    const graphStore = await initGraphStore();
    porterConfigToTriples(config, graphStore);
    seedTeamMemory(config.agents, graphStore);
    graphStoreRef = graphStore;

    // Restore persisted memory graph if resuming from snapshot
    if (options?.restoreFrom) {
      try {
        const snap = await loadSnapshot(options.restoreFrom);
        if (snap.memoryTurtle) {
          const { GRAPHS: G } = await import("../graph/vocabulary.ts");
          graphStore.load(snap.memoryTurtle, G.memory);
          console.error("[porter] Memory graph restored from snapshot");
        }
      } catch {
        // Snapshot may not exist yet — not an error
      }
    }
  } catch (e) {
    console.error("[porter] Graph store init failed (continuing without):", (e as Error).message);
  }

  // Hook into bus to persist all messages and count per-channel
  const origPublish = bus.publish.bind(bus);
  bus.publish = async (channel: string, content: string, from: string = "system") => {
    metrics.recordMessage(channel);
    messageStore.append({ channel, from, content, timestamp: Date.now() });
    return origPublish(channel, content, from);
  };

  // Inject session-level environment variables into bash/git tools
  if (config.env && Object.keys(config.env).length > 0) {
    const { setSessionEnv: setBashEnv } = await import("../tools/bash.ts");
    const { setSessionEnv: setGitEnv } = await import("../tools/git.ts");
    setBashEnv(config.env);
    setGitEnv(config.env);
  }

  // Initialize container sandbox if configured.
  // Skip when running inside a container already (OpenShift/K8s) — the pod is the sandbox.
  const inContainer = !!(Deno.env.get("KUBERNETES_SERVICE_HOST") || Deno.env.get("container"));
  let sandboxExecutor: import("../sandbox/mod.ts").SandboxExecutor | null = null;
  if (config.sandbox) {
    const sandboxConfig = typeof config.sandbox === "boolean"
      ? { enabled: true }
      : config.sandbox;

    if (sandboxConfig.enabled) {
      if (inContainer) {
        console.error("[porter] Sandbox skipped: already running in a container (pod isolation active)");
      } else {
        const { ContainerSandbox } = await import("../sandbox/mod.ts");
        const runtimeToolNames = (config.runtime_tools ?? [])
          .map(t => typeof t === "string" ? t : t.name)
          .filter(Boolean);
        const executor = new ContainerSandbox(sandboxConfig, workingDir, config.session, runtimeToolNames);
        await executor.start();
        sandboxExecutor = executor;
        console.error(`[porter] Sandbox started: ${executor.runtime} container with workspace at /workspace`);
      }
    }
  }

  if (sandboxExecutor) {
    // Inject sandbox executor into subprocess tools
    const { setSandboxExecutor: setBashSandbox } = await import("../tools/bash.ts");
    const { setSandboxExecutor: setGitSandbox } = await import("../tools/git.ts");
    setBashSandbox(sandboxExecutor);
    setGitSandbox(sandboxExecutor);

    // Inject working dir into file tools for path validation
    const { setWorkingDir: setReadWd } = await import("../tools/read_file.ts");
    const { setWorkingDir: setWriteWd } = await import("../tools/write_file.ts");
    const { setWorkingDir: setEditWd } = await import("../tools/edit_file.ts");
    const { setWorkingDir: setGlobWd } = await import("../tools/glob.ts");
    const { setWorkingDir: setGrepWd } = await import("../tools/grep.ts");
    const { setWorkingDir: setListWd } = await import("../tools/list_dir.ts");
    setReadWd(workingDir);
    setWriteWd(workingDir);
    setEditWd(workingDir);
    setGlobWd(workingDir);
    setGrepWd(workingDir);
    setListWd(workingDir);
  }

  // Connect to configured MCP servers for external tool integration
  let mcpClients: Map<string, import("../mcp/mcp_client.ts").McpClient> | null = null;
  if (config.mcp_servers && Object.keys(config.mcp_servers).length > 0) {
    const { connectMcpServers } = await import("../mcp/mcp_client.ts");
    mcpClients = await connectMcpServers(config.mcp_servers);
  }

  // Wire pattern-specific channel subscriptions before agent subscription
  const { wirePattern, getPatternTools, getPatternSystemPrompt } = await import("./patterns.ts");
  wirePattern(config, bus);

  // Inject pattern tools and system prompt suffix into each agent config
  const patternId = config.pattern ?? "sequential";
  const teamRosterForPattern = config.agents.map(a => ({ name: a.name, role: a.role }));
  for (const agentConfig of config.agents) {
    // Add pattern-specific tools to the agent's tool list
    const patternTools = getPatternTools(agentConfig.role as import("../core/config.ts").AgentRole, patternId);
    if (patternTools.length > 0) {
      const existingTools = agentConfig.tools ?? [];
      const toolSet = new Set(existingTools);
      for (const t of patternTools) {
        if (!toolSet.has(t)) {
          existingTools.push(t);
          toolSet.add(t);
        }
      }
      agentConfig.tools = existingTools;
    }

    // Append pattern-specific system prompt suffix
    const patternPromptSuffix = getPatternSystemPrompt(
      agentConfig.role as import("../core/config.ts").AgentRole,
      patternId,
      teamRosterForPattern,
      config.max_deliberation_rounds,
      agentConfig.name,
    );
    if (patternPromptSuffix) {
      agentConfig.system_prompt = `${agentConfig.system_prompt}\n\n${patternPromptSuffix}`;
    }
  }

  for (const agentConfig of config.agents) {
    // Subscribe to configured channels plus a personal channel for direct targeting
    const channels = [...(agentConfig.subscribe ?? []), `task:${agentConfig.name}`, "control"];
    bus.subscribe(agentConfig.name, channels);
  }

  // Set up tmux session
  if (await transport.hasSession(config.session)) {
    await transport.killSession(config.session);
  }
  await transport.newSession(config.session);
  await transport.enablePaneTitles(config.session);

  // Display manager
  const display = new DisplayManager(transport);
  if (options?.logFile) {
    await display.enableLog(options.logFile);
  }

  // Heartbeat monitor
  const agents = new Map<string, AgentState>();
  const heartbeat = new HeartbeatMonitor(
    config.heartbeat_timeout_ms ?? 120_000,
    (_agentName) => {
      // Heartbeat timeout — agent may be waiting for API response or idle.
      // Intentionally silent: repeated logging creates noise in headless/cloud deployments.
    },
  );

  // Load snapshot for resume if requested
  let priorStates: Map<string, AgentState> | null = null;
  if (options?.restoreFrom) {
    try {
      const snapshot = await loadSnapshot(options.restoreFrom);
      priorStates = restoreAgentStates(snapshot);
      console.error(`[porter] Restoring from snapshot: ${snapshot.timestamp} (${priorStates.size} agents)`);
    } catch (err) {
      console.error(`[porter] Warning: could not load snapshot: ${(err as Error).message}`);
    }
  }

  // Propagate top-level defaults to any agent that doesn't override them
  for (const agentConfig of config.agents) {
    if (!agentConfig.working_dir) {
      agentConfig.working_dir = config.working_dir;
    }
    if (!agentConfig.model) {
      agentConfig.model = config.model;
    }
  }

  // Shared cancellation signal (used in non-isolate mode)
  const cancelSignal: CancelSignal = { cancelled: false };

  // Worker map (used in isolate mode)
  const workers = new Map<string, Worker>();

  // The first window is created with the session, so we use it for the first agent
  const firstPanes = await transport.listPanes(config.session);
  const firstPaneId = firstPanes[0]?.id;

  // -------------------------------------------------------------------------
  // Shared pane setup -- same for both modes
  // -------------------------------------------------------------------------

  // Helper: build the activity-channel outputHandler for a given agent config
  function makeOutputHandler(
    agentConfig: PorterConfig["agents"][number],
    displayHandler: ReturnType<DisplayManager["handler"]>,
  ) {
    return (name: string, event: import("../runtime/agent.ts").AgentEvent) => {
      displayHandler(name, event);
      heartbeat.beat(name);

      // Skip bus tool calls/results from the activity feed — agents poll
      // read_messages frequently, producing noise that drowns real events.
      // displayHandler and heartbeat.beat still fire for all events.
      if (
        (event.type === "tool_call" || event.type === "tool_result") &&
        (event.name === "read_messages" || event.name === "send_message")
      ) {
        return;
      }

      const eventObj: Record<string, unknown> = { agent: name, role: agentConfig.role };
      switch (event.type) {
        case "text":
          eventObj.event = "text";
          eventObj.text = event.content;
          break;
        case "tool_call":
          eventObj.event = "tool_call";
          eventObj.tool = event.name;
          eventObj.params = event.params;
          break;
        case "tool_result":
          eventObj.event = "tool_result";
          eventObj.tool = event.name;
          eventObj.ok = !event.result.is_error;
          eventObj.output = event.result.content.slice(0, 500);
          break;
        case "retrying":
          eventObj.event = "retrying";
          eventObj.message = event.message;
          eventObj.attempt = event.attempt;
          eventObj.delay = event.delay;
          break;
        case "error":
          eventObj.event = "error";
          eventObj.message = event.message;
          break;
        case "usage":
          eventObj.event = "usage";
          eventObj.input_tokens = event.input_tokens;
          eventObj.output_tokens = event.output_tokens;
          break;
        case "done":
          eventObj.event = "done";
          break;
      }
      const content = JSON.stringify(eventObj);
      metrics.recordActivity(name, eventObj);
      bus.publish("activity", content, name).catch(() => {});
    };
  }

  // -------------------------------------------------------------------------
  // Isolate mode: spawn each agent as a V8 Worker
  // -------------------------------------------------------------------------

  const agentPromises: Promise<void>[] = [];

  async function spawnIsolateAgent(agentConfig: PorterConfig["agents"][number], resumeState?: AgentState): Promise<void> {
    const channels = [...(agentConfig.subscribe ?? []), `task:${agentConfig.name}`, "control"];
    bus.subscribe(agentConfig.name, channels);

    display.registerPane(agentConfig.name, display.getPaneId(agentConfig.name) ?? await transport.spawnWindow(config.session, agentConfig.name));
    heartbeat.register(agentConfig.name);

    const displayHandler = display.handler(agentConfig.name);

    const runningState: AgentState = {
      config: agentConfig,
      history: resumeState?.history ?? [],
      usage: resumeState?.usage ?? { input_tokens: 0, output_tokens: 0 },
      running: true,
    };
    agents.set(agentConfig.name, runningState);

    const worker = new Worker(
      new URL("../../isolate.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (evt) => {
      const data = evt.data as Record<string, unknown>;
      switch (data.type) {
        case "event": {
          const event = data.event as import("../runtime/agent.ts").AgentEvent;
          const outputHandler = makeOutputHandler(agentConfig, displayHandler);
          outputHandler(data.agentName as string, event);
          break;
        }
        case "bus_publish":
          bus.publish(data.channel as string, data.content as string, data.from as string);
          break;
        case "bus_drain":
          bus.drain(data.agentName as string, data.channel as string | undefined).then((msgs) => {
            worker.postMessage({
              type: "bus_drain_response",
              id: data.id,
              messages: msgs,
            });
          });
          break;
        case "mcp_tool_call": {
          const toolName = data.toolName as string;
          const params = data.params as Record<string, unknown>;
          const callId = data.id as number;
          (async () => {
            try {
              const sepIdx = toolName.indexOf("__");
              const serverName = sepIdx > 0 ? toolName.slice(0, sepIdx) : toolName;
              const rawToolName = sepIdx > 0 ? toolName.slice(sepIdx + 2) : toolName;
              const client = mcpClients?.get(serverName);
              if (!client) throw new Error(`MCP server '${serverName}' not connected`);
              const result = await client.callTool(rawToolName, params);
              worker.postMessage({ type: "mcp_tool_result", id: callId, result });
            } catch (err) {
              worker.postMessage({ type: "mcp_tool_result", id: callId, result: { content: (err as Error).message, is_error: true } });
            }
          })();
          break;
        }
        case "rate_limit_acquire": {
          coordinator.acquire(data.agentName as string).then(() => {
            worker.postMessage({
              type: "rate_limit_acquired",
              id: data.id,
            });
          });
          break;
        }
        case "rate_limit_report": {
          coordinator.reportRateLimit(data.agentName as string, data.retryAfterMs as number);
          metrics.recordRateLimit();
          break;
        }
        case "done": {
          const finalState = deserializeState(data.state as string);
          agents.set(data.agentName as string, finalState);
          metrics.recordTokens(
            data.agentName as string,
            finalState.usage.input_tokens,
            finalState.usage.output_tokens,
          );
          heartbeat.unregister(data.agentName as string);
          break;
        }
        case "graph_add_triple": {
          const gs = graphStoreRef;
          if (gs) gs.addTriple(data.subject as string, data.predicate as string, data.object as string, data.graph as string | undefined);
          break;
        }
        case "graph_add_literal": {
          const gs = graphStoreRef;
          if (gs) gs.addLiteral(data.subject as string, data.predicate as string, data.value as string | number | boolean, data.graph as string | undefined);
          break;
        }
        case "graph_query": {
          const gs = graphStoreRef;
          const rows = gs ? gs.query(data.sparql as string) : [];
          worker.postMessage({ type: "graph_query_response", id: data.id, rows });
          break;
        }
        case "error":
          console.error(`[porter] Agent '${data.agentName}' isolate error: ${data.message}`);
          heartbeat.unregister(data.agentName as string);
          break;
      }
    };

    worker.onerror = (err) => {
      console.error(`[porter] Agent '${agentConfig.name}' isolate crashed: ${err.message}`);
      heartbeat.unregister(agentConfig.name);
    };

    const agentProviderConfig = resolveAgentProviderConfig(
      agentConfig, config, defaultProviderConfig,
    );

    worker.postMessage({
      type: "start",
      agentConfig,
      initialPrompt: prompt,
      model: agentConfig.model ?? config.model,
      providerConfig: agentProviderConfig,
      resumeFrom: resumeState ? serializeState(resumeState) : undefined,
      teamRoster: config.agents.map(a => ({ name: a.name, role: a.role })),
      sessionEnv: config.env,
      sandboxContainerName: (sandboxExecutor as import("../sandbox/mod.ts").ContainerSandbox | null)?.containerName,
      sandboxRuntime: sandboxExecutor?.runtime,
      sandboxWorkingDir: sandboxExecutor ? workingDir : undefined,
    });

    workers.set(agentConfig.name, worker);

    if (mcpClients && agentConfig.mcp_tools?.length) {
      const mcpTools = resolveAgentMcpTools(agentConfig, mcpClients);
      for (const tool of mcpTools) {
        await bus.publish("control", JSON.stringify({
          action: "add_tool",
          agent: agentConfig.name,
          tool: { name: tool.definition.name, definition: tool.definition },
        }), "porter");
      }
    }
  }

  if (useIsolates) {
    for (let i = 0; i < config.agents.length; i++) {
      const agentConfig = config.agents[i];
      let paneId: string;

      if (i === 0 && firstPaneId) {
        paneId = firstPaneId;
        await transport.setPaneTitle(paneId, `${agentConfig.name} [${agentConfig.role}]`);
      } else {
        paneId = await transport.spawnWindow(config.session, `${agentConfig.name}`);
      }

      const roleColors: Record<string, string> = {
        admin: "colour214",
        worker: "colour173",
        reviewer: "colour108",
      };
      const paneColor = roleColors[agentConfig.role] ?? "colour250";
      const paneLabel = `${agentConfig.name} [${agentConfig.role}]`;
      await transport.stylePaneBorder(paneId, paneColor, paneLabel);

      display.registerPane(agentConfig.name, paneId);

      const resumeState = priorStates?.get(agentConfig.name) ?? undefined;
      await spawnIsolateAgent(agentConfig, resumeState);
    }
  } else {
    // -----------------------------------------------------------------------
    // Non-isolate mode: existing direct runAgent() path
    // -----------------------------------------------------------------------

    for (let i = 0; i < config.agents.length; i++) {
      const agentConfig = config.agents[i];
      let paneId: string;

      if (i === 0 && firstPaneId) {
        paneId = firstPaneId;
        await transport.setPaneTitle(paneId, `${agentConfig.name} [${agentConfig.role}]`);
      } else {
        paneId = await transport.spawnWindow(config.session, `${agentConfig.name}`);
      }

      const roleColors: Record<string, string> = {
        admin: "colour214",
        worker: "colour173",
        reviewer: "colour108",
      };
      const paneColor = roleColors[agentConfig.role] ?? "colour250";
      const paneLabel = `${agentConfig.name} [${agentConfig.role}]`;
      await transport.stylePaneBorder(paneId, paneColor, paneLabel);

      display.registerPane(agentConfig.name, paneId);
      heartbeat.register(agentConfig.name);

      const displayHandler = display.handler(agentConfig.name);
      const outputHandler = makeOutputHandler(agentConfig, displayHandler);
      const heartbeatCallback = () => heartbeat.beat(agentConfig.name);
      const resumeState = priorStates?.get(agentConfig.name) ?? undefined;

      // Track the running state so we can cancel it
      const runningState: AgentState = {
        config: agentConfig,
        history: resumeState?.history ?? [],
        usage: resumeState?.usage ?? { input_tokens: 0, output_tokens: 0 },
        running: true,
      };
      agents.set(agentConfig.name, runningState);

      // Create a provider for this agent (may differ from default if agent overrides model)
      const agentProviderConfig = resolveAgentProviderConfig(
        agentConfig, config, defaultProviderConfig,
      );
      const agentProvider = createAgentProvider(
        agentProviderConfig, agentConfig.model ?? config.model,
      );

      // Collect MCP tools for this agent
      const agentMcpTools = resolveAgentMcpTools(agentConfig, mcpClients);

      const teamRoster = config.agents.map(a => ({ name: a.name, role: a.role }));
      const agentPromise = runAgent(agentProvider, agentConfig, prompt, outputHandler, heartbeatCallback, resumeState, cancelSignal, agentMcpTools, teamRoster)
        .then((state) => {
          agents.set(agentConfig.name, state);
          heartbeat.unregister(agentConfig.name);
        })
        .catch((err) => {
          console.error(`[porter] Agent '${agentConfig.name}' crashed: ${err.message}`);
          heartbeat.unregister(agentConfig.name);
        });

      agentPromises.push(agentPromise);
    }
  }

  heartbeat.start();

  // Publish roster so the UI knows all agents immediately
  const roster = config.agents.map((a) => ({
    name: a.name,
    role: a.role,
    model: a.model ?? config.model,
    tools: a.tools,
    subscribe: a.subscribe,
  }));
  await bus.publish(
    "activity",
    JSON.stringify({ event: "roster", agents: roster }),
    "porter",
  );

  // Build the Porter handle
  const porter: Porter = {
    session: config.session,
    config,
    agents,
    display,
    heartbeat,
    workers: useIsolates ? workers : undefined,
    metrics,
    messageStore,

    async restartAgent(name: string) {
      const agentConfig = config.agents.find(a => a.name === name);
      if (!agentConfig) throw new Error(`Agent '${name}' not found in config`);

      const currentState = agents.get(name);

      if (useIsolates) {
        const existingWorker = workers.get(name);
        if (existingWorker) {
          existingWorker.postMessage({ type: "cancel" });
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline && agents.get(name)?.running) {
            await new Promise(r => setTimeout(r, 200));
          }
          if (agents.get(name)?.running) {
            existingWorker.terminate();
          }
          workers.delete(name);
        }
        heartbeat.unregister(name);
        await spawnIsolateAgent(agentConfig, currentState);
        console.error(`[porter] Agent '${name}' restarted`);
        await bus.publish("activity", JSON.stringify({
          agent: name, role: agentConfig.role, event: "restarted",
        }), "porter");
      } else {
        throw new Error("Agent restart is only supported in isolate mode");
      }
    },

    async stop() {
      console.error("[porter] Requesting agent cancellation...");

      if (useIsolates) {
        // Signal all isolates to cancel gracefully
        for (const [_name, worker] of workers) {
          worker.postMessage({ type: "cancel" });
        }
      } else {
        // Signal the shared cancel signal used by direct runAgent() calls
        cancelSignal.cancelled = true;
      }

      // Wait up to 10 seconds for agents to finish their current iteration
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const stillRunning = [...agents.values()].some((s) => s.running);
        if (!stillRunning) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      // Force-terminate any isolates that didn't stop in time
      if (useIsolates) {
        for (const [name, worker] of workers) {
          const state = agents.get(name);
          if (state?.running) {
            console.error(`[porter] Force-terminating isolate: ${name}`);
            worker.terminate();
            state.running = false;
          }
        }
      }

      // Save snapshot before shutting down
      const path = await porter.snapshot();
      console.error(`[porter] Snapshot saved to ${path}`);

      heartbeat.stop();
      await display.close();

      // Close MCP server connections
      if (mcpClients) {
        for (const [name, client] of mcpClients) {
          client.close();
          console.error(`[porter] MCP server '${name}' disconnected`);
        }
      }

      // Stop container sandbox
      if (sandboxExecutor) {
        await sandboxExecutor.stop();
        console.error("[porter] Sandbox container removed");
      }

      // Flush persisted messages
      await messageStore.close();

      // Kill tmux session
      await transport.killSession(config.session);
    },

    async snapshot(path?: string) {
      const dest = path ?? snapshotPath(config.session, config.working_dir);
      let memoryTurtle: string | undefined;
      try {
        if (graphStoreRef) {
          const { GRAPHS } = await import("../graph/vocabulary.ts");
          memoryTurtle = graphStoreRef.dump(GRAPHS.memory);
        }
      } catch (e) {
        console.error(`[porter] Memory graph dump failed: ${(e as Error).message}`);
      }
      await saveSnapshot(dest, config.session, agents, memoryTurtle);
      return dest;
    },
  };

  // In non-isolate mode, wait for all agents in the background
  if (!useIsolates && agentPromises.length > 0) {
    Promise.allSettled(agentPromises).then(() => {
      console.error("[porter] All agents finished.");
    });
  }

  return porter;
}

// ---------------------------------------------------------------------------
// Provider config resolution
// ---------------------------------------------------------------------------

import type { AgentConfig } from "../core/config.ts";
import { ModelRegistry } from "../core/model_registry.ts";
import { ToolShimProvider } from "../providers/tool_shim.ts";
import { collectMcpTools, type McpClient } from "../mcp/mcp_client.ts";
import type { ModelProvider } from "../providers/mod.ts";
import type { ToolEntry } from "../tools/mod.ts";

/**
 * Build a default ProviderConfig from the top-level PorterConfig.
 * Uses the config's providers[] array, which loadConfig() always normalizes.
 */
function resolveDefaultProviderConfig(config: PorterConfig): ProviderConfig {
  if (config.providers && config.providers.length > 0) {
    return config.providers[0];
  }

  return {
    type: "openai_compat",
    base_url: Deno.env.get("MODEL_API") ?? "",
    api_key_env: config.api_key_env,
  };
}

/**
 * Resolve ProviderConfig for a specific agent.
 * Uses the model registry to determine the correct provider type.
 */
function resolveAgentProviderConfig(
  agentConfig: AgentConfig,
  config: PorterConfig,
  defaultConfig: ProviderConfig,
): ProviderConfig {
  const model = agentConfig.model ?? config.model;
  if (!model) return defaultConfig;

  const providers = config.providers ?? [defaultConfig];
  const registry = config.models ? ModelRegistry.fromModels(config.models) : new ModelRegistry();
  const resolved = registry.resolveProvider(model, providers);
  return resolved ?? defaultConfig;
}

/**
 * Create a ModelProvider for an agent, wrapping with ToolShimProvider
 * if the model lacks native tool calling support.
 */
function createAgentProvider(
  providerConfig: ProviderConfig,
  modelId: string,
): ModelProvider {
  let provider = createProvider(providerConfig);

  const registry = new ModelRegistry();
  const modelEntry = registry.lookup(modelId);
  if (modelEntry && !modelEntry.capabilities.tool_calling) {
    provider = new ToolShimProvider(provider);
  }

  return provider;
}

/**
 * Collect MCP tools for an agent based on its mcp_tools config.
 */
function resolveAgentMcpTools(
  agentConfig: AgentConfig,
  mcpClients: Map<string, McpClient> | null,
): ToolEntry[] {
  if (!mcpClients || !agentConfig.mcp_tools?.length) return [];
  return collectMcpTools(mcpClients, agentConfig.mcp_tools);
}
