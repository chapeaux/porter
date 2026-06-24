/**
 * Solid Client Identity module.
 *
 * Manages Porter's identity as a Solid agent: EC P-256 key pair for
 * client_credentials / private_key_jwt auth, Client Identifier Document,
 * WebID profile, DPoP proofs, and client assertions (RFC 9449, Solid-OIDC).
 */

import { dirname } from "@std/path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Base64url-encode a buffer (no padding). */
function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url-encode a UTF-8 string. */
function base64urlStr(s: string): string {
  return base64url(encoder.encode(s));
}

// ---------------------------------------------------------------------------
// Key pair management
// ---------------------------------------------------------------------------

const EC_ALGO: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

interface SolidKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
}

let _cached: SolidKeyPair | null = null;

function keysDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/solid`;
}

/**
 * Get or create Porter's EC P-256 key pair for Solid OIDC.
 *
 * Loading priority:
 *   1. PORTER_SOLID_PRIVATE_KEY / PORTER_SOLID_PUBLIC_KEY env vars (JWK JSON)
 *   2. File at ~/.porter/solid/keypair.json (JWK format)
 *   3. Generate new pair, save to ~/.porter/solid/keypair.json
 *
 * The loaded key pair is cached in memory.
 */
export async function getPorterKeyPair(): Promise<SolidKeyPair> {
  if (_cached) return _cached;

  // 1. Try environment variables
  const envPriv = Deno.env.get("PORTER_SOLID_PRIVATE_KEY");
  const envPub = Deno.env.get("PORTER_SOLID_PUBLIC_KEY");
  if (envPriv && envPub) {
    const privJwk: JsonWebKey = JSON.parse(envPriv);
    const pubJwk: JsonWebKey = JSON.parse(envPub);
    const privateKey = await crypto.subtle.importKey(
      "jwk", privJwk, EC_ALGO, true, ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk", pubJwk, EC_ALGO, true, ["verify"],
    );
    _cached = { privateKey, publicKey, publicJwk: pubJwk };
    return _cached;
  }

  // 2. Try file on disk
  const dir = keysDir();
  const filePath = `${dir}/keypair.json`;
  try {
    const raw = await Deno.readTextFile(filePath);
    const stored: { privateKey: JsonWebKey; publicKey: JsonWebKey } = JSON.parse(raw);
    const privateKey = await crypto.subtle.importKey(
      "jwk", stored.privateKey, EC_ALGO, true, ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk", stored.publicKey, EC_ALGO, true, ["verify"],
    );
    _cached = { privateKey, publicKey, publicJwk: stored.publicKey };
    return _cached;
  } catch {
    // File doesn't exist or is corrupt — generate new pair
  }

  // 3. Generate and persist
  const keyPair = await crypto.subtle.generateKey(
    EC_ALGO,
    true,
    ["sign", "verify"],
  );

  const privJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(filePath, JSON.stringify({
    privateKey: privJwk,
    publicKey: pubJwk,
  }, null, 2));

  _cached = {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicJwk: pubJwk,
  };
  return _cached;
}

/** Clear the in-memory key cache. Used in tests. */
export function resetSolidKeyCache(): void {
  _cached = null;
}

// ---------------------------------------------------------------------------
// Client Identifier Document (Solid-OIDC)
// ---------------------------------------------------------------------------

/**
 * Build the Solid Client Identifier Document for Porter.
 *
 * This document is served at `/.well-known/solid/client-id` and tells
 * Solid identity providers who Porter is and how it authenticates.
 */
export function buildClientIdDocument(domain: string): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/solid/oidc-context.jsonld",
    "client_id": `https://${domain}/.well-known/solid/client-id`,
    "client_name": "Porter Agent Orchestrator",
    "redirect_uris": [`https://${domain}/auth/solid-callback`],
    "grant_types": ["authorization_code", "client_credentials", "refresh_token"],
    "scope": "openid webid offline_access",
    "token_endpoint_auth_method": "none",
    "client_uri": `https://${domain}`,
    "logo_uri": `https://${domain}/porter.svg`,
  };
}

// ---------------------------------------------------------------------------
// WebID profile (Turtle)
// ---------------------------------------------------------------------------

/**
 * Build Porter's WebID profile in Turtle format.
 *
 * This is a minimal foaf:Agent document that Solid servers use to
 * identify Porter as a trusted application.
 */
export function buildWebIdProfile(domain: string): string {
  return `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<https://${domain}/ap/porter#id>
  a foaf:Agent ;
  rdfs:label "Porter Agent Orchestrator" ;
  solid:oidcIssuer <https://${domain}> .
`;
}

// ---------------------------------------------------------------------------
// Client assertion (private_key_jwt)
// ---------------------------------------------------------------------------

/**
 * Create a client_assertion JWT for token endpoint authentication.
 *
 * Builds a JWT signed with Porter's ES256 private key, suitable for
 * the `client_assertion` parameter in OAuth token requests with
 * `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.
 */
export async function createClientAssertion(
  tokenEndpoint: string,
  domain: string,
): Promise<string> {
  const { privateKey } = await getPorterKeyPair();
  const clientId = getClientIdUrl(domain);

  const header = { alg: "ES256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenEndpoint,
    iat: now,
    exp: now + 300, // 5 minutes
    jti: crypto.randomUUID(),
  };

  const headerB64 = base64urlStr(JSON.stringify(header));
  const payloadB64 = base64urlStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(signingInput),
  );

  // Web Crypto returns ECDSA signatures in DER format; JWT needs raw r||s (64 bytes for P-256).
  const rawSig = derToRawEcdsa(new Uint8Array(sigBytes));
  const sigB64 = base64url(rawSig);

  return `${signingInput}.${sigB64}`;
}

// ---------------------------------------------------------------------------
// DPoP proof (RFC 9449)
// ---------------------------------------------------------------------------

/**
 * Create a DPoP proof JWT per RFC 9449.
 *
 * The proof binds a specific HTTP method + URL to Porter's public key,
 * preventing token replay across different endpoints.
 */
export async function createDpopProof(
  method: string,
  url: string,
  domain: string,
): Promise<string> {
  const { privateKey, publicJwk } = await getPorterKeyPair();

  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: publicJwk,
  };
  const payload = {
    jti: crypto.randomUUID(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };

  const headerB64 = base64urlStr(JSON.stringify(header));
  const payloadB64 = base64urlStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(signingInput),
  );

  const rawSig = derToRawEcdsa(new Uint8Array(sigBytes));
  const sigB64 = base64url(rawSig);

  return `${signingInput}.${sigB64}`;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Porter's WebID URL. */
export function getPorterWebId(domain: string): string {
  return `https://${domain}/ap/porter#id`;
}

/** Porter's Solid Client Identifier Document URL. */
export function getClientIdUrl(domain: string): string {
  return `https://${domain}/.well-known/solid/client-id`;
}

// ---------------------------------------------------------------------------
// DER-to-raw ECDSA signature conversion
// ---------------------------------------------------------------------------

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format.
 *
 * Web Crypto's ECDSA output is DER (SEQUENCE { INTEGER r, INTEGER s }).
 * JWTs expect the raw concatenation of r and s, each zero-padded to 32
 * bytes for P-256.
 */
function derToRawEcdsa(der: Uint8Array): Uint8Array {
  // DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  let offset = 2; // skip SEQUENCE tag + length

  // Parse r
  if (der[offset] !== 0x02) throw new Error("Invalid DER: expected INTEGER tag for r");
  offset++;
  const rLen = der[offset++];
  let r = der.subarray(offset, offset + rLen);
  offset += rLen;

  // Parse s
  if (der[offset] !== 0x02) throw new Error("Invalid DER: expected INTEGER tag for s");
  offset++;
  const sLen = der[offset++];
  let s = der.subarray(offset, offset + sLen);

  // Strip leading zero byte (DER uses it for sign padding)
  if (r.length === 33 && r[0] === 0) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0) s = s.subarray(1);

  // Pad to 32 bytes each (P-256)
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}
