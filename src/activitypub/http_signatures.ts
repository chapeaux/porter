/**
 * HTTP Signatures for ActivityPub server-to-server authentication.
 *
 * Implements draft-cavage-http-signatures for both signing outgoing
 * requests and verifying incoming ones. Uses only Web Crypto API.
 */

import { importPublicKey } from "./keys.ts";
import { AP_ACCEPT } from "./types.ts";

const SIGN_ALGO: AlgorithmIdentifier = { name: "RSASSA-PKCS1-v1_5" };

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Signing outgoing requests
// ---------------------------------------------------------------------------

/**
 * Sign an outgoing request for AP delivery.
 *
 * Mutates the headers of the provided Request, adding Date, Digest,
 * and Signature headers.
 */
export async function signRequest(
  request: Request,
  privateKey: CryptoKey,
  keyId: string,
): Promise<Request> {
  const url = new URL(request.url);
  const body = await request.clone().arrayBuffer();

  const digestHash = await crypto.subtle.digest("SHA-256", body);
  const digestB64 = btoa(String.fromCharCode(...new Uint8Array(digestHash)));
  const digest = `SHA-256=${digestB64}`;

  const date = new Date().toUTCString();
  const target = `${request.method.toLowerCase()} ${url.pathname}`;

  const headers = new Headers(request.headers);
  headers.set("date", date);
  headers.set("digest", digest);
  if (!headers.has("host")) {
    headers.set("host", url.host);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/activity+json");
  }

  const signedHeaders = ["(request-target)", "host", "date", "digest", "content-type"];
  const signingString = signedHeaders
    .map((h) => {
      if (h === "(request-target)") return `(request-target): ${target}`;
      return `${h}: ${headers.get(h)}`;
    })
    .join("\n");

  const sigBytes = await crypto.subtle.sign(
    SIGN_ALGO,
    privateKey,
    encoder.encode(signingString),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

  const sigHeader =
    `keyId="${keyId}",` +
    `headers="${signedHeaders.join(" ")}",` +
    `signature="${sigB64}",` +
    `algorithm="rsa-sha256"`;

  headers.set("signature", sigHeader);

  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  });
}

// ---------------------------------------------------------------------------
// Verifying incoming requests
// ---------------------------------------------------------------------------

interface ParsedSignature {
  keyId: string;
  headers: string[];
  signature: string;
  algorithm?: string;
}

function parseSignatureHeader(header: string): ParsedSignature | null {
  const parts: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    parts[match[1]] = match[2];
  }

  if (!parts.keyId || !parts.signature) return null;

  return {
    keyId: parts.keyId,
    headers: (parts.headers ?? "(request-target) host date").split(" "),
    signature: parts.signature,
    algorithm: parts.algorithm,
  };
}

/** Cache fetched remote public keys (1 hour TTL). */
const publicKeyCache = new Map<string, { pem: string; fetchedAt: number }>();
const KEY_CACHE_TTL = 3600_000;

/**
 * Fetch a remote actor's public key PEM by keyId URL.
 *
 * The keyId typically points to the actor document with a fragment
 * (e.g. "https://mastodon.social/users/alice#main-key"). We fetch
 * the actor document and extract publicKey.publicKeyPem.
 */
async function fetchRemotePublicKey(keyId: string): Promise<string | null> {
  const cached = publicKeyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL) {
    return cached.pem;
  }

  const actorUrl = keyId.replace(/#.*$/, "");
  try {
    const resp = await fetch(actorUrl, {
      headers: { Accept: AP_ACCEPT },
    });
    if (!resp.ok) return null;

    const actor = await resp.json();
    const pem = actor?.publicKey?.publicKeyPem as string | undefined;
    if (!pem) return null;

    publicKeyCache.set(keyId, { pem, fetchedAt: Date.now() });
    return pem;
  } catch {
    return null;
  }
}

/**
 * Verify an incoming request's HTTP Signature.
 *
 * Returns the keyId on success, or null on failure. Optionally
 * accepts a custom public key fetcher for testing.
 */
export async function verifySignature(
  request: Request,
  fetchPublicKey?: (keyId: string) => Promise<string | null>,
): Promise<string | null> {
  const sigHeader = request.headers.get("signature");
  if (!sigHeader) return null;

  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) return null;

  const fetcher = fetchPublicKey ?? fetchRemotePublicKey;
  const pem = await fetcher(parsed.keyId);
  if (!pem) return null;

  const url = new URL(request.url);
  const target = `${request.method.toLowerCase()} ${url.pathname}`;

  const signingString = parsed.headers
    .map((h) => {
      if (h === "(request-target)") return `(request-target): ${target}`;
      return `${h}: ${request.headers.get(h)}`;
    })
    .join("\n");

  try {
    const publicKey = await importPublicKey(pem);
    const sigBytes = Uint8Array.from(atob(parsed.signature), (c) => c.charCodeAt(0));

    const valid = await crypto.subtle.verify(
      SIGN_ALGO,
      publicKey,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(signingString),
    );

    return valid ? parsed.keyId : null;
  } catch {
    return null;
  }
}

/**
 * Verify the Digest header matches the request body.
 *
 * Should be called after signature verification to ensure the body
 * hasn't been tampered with.
 */
export async function verifyDigest(request: Request): Promise<boolean> {
  const digestHeader = request.headers.get("digest");
  if (!digestHeader) return true; // No digest to verify

  const body = await request.clone().arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", body);
  const expected = `SHA-256=${btoa(String.fromCharCode(...new Uint8Array(hash)))}`;

  return digestHeader === expected;
}

/** Clear the public key cache. Used in tests. */
export function resetPublicKeyCache(): void {
  publicKeyCache.clear();
}
