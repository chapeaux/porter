/**
 * Vertex AI Gemini provider adapter.
 *
 * Handles Gemini models served via model provider Vertex AI proxy.
 *
 * Endpoint: ${base_url}/v1/models/${MODEL_ID}:generateContent
 * Auth:     Authorization: Bearer ${api_key}
 *
 * This is the *native* Vertex AI request/response shape and only works
 * against real GCP Vertex AI endpoints. Some internal gateways (e.g. Red
 * Hat's models-corp) proxy Gemini through Google's own OpenAI-compatibility
 * shim instead (`POST {base}/v1beta/openai/chat/completions`, standard
 * OpenAI request/response bodies) — pointing this provider at one of those
 * will hard-fail with a shape mismatch. For that case, use
 * `provider_type: "openai_compat"` with
 * `chat_endpoint: "/v1beta/openai/chat/completions"` instead; see
 * `OpenAICompatProvider`'s `chatEndpoint` override in openai_compat.ts.
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

// -- Gemini wire types --

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string; is_error?: boolean } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
}

interface GeminiResponse {
  candidates: {
    content: {
      role: "model";
      parts: GeminiPart[];
    };
    finishReason: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER";
  }[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// -- Translation functions --

function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";

    if (typeof msg.content === "string") {
      out.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    // Track tool_result blocks to emit as functionResponse in a "user" turn
    const functionResponses: GeminiPart[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        parts.push({
          functionCall: { name: block.name, args: block.input },
        });
      } else if (block.type === "tool_result") {
        functionResponses.push({
          functionResponse: {
            name: block.tool_use_id,
            response: { content: block.content, is_error: block.is_error },
          },
        });
      }
    }

    if (parts.length > 0) {
      out.push({ role, parts });
    }
    if (functionResponses.length > 0) {
      out.push({ role: "user", parts: functionResponses });
    }
  }

  return out;
}

function toGeminiTools(tools: ToolDefinition[]): { functionDeclarations: GeminiFunctionDeclaration[] }[] {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
  }];
}

// We need a counter for generating unique tool_use IDs since Gemini
// doesn't provide them. Use a module-level counter for simplicity.
let toolUseCounter = 0;

function fromGeminiResponse(resp: GeminiResponse): ChatResponse {
  const candidate = resp.candidates?.[0];
  if (!candidate) {
    throw new ProviderError(500, "Empty response from Gemini API");
  }

  const content: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const part of candidate.content.parts) {
    if (part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      hasToolCalls = true;
      content.push({
        type: "tool_use",
        id: `gemini_tc_${toolUseCounter++}`,
        name: part.functionCall.name,
        input: part.functionCall.args,
      });
    }
  }

  const stopMap: Record<string, ChatResponse["stop_reason"]> = {
    STOP: "end_turn",
    MAX_TOKENS: "max_tokens",
    SAFETY: "end_turn",
    RECITATION: "end_turn",
    OTHER: "end_turn",
  };

  return {
    content,
    stop_reason: hasToolCalls ? "tool_use" : (stopMap[candidate.finishReason] ?? "end_turn"),
    usage: {
      input_tokens: resp.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
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

export class VertexGeminiProvider implements ModelProvider {
  readonly name = "vertex_gemini";

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async createMessage(params: CreateMessageParams): Promise<ChatResponse> {
    const url = `${this.baseUrl}/v1/models/${params.model}:generateContent`;

    const body: GeminiRequest = {
      contents: toGeminiContents(params.messages),
      systemInstruction: { parts: [{ text: params.system }] },
      generationConfig: {
        maxOutputTokens: params.max_tokens,
      },
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = toGeminiTools(params.tools);
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

    const json = (await resp.json()) as GeminiResponse;
    return fromGeminiResponse(json);
  }
}
