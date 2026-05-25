/**
 * Provider-neutral types for the Porter agent system.
 *
 * These types decouple the agent loop and tool system from any specific
 * model API (Anthropic, OpenAI, Gemini). Provider adapters translate
 * between these types and the wire format of each API.
 */

/** A provider-neutral tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A single message in conversation history. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** A content block in a message. */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** The provider-neutral response from a model call. */
export interface ChatResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "stop_sequence" | "max_tokens";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** The unified interface every provider must implement. */
export interface ModelProvider {
  readonly name: string;

  createMessage(params: CreateMessageParams): Promise<ChatResponse>;
}

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system: string;
  tools?: ToolDefinition[];
  messages: ChatMessage[];
  /** Enable reasoning/thinking mode (OpenAI-compat models via chat_template_kwargs). */
  reasoning?: boolean;
  /** Tool calling mode: auto (default), required (force tool use), none (force text). */
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
}

export type ProviderType =
  | "openai"
  | "openai_compat"
  | "azure_openai"
  | "anthropic"
  | "aws_bedrock"
  | "vertex_ai"
  | "vertex_claude"
  | "vertex_gemini"
  | "groq"
  | "ollama";

/** Configuration for connecting to a model provider. */
export interface ProviderConfig {
  type: ProviderType;
  /** Model's dedicated API base URL (the model API base URL). */
  base_url: string;
  /** Resolved API key (${USER_KEY}). Mutually exclusive with api_key_env at runtime. */
  api_key?: string;
  /** Environment variable name holding the API key. Fallback for headless/CLI mode. */
  api_key_env?: string;
  /** Claude only: tier name mapping to URL path segment ("sonnet", "haiku", "opus"). */
  tier?: string;
  /** Optional credential reference name (resolved from user's CredentialStore). */
  credential_ref?: string;
  /** Override the default chat completions endpoint path (e.g. "/v1beta/openai/chat/completions" for Gemini). */
  chat_endpoint?: string;
  /** Authentication method. "bearer" (default): static token from api_key/api_key_env. "adc": Google Application Default Credentials via gcloud CLI. */
  auth?: "bearer" | "adc";
  /** Model IDs this provider serves. Used to match per-model providers. */
  models?: string[];
}

/**
 * Error thrown by provider adapters for retryable/non-retryable API errors.
 * Replaces the Anthropic SDK's APIError with a provider-neutral equivalent.
 */
export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Shared HTTP client with extra CA certificates loaded from the cluster
 * CA bundle and NODE_EXTRA_CA_CERTS. Lazily initialized on first use.
 */
let _httpClient: Deno.HttpClient | undefined;

export function getHttpClient(): Deno.HttpClient | undefined {
  if (_httpClient) return _httpClient;

  const caCerts: string[] = [];
  const certPaths = [
    Deno.env.get("NODE_EXTRA_CA_CERTS"),
    "/etc/porter-certs/ca-bundle.crt",
    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    "/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
  ];
  for (const p of certPaths) {
    if (!p) continue;
    try {
      caCerts.push(Deno.readTextFileSync(p));
    } catch { /* not available */ }
  }

  if (caCerts.length === 0) return undefined;
  _httpClient = Deno.createHttpClient({ caCerts });
  return _httpClient;
}
