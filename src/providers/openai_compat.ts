/**
 * OpenAI-compatible provider adapter.
 *
 * Handles Granite, Mistral, Qwen, Llama, GPT-OSS, and any other model
 * served via vLLM or OpenAI-compatible endpoints.
 *
 * Endpoint: ${base_url}/v1/chat/completions
 * Auth:     Authorization: Bearer ${api_key}
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

// -- OpenAI wire types (subset we need) --

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OaiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OaiResponse {
  choices: {
    message: {
      role: "assistant";
      content?: string | null;
      tool_calls?: OaiToolCall[];
    };
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// -- Translation functions --

function toOaiTools(tools: ToolDefinition[]): OaiTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function toOaiMessages(
  system: string,
  messages: ChatMessage[],
): OaiMessage[] {
  const out: OaiMessage[] = [{ role: "system", content: system }];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Array of content blocks — split into text, tool_use (assistant), and tool_result (user)
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OaiToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: OaiMessage = { role: "assistant" };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
        assistantMsg.content = null as unknown as string;
      } else if (textParts.length > 0) {
        assistantMsg.content = textParts.join("\n");
      }
      out.push(assistantMsg);
    } else {
      // User message — may contain text or tool_result blocks
      const textParts: string[] = [];
      const toolResults: { tool_call_id: string; content: string }[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          toolResults.push({
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }

      // Emit tool results as individual "tool" role messages
      for (const tr of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: tr.tool_call_id,
          content: tr.content,
        });
      }

      // Emit remaining text as a user message
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("\n") });
      }
    }
  }

  return out;
}

function fromOaiResponse(resp: OaiResponse): ChatResponse {
  const choice = resp.choices[0];
  if (!choice) {
    throw new ProviderError(500, "Empty response from OpenAI-compatible API");
  }

  const content: ContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const stopMap: Record<string, ChatResponse["stop_reason"]> = {
    stop: "end_turn",
    tool_calls: "tool_use",
    length: "max_tokens",
    content_filter: "end_turn",
  };

  return {
    content,
    stop_reason: stopMap[choice.finish_reason] ?? "end_turn",
    usage: {
      input_tokens: resp.usage.prompt_tokens,
      output_tokens: resp.usage.completion_tokens,
    },
  };
}

function extractHeaders(
  resp: Response,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const val = resp.headers.get(key);
    if (val) out[key] = val;
  }
  return out;
}

// -- Provider implementation --

export class OpenAICompatProvider implements ModelProvider {
  readonly name = "openai_compat";

  constructor(
    baseUrl: string,
    private apiKey: string,
    private chatEndpoint: string = "/v1/chat/completions",
  ) {
    this.baseUrl = baseUrl.replace(/\/v1\/?$/, "");
  }

  private baseUrl: string;

  async createMessage(params: CreateMessageParams): Promise<ChatResponse> {
    const url = `${this.baseUrl}${this.chatEndpoint}`;

    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.max_tokens,
      messages: toOaiMessages(params.system, params.messages),
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = toOaiTools(params.tools);
      if (params.tool_choice) {
        body.tool_choice = params.tool_choice;
      }
    }

    if (params.reasoning && this.chatEndpoint === "/v1/chat/completions") {
      body.chat_template_kwargs = { thinking: true };
    }

    const { getHttpClient } = await import("./types.ts");
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
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

    const json = (await resp.json()) as OaiResponse;
    return fromOaiResponse(json);
  }
}
