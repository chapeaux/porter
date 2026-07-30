/**
 * Vertex AI Claude provider adapter.
 *
 * Handles Claude models (Sonnet, Haiku, Opus) served via model provider
 * Vertex AI proxy.
 *
 * Endpoint: ${base_url}/${tier}/models/${MODEL_ID}:streamRawPredict
 * Auth:     Authorization: Bearer ${api_key}
 *
 * The Claude API format is very close to our unified types (which were
 * modeled on it), so this adapter is mostly a pass-through.
 */

import type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  CreateMessageParams,
  ModelProvider,
  ToolDefinition,
} from "./types.ts";
import { ProviderError } from "./types.ts";

// -- Claude wire types --

interface ClaudeRequest {
  anthropic_version: string;
  model: string;
  max_tokens: number;
  system: string;
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: ClaudeContentBlock[] | string;
}

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ClaudeResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ClaudeContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "stop_sequence" | "max_tokens";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// -- Translation --

function toClaudeMessages(messages: ChatMessage[]): ClaudeMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: [{ type: "text" as const, text: m.content }] };
    }
    // Content blocks map 1:1 between our types and Claude's
    return { role: m.role, content: m.content as ClaudeContentBlock[] };
  });
}

function toClaudeTools(tools: ToolDefinition[]): ClaudeTool[] {
  return tools.map((t) => {
    const schema = { ...t.input_schema };
    // Claude rejects empty required arrays — omit if empty
    if (schema.required && schema.required.length === 0) {
      delete (schema as Record<string, unknown>).required;
    }
    return { name: t.name, description: t.description, input_schema: schema };
  });
}

function extractHeaders(resp: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const val = resp.headers.get(key);
    if (val) out[key] = val;
  }
  return out;
}

// -- ADC token cache --

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getGcloudAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) {
    return _cachedToken.token;
  }

  const cmd = new Deno.Command("gcloud", {
    args: ["auth", "application-default", "print-access-token"],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`gcloud auth failed (exit ${code}): ${err}`);
  }

  const token = new TextDecoder().decode(stdout).trim();
  _cachedToken = { token, expiresAt: Date.now() + 45 * 60 * 1000 };
  return token;
}

// -- Provider implementation --

export class VertexClaudeProvider implements ModelProvider {
  readonly name = "vertex_claude";

  constructor(
    private baseUrl: string,
    private apiKey: string | null,
    private tier: string,
    private useAdc: boolean = false,
  ) {}

  private async getAuthToken(): Promise<string> {
    if (this.useAdc) return getGcloudAccessToken();
    return this.apiKey!;
  }

  async createMessage(params: CreateMessageParams): Promise<ChatResponse> {
    const endpoint = this.useAdc ? "rawPredict" : "streamRawPredict";
    const url = this.tier
      ? `${this.baseUrl}/${this.tier}/models/${params.model}:${endpoint}`
      : `${this.baseUrl}/models/${params.model}:${endpoint}`;
    console.error(`[vertex] POST ${url}`);
    const token = await this.getAuthToken();

    const body: Record<string, unknown> = {
      anthropic_version: "vertex-2023-10-16",
      max_tokens: params.max_tokens,
      system: [
        { type: "text", text: params.system, cache_control: { type: "ephemeral" } },
      ],
      messages: toClaudeMessages(params.messages),
    };

    if (params.tools && params.tools.length > 0) {
      const tools = toClaudeTools(params.tools);
      if (tools.length > 0) {
        (tools[tools.length - 1] as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" };
      }
      body.tools = tools;
    }

    const { getHttpClient } = await import("./types.ts");
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      client: getHttpClient(),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ProviderError(
        resp.status,
        `${resp.status} ${resp.statusText}: ${text}`,
        extractHeaders(resp),
      );
    }

    const json = (await resp.json()) as ClaudeResponse;

    // Claude's response format maps directly to our ContentBlock type
    return {
      content: json.content as ContentBlock[],
      stop_reason: json.stop_reason,
      usage: json.usage,
    };
  }
}
