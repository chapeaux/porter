/**
 * Provider factory — creates the correct ModelProvider from a ProviderConfig.
 */

export type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  CreateMessageParams,
  ModelProvider,
  ProviderConfig,
  ProviderType,
  TextBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.ts";

export { ProviderError } from "./types.ts";

import type { ModelProvider, ProviderConfig } from "./types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAICompatProvider } from "./openai_compat.ts";
import { VertexClaudeProvider } from "./vertex_claude.ts";
import { VertexGeminiProvider } from "./vertex_gemini.ts";

/**
 * Resolve the API key from a ProviderConfig.
 * Checks config.api_key first, then config.api_key_env, then falls back
 * to common env vars for backward compatibility.
 */
function resolveApiKey(config: ProviderConfig): string {
  if (config.api_key) return config.api_key;

  if (config.api_key_env) {
    const key = Deno.env.get(config.api_key_env);
    if (key) return key;
    // If the value doesn't look like an env var name, treat it as a raw key
    if (!/^[A-Z_][A-Z0-9_]*$/.test(config.api_key_env)) {
      return config.api_key_env;
    }
    throw new Error(
      `Provider ${config.type}: environment variable '${config.api_key_env}' is not set`,
    );
  }

  // Backward compat: try common env var names
  const fallback = Deno.env.get("ANTHROPIC_API_KEY") ??
    Deno.env.get("PORTER_API_KEY");
  if (fallback) return fallback;

  throw new Error(
    `Provider ${config.type}: no API key configured (set api_key, api_key_env, or ANTHROPIC_API_KEY)`,
  );
}

/**
 * Create a ModelProvider from a ProviderConfig.
 */
export function createProvider(config: ProviderConfig): ModelProvider {
  const useAdc = config.auth === "adc";

  switch (config.type) {
    case "openai":
    case "openai_compat":
    case "groq":
    case "ollama":
    case "azure_openai": {
      const apiKey = config.type === "ollama" ? (tryResolveApiKey(config) ?? "ollama") : resolveApiKey(config);
      return new OpenAICompatProvider(config.base_url, apiKey, config.chat_endpoint);
    }

    case "anthropic": {
      const apiKey = resolveApiKey(config);
      const baseUrl = config.base_url || "https://api.anthropic.com";
      return new AnthropicProvider(baseUrl, apiKey, config.auth, config.chat_endpoint);
    }

    case "vertex_claude": {
      const tier = config.tier ?? "";
      if (useAdc) {
        return new VertexClaudeProvider(config.base_url, null, tier, true);
      }
      const apiKey = resolveApiKey(config);
      return new VertexClaudeProvider(config.base_url, apiKey, tier);
    }

    case "vertex_ai": {
      const models = config.models ?? [];
      const isClaude = models.some(m => m.startsWith("claude")) ||
        config.base_url?.includes("anthropic");
      if (isClaude) {
        const baseUrl = resolveVertexClaudeUrl(config.base_url);
        const tier = config.tier ?? "";
        if (useAdc) return new VertexClaudeProvider(baseUrl, null, tier, true);
        const apiKey = resolveApiKey(config);
        return new VertexClaudeProvider(baseUrl, apiKey, tier);
      }
      if (useAdc) return new VertexGeminiProvider(config.base_url, "");
      const apiKey = resolveApiKey(config);
      return new VertexGeminiProvider(config.base_url, apiKey);
    }

    case "vertex_gemini": {
      if (useAdc) return new VertexGeminiProvider(config.base_url, "");
      const apiKey = resolveApiKey(config);
      return new VertexGeminiProvider(config.base_url, apiKey);
    }

    case "aws_bedrock":
      throw new Error("AWS Bedrock provider is not yet implemented. Use openai_compat with a Bedrock-compatible proxy.");

    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

function tryResolveApiKey(config: ProviderConfig): string | null {
  try {
    return resolveApiKey(config);
  } catch {
    return null;
  }
}

function resolveVertexClaudeUrl(baseUrl: string): string {
  if (baseUrl.includes("publishers/anthropic")) return baseUrl;

  const project = Deno.env.get("ANTHROPIC_VERTEX_PROJECT_ID") ?? "";
  const region = Deno.env.get("CLOUD_ML_REGION") ?? "us-east5";

  if (project) {
    const host = region === "global"
      ? "https://aiplatform.googleapis.com/v1"
      : `https://${region}-aiplatform.googleapis.com/v1`;
    return `${host}/projects/${project}/locations/${region}/publishers/anthropic`;
  }

  return baseUrl;
}
