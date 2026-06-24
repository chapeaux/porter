/**
 * Encrypted per-user credential storage.
 *
 * Stores model provider API keys (USER_KEY tokens) and per-model endpoint
 * URLs, encrypted at rest using AES-256-GCM with a key derived from
 * the session key + user sub.
 */

import { dirname } from "@std/path";
import { getRawSessionKey, base64UrlEncode, base64UrlDecode } from "./session.ts";
import { loadS3Config, ApS3Client } from "../activitypub/s3.ts";

const NONCE_LENGTH = 12;

export interface ModelEndpoint {
  model_id: string;
  base_url: string;
}

export interface StoredCredential {
  name: string;
  token_type: "sandbox" | "enterprise" | "bearer";
  api_key: string;
  models: ModelEndpoint[];
  created_at: string;
  expires_at?: string;
}

/** Credential with api_key redacted for API responses. */
export interface RedactedCredential {
  name: string;
  token_type: "sandbox" | "enterprise" | "bearer";
  api_key_preview: string;
  models: ModelEndpoint[];
  created_at: string;
  expires_at?: string;
  days_remaining?: number;
}

/**
 * Derive a per-user encryption key from the session key + user sub.
 */
async function deriveUserKey(userId: string): Promise<CryptoKey> {
  const sessionKey = getRawSessionKey();
  const ikm = new TextEncoder().encode(`${userId}:credentials`);

  // HKDF-like derivation: HMAC-SHA256(sessionKey, userId:credentials)
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

function credentialsPath(userId: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/users/${userId}/credentials.json`;
}

/** Encrypted on-disk format. */
interface EncryptedStore {
  version: 1;
  data: string; // encrypted JSON array of StoredCredential
}

// ---------------------------------------------------------------------------
// MinIO-backed persistent storage (optional — falls back to local-only)
// ---------------------------------------------------------------------------

let _credS3: ApS3Client | null = null;
let _credS3Checked = false;

function getCredS3(): ApS3Client | null {
  if (_credS3Checked) return _credS3;
  _credS3Checked = true;
  try {
    const config = loadS3Config();
    if (config) {
      _credS3 = new ApS3Client(config, "porter-creds/");
    }
  } catch { /* S3 not configured — local-only mode */ }
  return _credS3;
}

function s3CredKey(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  return `${safe}.json`;
}

export class CredentialStore {
  async list(userId: string): Promise<RedactedCredential[]> {
    const creds = await this.loadAll(userId);
    return creds.map((c) => this.redact(c));
  }

  async add(
    userId: string,
    cred: Omit<StoredCredential, "created_at">,
  ): Promise<void> {
    const creds = await this.loadAll(userId);

    // Replace if same name exists
    const idx = creds.findIndex((c) => c.name === cred.name);
    const entry: StoredCredential = {
      ...cred,
      created_at: new Date().toISOString(),
    };

    if (idx >= 0) {
      creds[idx] = entry;
    } else {
      creds.push(entry);
    }

    await this.saveAll(userId, creds);
  }

  async remove(userId: string, name: string): Promise<boolean> {
    const creds = await this.loadAll(userId);
    const filtered = creds.filter((c) => c.name !== name);
    if (filtered.length === creds.length) return false;
    await this.saveAll(userId, filtered);
    return true;
  }

  /**
   * Resolve an API key and base URL for a specific model.
   * Searches through all credentials to find one that maps to the model.
   */
  async resolve(
    userId: string,
    modelId: string,
  ): Promise<{ api_key: string; base_url: string } | null> {
    const creds = await this.loadAll(userId);

    for (const cred of creds) {
      const endpoint = cred.models.find((m) => m.model_id === modelId);
      if (endpoint) {
        return { api_key: cred.api_key, base_url: endpoint.base_url };
      }
    }

    return null;
  }

  async resolveByName(
    userId: string,
    credName: string,
  ): Promise<{ api_key: string } | null> {
    const creds = await this.loadAll(userId);
    const match = creds.find((c) => c.name === credName);
    return match ? { api_key: match.api_key } : null;
  }

  async resolveByBaseUrl(
    userId: string,
    baseUrl: string,
  ): Promise<{ api_key: string } | null> {
    const creds = await this.loadAll(userId);
    for (const cred of creds) {
      if (cred.models.some((m) => m.base_url === baseUrl)) {
        return { api_key: cred.api_key };
      }
    }
    return null;
  }

  /**
   * Check expiry status for all sandbox credentials.
   */
  async checkExpiry(
    userId: string,
  ): Promise<{ name: string; days_remaining: number }[]> {
    const creds = await this.loadAll(userId);
    const results: { name: string; days_remaining: number }[] = [];

    for (const cred of creds) {
      if (cred.token_type === "sandbox" && cred.expires_at) {
        const remaining = Math.floor(
          (new Date(cred.expires_at).getTime() - Date.now()) / 86400_000,
        );
        results.push({ name: cred.name, days_remaining: remaining });
      }
    }

    return results;
  }

  // -- Internal --

  /**
   * Load all credentials, trying MinIO first for persistence across
   * pod restarts, then falling back to local filesystem.
   */
  private async loadAll(userId: string): Promise<StoredCredential[]> {
    // Try MinIO first — survives pod restarts / redeployments
    const s3 = getCredS3();
    if (s3) {
      try {
        const text = await s3.getObject(s3CredKey(userId));
        if (text) {
          const store = JSON.parse(text) as EncryptedStore;
          const key = await deriveUserKey(userId);
          const json = await decrypt(key, store.data);
          const creds = JSON.parse(json) as StoredCredential[];
          // Cache locally so subsequent reads within this pod are fast
          await this.writeLocal(userId, text).catch(() => {});
          return creds;
        }
      } catch { /* MinIO unavailable — fall through to local */ }
    }

    // Fall back to local filesystem
    return this.loadLocal(userId);
  }

  /**
   * Save credentials to BOTH local filesystem and MinIO.
   */
  private async saveAll(
    userId: string,
    creds: StoredCredential[],
  ): Promise<void> {
    const key = await deriveUserKey(userId);
    const data = await encrypt(key, JSON.stringify(creds));
    const store: EncryptedStore = { version: 1, data };
    const text = JSON.stringify(store);

    // Write to local filesystem
    await this.writeLocal(userId, text);

    // Write to MinIO for persistence across pod restarts
    const s3 = getCredS3();
    if (s3) {
      try {
        await s3.putObject(s3CredKey(userId), text);
      } catch (err) {
        console.error(`[credentials] MinIO write failed (local copy saved): ${(err as Error).message}`);
      }
    }
  }

  /** Load credentials from local filesystem only. */
  private async loadLocal(userId: string): Promise<StoredCredential[]> {
    const path = credentialsPath(userId);
    try {
      const text = await Deno.readTextFile(path);
      const store = JSON.parse(text) as EncryptedStore;
      const key = await deriveUserKey(userId);
      const json = await decrypt(key, store.data);
      return JSON.parse(json) as StoredCredential[];
    } catch {
      return [];
    }
  }

  /** Write the raw encrypted JSON blob to the local filesystem. */
  private async writeLocal(userId: string, text: string): Promise<void> {
    const path = credentialsPath(userId);
    const dir = dirname(path);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, text);
  }

  private redact(cred: StoredCredential): RedactedCredential {
    const preview = cred.api_key.length > 8
      ? `${cred.api_key.slice(0, 4)}...${cred.api_key.slice(-4)}`
      : "****";

    const result: RedactedCredential = {
      name: cred.name,
      token_type: cred.token_type,
      api_key_preview: preview,
      models: cred.models,
      created_at: cred.created_at,
      expires_at: cred.expires_at,
    };

    if (cred.token_type === "sandbox" && cred.expires_at) {
      result.days_remaining = Math.floor(
        (new Date(cred.expires_at).getTime() - Date.now()) / 86400_000,
      );
    }

    return result;
  }
}
