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
      // Reasoning-model servers (e.g. llama.cpp with Qwen3 "Thinking" models)
      // return chain-of-thought separately from `content`, which can end up
      // empty if generation is cut off by max_tokens mid-thought.
      reasoning_content?: string | null;
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

  // Post-process: vLLM rejects "user" immediately after "tool".
  // Merge such user messages into the preceding tool result.
  for (let i = 1; i < out.length; i++) {
    if (out[i].role === "user" && out[i - 1].role === "tool") {
      out[i - 1].content = (out[i - 1].content ?? "") + "\n\n" + (out[i].content ?? "");
      out.splice(i, 1);
      i--;
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

  // A turn with neither content nor tool_calls (e.g. a reasoning model that
  // hit max_tokens mid-thought, leaving `content` empty) produces an assistant
  // history entry with nothing in it. Replayed on the next request, that
  // becomes {role: "assistant"} with no content/tool_calls field at all,
  // which OpenAI-compat servers reject with a 500 — and since the entry is
  // permanent in history, every retry fails identically. Always leave
  // something so the turn stays valid on replay.
  if (content.length === 0) {
    const fallback = choice.message.reasoning_content?.trim();
    content.push({
      type: "text",
      text: fallback ? `[thinking, truncated before a response]\n${fallback}` : "[no response generated]",
    });
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

  private chatEndpoint: string;

  constructor(
    baseUrl: string,
    private apiKey: string,
    chatEndpoint?: string,
  ) {
    // A default *parameter* only kicks in for `undefined` — an explicit ""
    // (e.g. a stored model config with an empty chat_endpoint field) would
    // silently bypass it and produce a request to the bare base URL with no
    // path at all, which most OpenAI-compat servers (incl. llama.cpp) 404 on.
    this.chatEndpoint = chatEndpoint || "/v1/chat/completions";

    // Strip a known /v1... suffix first, then any leftover trailing slash(es) —
    // otherwise a bare trailing slash on baseUrl (e.g. "http://host:port/")
    // combines with the leading "/" on chatEndpoint into a double slash,
    // which most OpenAI-compat servers (incl. llama.cpp) 404 on.
    this.baseUrl = baseUrl
      .replace(/\/v1\/(chat\/)?completions\/?$|\/v1\/?$/, "")
      .replace(/\/+$/, "");
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

    // Extended-thinking opt-in via chat_template_kwargs is a vLLM convention,
    // not OpenAI's — only applies on the default vLLM chat endpoint, not a
    // shim endpoint override (e.g. Gemini's OpenAI-compat path). Qwen3 uses
    // a distinct key ("enable_thinking") from every other vLLM-hosted family
    // ("thinking") for the same mechanism.
    if (params.reasoning && this.chatEndpoint === "/v1/chat/completions") {
      const key = /qwen/i.test(params.model) ? "enable_thinking" : "thinking";
      body.chat_template_kwargs = { [key]: true };
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
