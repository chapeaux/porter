/**
 * Pullman Porter -- a pure-Deno tmux agent orchestrator.
 *
 * @module
 *
 * @example
 * ```ts
 * import { loadConfig, start } from "@chapeaux/porter";
 *
 * const config = await loadConfig("porter.json");
 * const porter = await start(config);
 *
 * // Later...
 * await porter.stop();
 * ```
 */

export { loadConfig } from "./src/core/config.ts";
export { isAgentRef } from "./src/core/config.ts";
export type {
  AgentConfig,
  AgentRef,
  AgentRole,
  CollaborationPattern,
  PorterConfig,
  RepoConfig,
  RemoteConfig,
  ToolName,
  VertexConfig,
} from "./src/core/config.ts";

export { createClient, createProviderFromConfig } from "./src/core/client.ts";
export type { ClientOptions, ModelProvider } from "./src/core/client.ts";

export { createProvider } from "./src/providers/mod.ts";
export type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  ModelProvider as IModelProvider,
  ProviderConfig,
  ProviderType,
  ToolDefinition,
} from "./src/providers/mod.ts";
export { ProviderError } from "./src/providers/mod.ts";

export { start, provisionRepo } from "./src/orchestration/orchestrator.ts";
export type { Porter } from "./src/orchestration/orchestrator.ts";

export { runAgent, serializeState, deserializeState } from "./src/runtime/agent.ts";
export type { AgentEvent, AgentOutputHandler, AgentState, AgentUsage, CancelSignal } from "./src/runtime/agent.ts";

export { MessageBus, BusServer, BusClient, getBus, setBus, resetBus } from "./src/runtime/bus.ts";
export type { BusMessage, BusRelay, WireMessage } from "./src/runtime/bus.ts";

export { LocalTransport, NullTransport, RemoteTransport } from "./src/orchestration/transport.ts";
export type { PaneInfo, Transport } from "./src/orchestration/transport.ts";

export { DisplayManager } from "./src/orchestration/display.ts";

export { HeartbeatMonitor } from "./src/runtime/heartbeat.ts";
export type { DeadAgentHandler } from "./src/runtime/heartbeat.ts";

export { RateLimitCoordinator, getCoordinator, setCoordinator, resetCoordinator } from "./src/runtime/rate_limiter.ts";
export type { RateLimitState } from "./src/runtime/rate_limiter.ts";

export { saveSnapshot, loadSnapshot, restoreAgentStates, snapshotPath } from "./src/runtime/snapshot.ts";
export type { Snapshot } from "./src/runtime/snapshot.ts";

export { ClusterManager } from "./src/cluster/cluster.ts";
export type { ClusterInfo, PodStatus } from "./src/cluster/cluster.ts";

export { buildRegistry, getDefinitions, ToolRegistry } from "./src/tools/mod.ts";
export type { ToolEntry, ToolResult } from "./src/tools/mod.ts";

export { ModelRegistry } from "./src/core/model_registry.ts";
export type { ModelConfig, ProviderType as ModelProviderType } from "./src/core/model_registry.ts";

export { ModelStore } from "./src/auth/model_store.ts";

export { GraphStore, getGraphStore, setGraphStore, initGraphStore } from "./src/graph/store.ts";
export { PORTER, AS, PROV, GRAPHS, PREFIXES } from "./src/graph/vocabulary.ts";

export { McpClient, connectMcpServers, collectMcpTools } from "./src/mcp/mcp_client.ts";
export type { McpServerConfig } from "./src/mcp/mcp_client.ts";

export { PorterMcpServer, runStdioMcpServer } from "./src/mcp/mcp_server.ts";

export {
  discover as oidcDiscover,
  loadOidcConfig,
  initSessionKey,
  createSessionCookie,
  readSession,
  clearSessionCookie,
  generateCsrf,
  validateCsrf,
  clearCsrfCookie,
  validateToken,
  extractUser,
  requireAuth,
  CredentialStore,
  UserStore,
} from "./src/auth/mod.ts";
export type {
  OidcConfig,
  OidcDiscovery,
  TokenResponse,
  SessionData,
  AuthenticatedUser,
  StoredCredential,
  RedactedCredential,
  SavedTeam,
} from "./src/auth/mod.ts";

export {
  registerSession,
  unregisterSession,
  listSessions,
  getSession,
  pruneStale,
  findAvailablePort,
} from "./src/orchestration/registry.ts";
export type { SessionRecord } from "./src/orchestration/registry.ts";

export { SessionManager } from "./src/orchestration/session_manager.ts";
export type { ManagedSession } from "./src/orchestration/session_manager.ts";

export { handleActivityPubRoutes } from "./src/activitypub/routes.ts";
export type { ApRouteOptions } from "./src/activitypub/routes.ts";
export {
  resolveApConfig,
  apBaseUrl,
  LocalFederationStore,
  handleWebFinger,
  buildActorDocument,
  buildWelcomeMessage,
  handleActorRequest,
  getOrCreateKeyPair,
  signRequest,
  verifySignature,
  getApContext,
  setApContext,
  resetApContext,
  publishTeam,
  unpublishTeam,
  resolveOwner,
  listFederated,
  AP_CONTEXT,
  AP_PUBLIC,
  AP_CONTENT_TYPE,
} from "./src/activitypub/mod.ts";
export type {
  ActivityPubConfig,
  ActivityPubBackend,
  FederationStore,
  FollowerRecord,
  ConversationMap,
  ApContext,
  SessionHandle,
  SessionStatus,
  Actor,
  Activity,
  APObject,
} from "./src/activitypub/mod.ts";
