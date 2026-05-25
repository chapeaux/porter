/**
 * Direct Anthropic API provider adapter.
 *
 * Talks to the Anthropic Messages API at https://api.anthropic.com/v1/messages.
 *
 * Endpoint: https://api.anthropic.com/v1/messages
 * Auth:     x-api-key: ${api_key}
 * Header:   anthropic-version: 2023-06-01
 *
 * The Claude Messages API format is very close to our unified types (which
 * were modeled on it), so this adapter is mostly a pass-through — similar to
 * VertexClaudeProvider but using direct Anthropic auth instead of Vertex AI.
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

// -- Claude wire types (shared format with Vertex Claude) --

interface ClaudeRequest {
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

// -- Provider implementation --

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private auth: string = "x-api-key",
    private chatEndpoint: string = "/v1/messages",
  ) {}

  async createMessage(params: CreateMessageParams): Promise<ChatResponse> {
    const url = `${this.baseUrl}${this.chatEndpoint}`;

    const isVertex = this.chatEndpoint !== "/v1/messages";

    const body: Record<string, unknown> = {
      max_tokens: params.max_tokens,
      system: params.system,
      messages: toClaudeMessages(params.messages),
    };

    if (isVertex) {
      body.anthropic_version = "vertex-2023-10-16";
    } else {
      body.model = params.model;
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = toClaudeTools(params.tools);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.auth === "bearer"
        ? { "Authorization": `Bearer ${this.apiKey}` }
        : { "x-api-key": this.apiKey }),
    };
    if (!isVertex) {
      headers["anthropic-version"] = "2023-06-01";
    }

    const { getHttpClient } = await import("./types.ts");
    const resp = await fetch(url, {
      method: "POST",
      headers,
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
