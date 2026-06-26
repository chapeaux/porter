/**
 * Auto-detect locally configured AI model providers from environment
 * variables and well-known endpoints.
 *
 * Detected models are merged into the user's model list on first load
 * so Porter works out of the box with existing local setups.
 */

import type { ModelConfig, ProviderType } from "./model_store.ts";

interface DetectedModel extends ModelConfig {
  _autodetected: true;
}

let _cached: DetectedModel[] | null = null;

/** Clear the cache (e.g., after env changes). */
export function resetModelDetectCache(): void {
  _cached = null;
}

/**
 * Scan environment for known AI provider configurations.
 * Returns model configs for each detected provider.
 * Results are cached after the first call.
 */
export function detectModels(): DetectedModel[] {
  if (_cached) return _cached;
  const models: DetectedModel[] = [];

  // --- Google Vertex AI (Claude) ---
  // Claude Code convention: CLAUDE_CODE_USE_VERTEX=1
  if (Deno.env.get("CLAUDE_CODE_USE_VERTEX") === "1") {
    const project = Deno.env.get("ANTHROPIC_VERTEX_PROJECT_ID") ?? "";
    const region = Deno.env.get("CLOUD_ML_REGION") ?? "us-east5";
    if (project) {
      const host = region === "global"
        ? "https://aiplatform.googleapis.com/v1"
        : `https://${region}-aiplatform.googleapis.com/v1`;
      const baseUrl = `${host}/projects/${project}/locations/${region}/publishers/anthropic`;
      models.push({
        id: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6 (Vertex AI)",
        provider_type: "vertex_ai",
        base_url: baseUrl,
        auth: "adc",
        region,
        context_window: 200000,
        max_tokens: 8192,
        capabilities: { tool_calling: true, reasoning: true, vision: true, json_mode: true },
        _autodetected: true,
      });
    }
  }

  // --- Anthropic Direct API ---
  if (Deno.env.get("ANTHROPIC_API_KEY")) {
    models.push({
      id: "claude-sonnet-4-6",
      display_name: "Claude Sonnet 4.6",
      provider_type: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key_env: "ANTHROPIC_API_KEY",
      auth: "bearer",
      context_window: 200000,
      max_tokens: 8192,
      capabilities: { tool_calling: true, reasoning: true, vision: true, json_mode: true },
      _autodetected: true,
    });
  }

  // --- OpenAI ---
  if (Deno.env.get("OPENAI_API_KEY")) {
    models.push({
      id: "gpt-4o",
      display_name: "GPT-4o",
      provider_type: "openai",
      base_url: "https://api.openai.com",
      api_key_env: "OPENAI_API_KEY",
      auth: "bearer",
      context_window: 128000,
      max_tokens: 16384,
      capabilities: { tool_calling: true, reasoning: false, vision: true, json_mode: true },
      _autodetected: true,
    });
  }

  // --- Azure OpenAI ---
  if (Deno.env.get("AZURE_OPENAI_API_KEY") && Deno.env.get("AZURE_OPENAI_ENDPOINT")) {
    const endpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT")!;
    const apiVersion = Deno.env.get("AZURE_OPENAI_API_VERSION") ?? "2024-02-01";
    models.push({
      id: Deno.env.get("AZURE_OPENAI_DEPLOYMENT") ?? "gpt-4o",
      display_name: "GPT-4o (Azure)",
      provider_type: "azure_openai",
      base_url: endpoint,
      api_key_env: "AZURE_OPENAI_API_KEY",
      api_version: apiVersion,
      auth: "bearer",
      context_window: 128000,
      max_tokens: 16384,
      capabilities: { tool_calling: true, reasoning: false, vision: true, json_mode: true },
      _autodetected: true,
    });
  }

  // --- AWS Bedrock ---
  // Only detect if explicitly opted in — AWS_ACCESS_KEY_ID is too common (MinIO, S3, etc.)
  if (Deno.env.get("PORTER_USE_BEDROCK") === "1" || Deno.env.get("AWS_BEDROCK_MODEL")) {
    const region = Deno.env.get("AWS_REGION") ?? Deno.env.get("AWS_DEFAULT_REGION") ?? "us-east-1";
    models.push({
      id: "anthropic.claude-sonnet-4-6-v1:0",
      display_name: "Claude Sonnet 4.6 (Bedrock)",
      provider_type: "aws_bedrock",
      base_url: `https://bedrock-runtime.${region}.amazonaws.com`,
      region,
      auth: "aws_iam",
      context_window: 200000,
      max_tokens: 8192,
      capabilities: { tool_calling: true, reasoning: true, vision: true, json_mode: true },
      _autodetected: true,
    });
  }

  // --- Groq ---
  if (Deno.env.get("GROQ_API_KEY")) {
    models.push({
      id: "llama-3.3-70b-versatile",
      display_name: "Llama 3.3 70B (Groq)",
      provider_type: "groq",
      base_url: "https://api.groq.com/openai",
      api_key_env: "GROQ_API_KEY",
      auth: "bearer",
      context_window: 131072,
      max_tokens: 32768,
      capabilities: { tool_calling: true, reasoning: false, vision: false, json_mode: true },
      _autodetected: true,
    });
  }

  // --- Ollama (local) ---
  // Check for OLLAMA_HOST or default localhost
  const ollamaHost = Deno.env.get("OLLAMA_HOST");
  if (ollamaHost) {
    models.push({
      id: "llama3.3",
      display_name: "Llama 3.3 (Ollama)",
      provider_type: "ollama",
      base_url: ollamaHost.startsWith("http") ? ollamaHost : `http://${ollamaHost}`,
      auth: "bearer",
      context_window: 131072,
      max_tokens: 8192,
      capabilities: { tool_calling: true, reasoning: false, vision: false, json_mode: true },
      _autodetected: true,
    });
  }

  // --- Generic OpenAI-compatible (vLLM, LM Studio, etc.) ---
  const modelApi = Deno.env.get("MODEL_API");
  if (modelApi) {
    const modelId = Deno.env.get("MODEL_ID") ?? "default";
    models.push({
      id: modelId,
      display_name: `${modelId} (${new URL(modelApi).hostname})`,
      provider_type: "openai_compat",
      base_url: modelApi,
      api_key_env: Deno.env.get("MODEL_API_KEY") ? "MODEL_API_KEY" : undefined,
      auth: "bearer",
      context_window: parseInt(Deno.env.get("MODEL_CONTEXT_WINDOW") ?? "32768"),
      max_tokens: parseInt(Deno.env.get("MODEL_MAX_TOKENS") ?? "8192"),
      capabilities: {
        tool_calling: Deno.env.get("MODEL_TOOL_CALLING") !== "false",
        reasoning: Deno.env.get("MODEL_REASONING") === "true",
        vision: Deno.env.get("MODEL_VISION") === "true",
        json_mode: Deno.env.get("MODEL_JSON_MODE") !== "false",
      },
      _autodetected: true,
    });
  }

  _cached = models;
  return models;
}

/**
 * Merge auto-detected models with user-configured models.
 * User models take precedence — if a user has configured any model
 * with the same ID, the auto-detected version is skipped.
 */
export function mergeWithDetected(
  userModels: ModelConfig[],
  detected: DetectedModel[],
): ModelConfig[] {
  const userIds = new Set(userModels.map((m) => m.id));
  const novel = detected.filter((d) => !userIds.has(d.id));
  if (novel.length === 0) return userModels;
  return [...novel, ...userModels];
}
