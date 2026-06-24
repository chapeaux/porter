/**
 * Solid token cache with persistence.
 *
 * Manages Porter's access tokens for reading from user Pods.
 * Tokens are obtained via client_credentials grant using Porter's
 * EC P-256 key pair and cached both in memory and on disk.
 */

import { dirname } from "@std/path";
import { discoverOAuthAS } from "./oidc.ts";
import { createClientAssertion, getClientIdUrl } from "./solid_client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedToken {
  access_token: string;
  expires_at: number;
  issuer: string;
}

// ---------------------------------------------------------------------------
// In-memory cache keyed by issuer URL
// ---------------------------------------------------------------------------

const cache = new Map<string, CachedToken>();

// ---------------------------------------------------------------------------
// Persistence path
// ---------------------------------------------------------------------------

function cacheFilePath(): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/solid/tokens.json`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a valid access token for a Pod's authorization server.
 *
 * 1. Check in-memory cache for a non-expired token for this issuer.
 * 2. If missing or expired, discover the Pod's OAuth AS.
 * 3. Build a client_assertion JWT and POST to the token endpoint
 *    with grant_type=client_credentials.
 * 4. Cache the result and persist to disk.
 *
 * @param podUrl  The Pod root URL (used for OAuth AS discovery).
 * @param domain  Porter's domain (for building the client assertion).
 * @returns A Bearer access token string.
 */
export async function getPorterAccessToken(
  podUrl: string,
  domain: string,
): Promise<string> {
  // Normalise the Pod URL for discovery
  const base = podUrl.replace(/\/+$/, "");

  // 1. Discover issuer to use as cache key
  const asMeta = await discoverOAuthAS(base);
  const issuer = asMeta.issuer;

  // 2. Check cache
  const cached = cache.get(issuer);
  if (cached && cached.expires_at > Date.now() + 30_000) {
    return cached.access_token;
  }

  // 3. Build client assertion
  const tokenEndpoint = asMeta.token_endpoint;
  const clientAssertion = await createClientAssertion(tokenEndpoint, domain);
  const clientId = getClientIdUrl(domain);

  // 4. POST to token endpoint
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion,
    scope: "webid",
  });

  const resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "porter-auth/0.1",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Solid token request failed for ${issuer}: ${resp.status} ${text}`,
    );
  }

  const data = await resp.json();
  const expiresIn = (data.expires_in as number) ?? 3600;
  const entry: CachedToken = {
    access_token: data.access_token as string,
    expires_at: Date.now() + expiresIn * 1000,
    issuer,
  };

  // 5. Cache and persist
  cache.set(issuer, entry);
  await persistCache();

  return entry.access_token;
}

/**
 * Load persisted token cache from disk on startup.
 *
 * Tokens that have already expired are discarded during loading.
 */
export async function loadTokenCache(): Promise<void> {
  try {
    const text = await Deno.readTextFile(cacheFilePath());
    const entries: Record<string, CachedToken> = JSON.parse(text);
    const now = Date.now();
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.expires_at > now) {
        cache.set(key, entry);
      }
    }
  } catch {
    // File doesn't exist or is corrupt -- start with empty cache
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Persist the current in-memory cache to disk. */
async function persistCache(): Promise<void> {
  const filePath = cacheFilePath();
  try {
    await Deno.mkdir(dirname(filePath), { recursive: true });
    const obj: Record<string, CachedToken> = {};
    for (const [key, entry] of cache) {
      obj[key] = entry;
    }
    await Deno.writeTextFile(filePath, JSON.stringify(obj, null, 2));
  } catch {
    // Best-effort persistence -- don't break the caller
  }
}
