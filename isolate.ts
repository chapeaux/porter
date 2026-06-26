/// <reference lib="deno.worker" />

/**
 * V8 Isolate Worker entry point.
 *
 * Each agent runs inside its own `new Worker()` isolate.  Shared singletons
 * (`MessageBus`, `RateLimitCoordinator`) live in the main thread and are
 * accessed via postMessage proxies injected before `runAgent()` starts.
 *
 * Wire protocol (Main → Worker):
 *   { type: "start",  agentConfig, initialPrompt, model, providerConfig, resumeFrom? }
 *   { type: "cancel" }
 *   { type: "bus_drain_response",  id, messages: BusMessage[] }
 *   { type: "rate_limit_acquired", id }
 *
 * Wire protocol (Worker → Main):
 *   { type: "event",              agentName, event: AgentEvent }
 *   { type: "bus_publish",        channel, content, from }
 *   { type: "bus_drain",          id, agentName, channel? }
 *   { type: "rate_limit_acquire", id, agentName }
 *   { type: "rate_limit_report",  agentName, retryAfterMs }
 *   { type: "done",               agentName, state: string }
 *   { type: "error",              agentName, message }
 */

import type { BusMessage } from "./src/runtime/bus.ts";
import { setBus } from "./src/runtime/bus.ts";
import type { MessageBus } from "./src/runtime/bus.ts";
import { setCoordinator } from "./src/runtime/rate_limiter.ts";
import type { RateLimitCoordinator } from "./src/runtime/rate_limiter.ts";
import { createProvider } from "./src/providers/mod.ts";
import type { ProviderConfig } from "./src/providers/mod.ts";
import {
  runAgent,
  serializeState,
  deserializeState,
  type AgentEvent,
  type CancelSignal,
} from "./src/runtime/agent.ts";
import type { AgentConfig } from "./src/core/config.ts";

// ---------------------------------------------------------------------------
// RPC layer — request-response over postMessage using callback IDs
// ---------------------------------------------------------------------------

const pending = new Map<number, (value: unknown) => void>();
let nextId = 0;

function rpc(msg: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    self.postMessage({ ...msg, id });
  });
}

// ---------------------------------------------------------------------------
// GraphStoreProxy — proxies memory_write / memory_query to the main thread
// ---------------------------------------------------------------------------

class GraphStoreProxy {
  addTriple(subject: string, predicate: string, object: string, graph?: string): void {
    self.postMessage({ type: "graph_add_triple", subject, predicate, object, graph });
  }

  addLiteral(subject: string, predicate: string, value: string | number | boolean, graph?: string): void {
    self.postMessage({ type: "graph_add_literal", subject, predicate, value, graph });
  }

  async query(sparql: string): Promise<Record<string, string>[]> {
    const result = await rpc({ type: "graph_query", sparql });
    return (result as { rows: Record<string, string>[] }).rows ?? [];
  }

  // Stubs for methods the tools don't use from isolates
  validate(): { conforms: boolean; violations: never[] } { return { conforms: true, violations: [] }; }
  describe(): Record<string, string | string[]> { return {}; }
  load(): void {}
  dump(): string { return ""; }
  update(): void {}
}

// ---------------------------------------------------------------------------
// VectorStoreProxy — proxies embedding + vector ops to the main thread
// ---------------------------------------------------------------------------

class VectorStoreProxy {
  async ensureCollection(): Promise<void> { /* main thread handles this */ }

  async upsert(collection: string, points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>): Promise<void> {
    self.postMessage({ type: "vector_upsert", collection, points });
  }

  async search(collection: string, vector: number[], filter?: Record<string, unknown>, limit?: number): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const result = await rpc({ type: "vector_search", collection, vector, filter, limit });
    return (result as { points: Array<{ id: string; score: number; payload: Record<string, unknown> }> }).points ?? [];
  }
}

class EmbedderProxy {
  readonly dimensions = 0;
  readonly name = "proxy";

  async embed(texts: string[]): Promise<number[][]> {
    const result = await rpc({ type: "embed_text", texts });
    return (result as { vectors: number[][] }).vectors ?? [];
  }
}

// ---------------------------------------------------------------------------
// BusProxy — implements the MessageBus interface over postMessage
// ---------------------------------------------------------------------------

class BusProxy {
  async publish(
    channel: string,
    content: string,
    from: string = "system",
  ): Promise<void> {
    // Fire-and-forget: no response needed
    self.postMessage({ type: "bus_publish", channel, content, from });
    await Promise.resolve();
  }

  async drain(
    subscriberId?: string,
    channel?: string,
  ): Promise<BusMessage[]> {
    const result = await rpc({
      type: "bus_drain",
      agentName: subscriberId,
      channel,
    });
    return (result as { messages: BusMessage[] }).messages ?? [];
  }

  subscribe(_subscriberId: string, _channels: string[]): void {
    // No-op — main thread owns all subscriptions
  }

  unsubscribe(_subscriberId: string): void {
    // No-op — main thread owns subscriptions
  }

  addRelay(_relay: unknown): void {
    // No-op — relays are main-thread only
  }

  removeRelay(_relay: unknown): void {
    // No-op — relays are main-thread only
  }

  pending(_subscriberId: string): number {
    // Cannot check synchronously across the isolate boundary
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CoordinatorProxy — implements the RateLimitCoordinator interface over postMessage
// ---------------------------------------------------------------------------

class CoordinatorProxy {
  async acquire(agentName: string, _cancel?: CancelSignal): Promise<void> {
    await rpc({ type: "rate_limit_acquire", agentName });
  }

  reportRateLimit(agentName: string, retryAfterMs: number): void {
    self.postMessage({ type: "rate_limit_report", agentName, retryAfterMs });
  }

  // Stub methods not called from within isolates
  applyRemoteState(_ms: number): void {}

  getState(): { cooldownRemainingMs: number } {
    return { cooldownRemainingMs: 0 };
  }

  onCooldown: null = null;
}

// ---------------------------------------------------------------------------
// Singleton proxy instances
// ---------------------------------------------------------------------------

const busProxy = new BusProxy();
const coordinatorProxy = new CoordinatorProxy();

// ---------------------------------------------------------------------------
// Cancellation signal (controlled by "cancel" messages from main thread)
// ---------------------------------------------------------------------------

const cancelSignal: CancelSignal = { cancelled: false };

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

self.onmessage = async (evt: MessageEvent) => {
  const data = evt.data as Record<string, unknown>;

  // Handle RPC responses (bus_drain_response, rate_limit_acquired)
  if (data.id !== undefined && pending.has(data.id as number)) {
    pending.get(data.id as number)!(data);
    pending.delete(data.id as number);
    return;
  }

  switch (data.type) {
    case "start": {
      // Install proxy singletons so getBus() / getCoordinator() inside
      // the agent loop return these proxies instead of real singletons.
      setBus(busProxy as unknown as MessageBus);
      setCoordinator(coordinatorProxy as unknown as RateLimitCoordinator);

      // Create the ModelProvider from the serialized ProviderConfig
      const providerConfig = data.providerConfig as ProviderConfig;
      const provider = createProvider(providerConfig);

      // Deserialize resume state if provided
      const resumeState = data.resumeFrom
        ? deserializeState(data.resumeFrom as string)
        : undefined;

      // Output handler — relay AgentEvent messages to the main thread
      const onOutput = (name: string, event: AgentEvent): void => {
        self.postMessage({ type: "event", agentName: name, event });
      };

      // Heartbeat is implicit: the main thread beats on every worker message
      const onHeartbeat = (): void => {};

      const agentConfig = data.agentConfig as AgentConfig;

      const teamRoster = data.teamRoster as Array<{ name: string; role: string }> | undefined;

      // Install graph store proxy so memory_write/memory_query work in isolates
      const { setGraphStore } = await import("./src/graph/store.ts");
      setGraphStore(new GraphStoreProxy() as unknown as import("./src/graph/store.ts").GraphStore);

      // Install vector store proxy if main thread has vector store enabled
      if (data.vectorEnabled) {
        const { setVectorStore, setEmbedder } = await import("./src/vector/mod.ts");
        setVectorStore(new VectorStoreProxy() as unknown as import("./src/vector/mod.ts").VectorStore);
        setEmbedder(new EmbedderProxy() as unknown as import("./src/vector/mod.ts").EmbeddingProvider);
      }

      // Inject session-level environment variables into tools
      const sessionEnv = data.sessionEnv as Record<string, string> | undefined;
      if (sessionEnv && Object.keys(sessionEnv).length > 0) {
        const { setSessionEnv: setBashEnv } = await import("./src/tools/bash.ts");
        const { setSessionEnv: setGitEnv } = await import("./src/tools/git.ts");
        setBashEnv(sessionEnv);
        setGitEnv(sessionEnv);
      }

      // Initialize sandbox handle if orchestrator passed container info
      if (data.sandboxContainerName) {
        const { ContainerSandboxHandle } = await import("./src/sandbox/mod.ts");
        const handle = new ContainerSandboxHandle(
          data.sandboxRuntime as import("./src/sandbox/mod.ts").ContainerRuntime,
          data.sandboxContainerName as string,
          data.sandboxWorkingDir as string,
        );
        const { setSandboxExecutor: setBashSandbox } = await import("./src/tools/bash.ts");
        const { setSandboxExecutor: setGitSandbox } = await import("./src/tools/git.ts");
        setBashSandbox(handle);
        setGitSandbox(handle);

        // Set working dir for file tool path validation in the isolate
        const { setWorkingDir: setReadWd } = await import("./src/tools/read_file.ts");
        const { setWorkingDir: setWriteWd } = await import("./src/tools/write_file.ts");
        const { setWorkingDir: setEditWd } = await import("./src/tools/edit_file.ts");
        const { setWorkingDir: setGlobWd } = await import("./src/tools/glob.ts");
        const { setWorkingDir: setGrepWd } = await import("./src/tools/grep.ts");
        const { setWorkingDir: setListWd } = await import("./src/tools/list_dir.ts");
        const wd = data.sandboxWorkingDir as string;
        setReadWd(wd);
        setWriteWd(wd);
        setEditWd(wd);
        setGlobWd(wd);
        setGrepWd(wd);
        setListWd(wd);
      }

      try {
        const finalState = await runAgent(
          provider,
          agentConfig,
          data.initialPrompt as string,
          onOutput,
          onHeartbeat,
          resumeState,
          cancelSignal,
          undefined,
          teamRoster,
        );

        self.postMessage({
          type: "done",
          agentName: agentConfig.name,
          state: serializeState(finalState),
        });
      } catch (err) {
        self.postMessage({
          type: "error",
          agentName: agentConfig.name,
          message: (err as Error).message,
        });
      }
      break;
    }

    case "cancel":
      cancelSignal.cancelled = true;
      break;
  }
};
