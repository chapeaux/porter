/**
 * Porter configuration types and loader.
 */

import { dirname, resolve } from "@std/path";
import { validateToolSpec } from "../router/tool_registry.ts";

/** Tool names that can be assigned to agents. */
export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "bash"
  | "glob"
  | "grep"
  | "list_dir"
  | "send_message"
  | "read_messages"
  | "git"
  | "memory"
  | "memory_admin"
  | "ap_post"
  | "ap_reply"
  | "finding_write"
  | "findings_query"
  | "critique_write"
  | "critiques_query"
  | "approve"
  | "plan_write"
  | "plan_query"
  | "step_update";

/** Agent role for organizational purposes. */
export type AgentRole =
  | "admin"
  | "worker"
  | "reviewer"
  | "specialist"
  | "synthesizer"
  | "reflector"
  | "expert"
  | "learner"
  | "librarian";

/** Collaboration pattern for the team. */
export type CollaborationPattern = "sequential" | "mixture" | "deliberation" | "distillation";

/** Configuration for a single agent. */
/**
 * Agent reference — a team references an agent by name or URI
 * instead of embedding the full config. Resolved at session launch.
 */
export interface AgentRef {
  /** Agent name (local library) or URI (remote/Solid Pod). */
  ref: string;
  /** Display name (defaults to ref if not set). */
  name: string;
  /** Role assigned by the team's pattern. */
  role: AgentRole;
  /** Optional model override for this team context. */
  model?: string;
  /** True if this is a remote link (not a local copy). */
  _linked?: boolean;
  /** True if the ref could not be resolved. */
  _missing?: boolean;
}

/** Check whether an agent entry is a reference or a full config. */
export function isAgentRef(a: AgentConfig | AgentRef): a is AgentRef {
  return "ref" in a && !("system_prompt" in a);
}

export interface AgentConfig {
  /** Display name for this agent. */
  name: string;
  /** Role determines default behaviors and display. */
  role: AgentRole;
  /** Model to use. Overrides the top-level default. */
  model?: string;
  /**
   * System prompt injected at the start of the conversation.
   * - If the value starts with `http://` or `https://`, it is fetched as a URL.
   * - If the value ends with `.md`, it is treated as a file path
   *   (relative to the config file) and the file contents are used.
   * - Otherwise it is used as a literal string.
   */
  system_prompt: string;
  /** Tools this agent is allowed to use. */
  tools: ToolName[];
  /** Message bus channels this agent subscribes to. */
  subscribe?: string[];
  /** Maximum tokens per response. */
  max_tokens?: number;
  /** Maximum conversation turn pairs to keep in context. Oldest turns are dropped. */
  max_turns?: number;
  /** Maximum estimated input tokens. Oldest turns are dropped when exceeded (~4 chars/token). */
  max_context_tokens?: number;
  /** Working directory for file/shell operations. Inherited from PorterConfig if not set. */
  working_dir?: string;
  /** Enable reasoning/thinking mode (chat_template_kwargs for OpenAI-compat models). */
  reasoning?: boolean;
  /** MCP tools this agent can use. Format: "server_name.*" or "server_name.tool_name". */
  mcp_tools?: string[];
  /** Auto-execute bash/shell code blocks found in model output. Default: false. */
  auto_execute_bash?: boolean;
  /** Flag this agent as using a small model. Enables simplified tool schemas and the tool inference engine. Auto-detected from model name if not set. */
  small_model?: boolean;
}

/** Vertex AI configuration. */
export interface VertexConfig {
  /** GCP project ID. Falls back to ANTHROPIC_VERTEX_PROJECT_ID env var. */
  project_id?: string;
  /** GCP region. Falls back to CLOUD_ML_REGION env var. */
  region?: string;
}

/** Git repository to clone for this session. */
export interface RepoConfig {
  /** Remote URL (https or ssh). */
  url: string;
  /** Branch to checkout. Default: default branch. */
  branch?: string;
  /** Env var holding auth token for HTTPS clones. */
  token_env?: string;
  /** If true, do a shallow clone (--depth 1). */
  shallow?: boolean;
}

/** Remote cluster configuration for OpenShift deployment. */
export interface RemoteConfig {
  type: "openshift";
  /** Kubernetes context name. */
  context: string;
  /** Target namespace. */
  namespace: string;
  /** Container image for worker pods. */
  image: string;
}

/** Container sandbox configuration. */
export interface SandboxConfig {
  enabled: boolean;
  image?: string;
  runtime?: "podman" | "docker";
}

/** Runtime tool entry — either a short name or a custom spec. */
export type RuntimeToolEntry = string | { name: string; image: string; binPath: string };

/** Top-level Porter configuration. */
export interface PorterConfig {
  /** tmux session name. */
  session: string;
  /** @deprecated Use providers[] instead. API provider: "anthropic" or "vertex". */
  provider?: "anthropic" | "vertex";
  /** Environment variable name holding the API key. */
  api_key_env: string;
  /** @deprecated Use providers[] instead. Vertex AI configuration. */
  vertex?: VertexConfig;
  /** Default model for all agents. */
  model: string;
  /** Working directory for file operations. Derived from repo if not set. */
  working_dir?: string;
  /** Git repository to clone for this session. */
  repo?: RepoConfig;
  /** Heartbeat timeout in milliseconds. Default: 120000. */
  heartbeat_timeout_ms?: number;
  /** Remote cluster config. Omit for local-only. */
  remote?: RemoteConfig;
  /** Agent definitions. */
  agents: AgentConfig[];
  /** Run agents in V8 isolate Workers. Default: true. */
  isolates?: boolean;
  /** Bus WebSocket port. Default: auto-assigned starting from 8787. */
  bus_port?: number;
  /** Provider configurations. Multiple providers can be configured for mixed-model teams. */
  providers?: import("../providers/types.ts").ProviderConfig[];
  /** Session-level environment variables injected into agent bash/git commands. */
  env?: Record<string, string>;
  /** External MCP servers to connect to for additional tools. */
  mcp_servers?: Record<string, import("../mcp/mcp_client.ts").McpServerConfig>;
  /** User-defined model configurations. Defines available models, their endpoints, and capabilities. */
  models?: import("../auth/model_store.ts").ModelConfig[];
  /** Runtime tools to inject into agent pods (e.g. "python3", "curl"). */
  runtime_tools?: RuntimeToolEntry[];
  /** Collaboration pattern. Default: "sequential" (existing admin/worker/reviewer). */
  pattern?: CollaborationPattern;
  /** Maximum deliberation rounds (deliberation pattern only). Default: 3. */
  max_deliberation_rounds?: number;
  /** tmux layout: "windows" (default, one window per agent) or "panes" (all agents in one window). */
  tmux_layout?: "windows" | "panes";
  /** Container sandbox configuration. When true, enables default sandbox. */
  sandbox?: boolean | SandboxConfig;
  /** ActivityPub federation configuration. Enables fediverse interaction with teams. */
  activitypub?: import("../activitypub/config.ts").ActivityPubConfig;
}

/** Default config values. */
const DEFAULTS = {
  model: "claude-sonnet-4-6",
  api_key_env: "ANTHROPIC_API_KEY",
  heartbeat_timeout_ms: 120_000,
  max_tokens: 8192,
  max_turns: 30,
  max_context_tokens: 32_000,
} as const;

/**
 * Heuristic detection of "small" models (roughly <=8B parameters, or known
 * small-model families) that benefit from simplified tool schemas and the
 * tool inference engine (see src/tools/inference_engine.ts). Not exhaustive —
 * agents can always set `small_model` explicitly to override this.
 */
export function detectSmallModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  if (/granite|phi-?\d|gemma/.test(id)) return true;
  const paramMatch = id.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (paramMatch) {
    const params = parseFloat(paramMatch[1]);
    if (params > 0 && params <= 8) return true;
  }
  return false;
}

/** Replace ${VAR_NAME} patterns with environment variable values. */
function interpolateEnv(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_, name) => {
    return Deno.env.get(name) ?? "";
  });
}

/** Load and validate a Porter config from a JSON file. */
export async function loadConfig(path: string): Promise<PorterConfig> {
  let text = await Deno.readTextFile(path);
  text = interpolateEnv(text);
  const raw = JSON.parse(text) as Partial<PorterConfig>;

  if (!raw.session) throw new Error("config: 'session' is required");
  if (!raw.agents?.length) throw new Error("config: 'agents' must have at least one entry");

  // working_dir can be derived from repo at session start; require at least one
  const working_dir = raw.working_dir ??
    (raw.repo
      ? `${Deno.env.get("HOME") ?? Deno.cwd()}/.porter/workspaces/${raw.session}`
      : undefined);
  if (!working_dir) {
    throw new Error("config: either 'working_dir' or 'repo' is required");
  }

  const configDir = dirname(resolve(path));

  const agents = await Promise.all(
    raw.agents.map(async (a) => {
      let systemPrompt = a.system_prompt;

      // If system_prompt is a URL, fetch its contents
      if (systemPrompt.startsWith("http://") || systemPrompt.startsWith("https://")) {
        try {
          const resp = await fetch(systemPrompt);
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
          }
          systemPrompt = (await resp.text()).trim();
        } catch (err) {
          throw new Error(
            `config: could not fetch system_prompt URL '${a.system_prompt}' for agent '${a.name}': ${(err as Error).message}`,
          );
        }
      }
      // If system_prompt is a .md file path, read its contents
      else if (systemPrompt.endsWith(".md")) {
        const promptPath = resolve(configDir, systemPrompt);
        try {
          systemPrompt = (await Deno.readTextFile(promptPath)).trim();
        } catch (err) {
          throw new Error(
            `config: could not read system_prompt file '${promptPath}' for agent '${a.name}': ${(err as Error).message}`,
          );
        }
      }

      return {
        name: a.name,
        role: a.role,
        model: a.model,
        system_prompt: systemPrompt,
        tools: a.tools,
        subscribe: a.subscribe ?? [],
        max_tokens: a.max_tokens ?? DEFAULTS.max_tokens,
        max_turns: a.max_turns ?? DEFAULTS.max_turns,
        max_context_tokens: a.max_context_tokens ?? DEFAULTS.max_context_tokens,
        working_dir: a.working_dir,
        reasoning: a.reasoning,
        mcp_tools: a.mcp_tools,
        auto_execute_bash: a.auto_execute_bash,
      };
    }),
  );

  // Normalize providers: if providers[] is present, use it directly.
  // Otherwise, build from legacy provider/api_key_env/vertex fields.
  let providers = (raw as Record<string, unknown>).providers as
    import("../providers/types.ts").ProviderConfig[] | undefined;

  if (!providers) {
    providers = normalizeProviders(
      raw.provider,
      raw.api_key_env ?? DEFAULTS.api_key_env,
      raw.vertex,
    );
  }

  // Validate runtime_tools entries (fail fast on unknown names or disallowed registries)
  const runtimeTools = (raw as Record<string, unknown>).runtime_tools as
    RuntimeToolEntry[] | undefined;
  if (runtimeTools) {
    if (!Array.isArray(runtimeTools)) {
      throw new Error("config: 'runtime_tools' must be an array");
    }
    for (const entry of runtimeTools) {
      validateToolSpec(entry);
    }
  }

  // Normalize sandbox config
  const rawSandbox = (raw as Record<string, unknown>).sandbox;
  let sandbox: SandboxConfig | undefined;
  if (rawSandbox === true) {
    sandbox = { enabled: true };
  } else if (typeof rawSandbox === "object" && rawSandbox !== null) {
    sandbox = rawSandbox as SandboxConfig;
  }

  const config: PorterConfig = {
    session: raw.session,
    provider: raw.provider,
    api_key_env: raw.api_key_env ?? DEFAULTS.api_key_env,
    vertex: raw.vertex,
    model: raw.model ?? DEFAULTS.model,
    working_dir,
    repo: raw.repo,
    heartbeat_timeout_ms: raw.heartbeat_timeout_ms ?? DEFAULTS.heartbeat_timeout_ms,
    remote: raw.remote,
    agents,
    isolates: raw.isolates,
    bus_port: raw.bus_port,
    providers,
    mcp_servers: (raw as Record<string, unknown>).mcp_servers as
      Record<string, import("../mcp/mcp_client.ts").McpServerConfig> | undefined,
    runtime_tools: runtimeTools,
    pattern: (raw as Record<string, unknown>).pattern as CollaborationPattern | undefined,
    max_deliberation_rounds: (raw as Record<string, unknown>).max_deliberation_rounds as number | undefined,
    tmux_layout: (raw as Record<string, unknown>).tmux_layout as "windows" | "panes" | undefined,
    sandbox,
  };

  // Optional SHACL validation (non-blocking, logs mismatches)
  try {
    const { validateConfig } = await import("../graph/validate.ts");
    const result = await validateConfig(config);
    if (!result.conforms) {
      for (const v of result.violations) {
        console.error(`[porter] SHACL: ${v.message}${v.path ? ` (${v.path})` : ""}`);
      }
    }
  } catch { /* graph module not available — skip */ }

  return config;
}

/**
 * Normalize legacy single-provider fields into a providers[] array.
 */
function normalizeProviders(
  provider?: "anthropic" | "vertex",
  apiKeyEnv?: string,
  vertex?: VertexConfig,
): import("../providers/types.ts").ProviderConfig[] {
  const keyEnv = apiKeyEnv ?? DEFAULTS.api_key_env;

  if (provider === "vertex") {
    return [{
      type: "vertex_claude",
      base_url: Deno.env.get("VERTEX_BASE_URL") ?? "",
      api_key_env: keyEnv,
      tier: "sonnet",
    }];
  }

  // Auto-detect Vertex from CLAUDE_CODE_USE_VERTEX (same env var Claude Code uses)
  if (Deno.env.get("CLAUDE_CODE_USE_VERTEX") === "1") {
    const project = Deno.env.get("ANTHROPIC_VERTEX_PROJECT_ID") ?? "";
    const region = Deno.env.get("CLOUD_ML_REGION") ?? "us-east5";
    const host = region === "global"
      ? "https://aiplatform.googleapis.com/v1"
      : `https://${region}-aiplatform.googleapis.com/v1`;
    const baseUrl = Deno.env.get("VERTEX_BASE_URL") ??
      `${host}/projects/${project}/locations/${region}/publishers/anthropic`;
    return [{
      type: "vertex_claude",
      base_url: baseUrl,
      auth: "adc",
    }];
  }

  // Default: openai_compat (covers both legacy Anthropic and vLLM models)
  return [{
    type: "openai_compat",
    base_url: Deno.env.get("MODEL_API") ?? "",
    api_key_env: keyEnv,
  }];
}
