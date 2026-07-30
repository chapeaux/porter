/**
 * Encrypted per-user model configuration storage.
 *
 * Stores user-defined AI model configurations (endpoints, capabilities,
 * pricing) encrypted at rest using AES-256-GCM with a key derived from
 * the session key + user sub.
 */

import { dirname } from "@std/path";
import { getRawSessionKey, base64UrlEncode, base64UrlDecode } from "./session.ts";

const NONCE_LENGTH = 12;

export interface ModelConfig {
  id: string;
  display_name: string;
  provider_type: ProviderType;
  base_url: string;
  api_key_env?: string;

  region?: string;
  api_version?: string;

  auth: "bearer" | "adc" | "aws_iam";
  chat_endpoint?: string;
  /** Claude only (vertex_claude): tier name mapping to URL path segment ("sonnet", "haiku", "opus"). */
  tier?: string;

  default_params?: {
    temperature?: number;
    top_p?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    response_format?: "text" | "json_object";
  };

  context_window: number;
  max_tokens: number;

  capabilities: {
    tool_calling: boolean;
    reasoning: boolean;
    vision: boolean;
    json_mode: boolean;
  };

  pricing?: {
    input_1m: number;
    output_1m: number;
  };
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

async function deriveUserKey(userId: string): Promise<CryptoKey> {
  const sessionKey = getRawSessionKey();
  const ikm = new TextEncoder().encode(`${userId}:models`);

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    sessionKey.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const derived = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, ikm),
  );

  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );

  const combined = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, NONCE_LENGTH);

  return base64UrlEncode(combined);
}

async function decrypt(key: CryptoKey, encoded: string): Promise<string> {
  const combined = base64UrlDecode(encoded);
  const nonce = combined.slice(0, NONCE_LENGTH);
  const ciphertext = combined.slice(NONCE_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

function modelsPath(userId: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/users/${userId}/models.json`;
}

interface EncryptedStore {
  version: 1;
  data: string;
}

export class ModelStore {
  async list(userId: string): Promise<ModelConfig[]> {
    return await this.loadAll(userId);
  }

  async save(userId: string, models: ModelConfig[]): Promise<void> {
    await this.saveAll(userId, models);
  }

  async add(userId: string, model: ModelConfig): Promise<void> {
    const models = await this.loadAll(userId);
    const idx = models.findIndex((m) => m.id === model.id);
    if (idx >= 0) {
      models[idx] = model;
    } else {
      models.push(model);
    }
    await this.saveAll(userId, models);
  }

  async remove(userId: string, modelId: string): Promise<boolean> {
    const models = await this.loadAll(userId);
    const filtered = models.filter((m) => m.id !== modelId);
    if (filtered.length === models.length) return false;
    await this.saveAll(userId, filtered);
    return true;
  }

  async resolve(userId: string, modelId: string): Promise<ModelConfig | null> {
    const models = await this.loadAll(userId);
    return models.find((m) => m.id === modelId) ?? null;
  }

  private async loadAll(userId: string): Promise<ModelConfig[]> {
    const path = modelsPath(userId);
    try {
      const text = await Deno.readTextFile(path);
      const store = JSON.parse(text) as EncryptedStore;
      const key = await deriveUserKey(userId);
      const json = await decrypt(key, store.data);
      return JSON.parse(json) as ModelConfig[];
    } catch {
      return [];
    }
  }

  private async saveAll(userId: string, models: ModelConfig[]): Promise<void> {
    const path = modelsPath(userId);
    const dir = dirname(path);
    await Deno.mkdir(dir, { recursive: true });

    const key = await deriveUserKey(userId);
    const data = await encrypt(key, JSON.stringify(models));
    const store: EncryptedStore = { version: 1, data };

    await Deno.writeTextFile(path, JSON.stringify(store));
  }
}
