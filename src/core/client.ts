/**
 * Model provider factory.
 *
 * Creates a ModelProvider from a ProviderConfig. Supports three provider
 * types matching the model provider API formats:
 *
 * - **openai_compat**: vLLM endpoints (Granite, Mistral, Qwen, Llama, GPT-OSS)
 * - **vertex_claude**: Vertex AI Claude proxy (Sonnet, Haiku, Opus)
 * - **vertex_gemini**: Vertex AI Gemini proxy
 *
 * Backward compatibility: if called without a ProviderConfig, auto-detects
 * from legacy environment variables (ANTHROPIC_API_KEY, CLAUDE_CODE_USE_VERTEX).
 */

import type { ModelProvider, ProviderConfig } from "../providers/mod.ts";
import { createProvider } from "../providers/mod.ts";

export type { ModelProvider } from "../providers/mod.ts";

/** Options for the legacy createClient() API. */
export interface ClientOptions {
  provider?: "anthropic" | "vertex" | "openai_compat" | "vertex_claude" | "vertex_gemini";
  apiKey?: string;
  projectId?: string;
  region?: string;
  baseUrl?: string;
  tier?: string;
}

/**
 * Create a ModelProvider from legacy ClientOptions.
 *
 * Normalizes old-style options into a ProviderConfig and delegates
 * to createProvider(). This function exists for backward compatibility
 * with isolate.ts and worker.ts code that hasn't been updated yet.
 */
export function createClient(options?: ClientOptions): ModelProvider {
  if (!options) {
    // Auto-detect from environment
    const config = detectProviderConfig();
    return createProvider(config);
  }

  const providerType = normalizeProviderType(options.provider);

  const config: ProviderConfig = {
    type: providerType,
    base_url: options.baseUrl ?? detectBaseUrl(providerType),
    api_key: options.apiKey,
    api_key_env: options.apiKey ? undefined : "ANTHROPIC_API_KEY",
    tier: options.tier,
  };

  return createProvider(config);
}

/**
 * Create a ModelProvider directly from a ProviderConfig.
 */
export function createProviderFromConfig(config: ProviderConfig): ModelProvider {
  return createProvider(config);
}

/**
 * Detect provider config from environment variables (backward compat).
 */
function detectProviderConfig(): ProviderConfig {
  if (Deno.env.get("CLAUDE_CODE_USE_VERTEX") === "1") {
    const project = Deno.env.get("ANTHROPIC_VERTEX_PROJECT_ID") ?? "";
    const region = Deno.env.get("CLOUD_ML_REGION") ?? "us-east5";
    const host = region === "global"
      ? "https://aiplatform.googleapis.com/v1"
      : `https://${region}-aiplatform.googleapis.com/v1`;
    const baseUrl = Deno.env.get("VERTEX_BASE_URL") ??
      `${host}/projects/${project}/locations/${region}/publishers/anthropic`;
    return {
      type: "vertex_claude",
      base_url: baseUrl,
      auth: "adc",
    };
  }

  return {
    type: "openai_compat",
    base_url: Deno.env.get("MODEL_API") ?? "",
    api_key_env: Deno.env.get("PORTER_API_KEY") ? "PORTER_API_KEY" : "ANTHROPIC_API_KEY",
  };
}

function normalizeProviderType(
  provider?: string,
): ProviderConfig["type"] {
  switch (provider) {
    case "anthropic":
    case "openai_compat":
      return "openai_compat";
    case "vertex":
    case "vertex_claude":
      return "vertex_claude";
    case "vertex_gemini":
      return "vertex_gemini";
    default:
      return "openai_compat";
  }
}

function detectBaseUrl(type: ProviderConfig["type"]): string {
  return Deno.env.get("MODEL_API") ?? "";
}
