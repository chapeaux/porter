/**
 * JWT validation and auth middleware.
 *
 * Extracts authenticated user from Bearer tokens or session cookies.
 * JWKS keys are fetched and cached (1-hour TTL).
 *
 * Auth implementation.
 */

import { readSession, type SessionData } from "./session.ts";
import { base64UrlDecode } from "./session.ts";

export interface AuthenticatedUser {
  sub: string;
  username: string;
  email?: string;
  name?: string;
  roles: string[];
}

// -- JWKS cache --

interface JwkSet {
  keys: Jwk[];
}

interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

let _jwksCache: { keys: JwkSet; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 3600_000; // 1 hour

async function fetchJwks(jwksUri: string): Promise<JwkSet> {
  const now = Date.now();

  if (_jwksCache && (now - _jwksCache.fetchedAt) < JWKS_TTL_MS) {
    return _jwksCache.keys;
  }

  const resp = await fetch(jwksUri, {
    headers: { "User-Agent": "porter-auth/0.1" },
  });

  if (!resp.ok) {
    throw new Error(`JWKS fetch failed with status ${resp.status}`);
  }

  const jwks = (await resp.json()) as JwkSet;
  _jwksCache = { keys: jwks, fetchedAt: now };
  return jwks;
}

/** Reset JWKS cache (for testing). */
export function resetJwksCache(): void {
  _jwksCache = null;
}

// -- JWT validation --

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  sub?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  realm_access?: { roles?: string[] };
  [key: string]: unknown;
}

/**
 * Validate a JWT access/ID token and extract the authenticated user.
 */
export async function validateToken(
  token: string,
  jwksUri: string,
  issuer: string,
): Promise<AuthenticatedUser> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT: expected 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header to find kid
  const header = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(headerB64)),
  ) as JwtHeader;

  if (header.alg !== "RS256") {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`);
  }

  // Fetch JWKS and find the matching key
  const jwks = await fetchJwks(jwksUri);
  const jwk = header.kid
    ? jwks.keys.find((k) => k.kid === header.kid)
    : jwks.keys[0];

  if (!jwk) {
    throw new Error(`No JWKS key found for kid: ${header.kid}`);
  }

  // Import the RSA public key
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      use: "sig",
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Verify signature
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature.buffer as ArrayBuffer,
    signedData,
  );

  if (!valid) {
    throw new Error("Invalid JWT signature");
  }

  // Decode and validate claims
  const claims = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64)),
  ) as JwtClaims;

  // Validate issuer
  if (claims.iss && claims.iss !== issuer) {
    throw new Error(`JWT issuer mismatch: expected ${issuer}, got ${claims.iss}`);
  }

  // Validate expiry
  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("JWT expired");
  }

  return {
    sub: claims.sub ?? "",
    username: claims.preferred_username ?? "unknown",
    email: claims.email as string | undefined,
    name: claims.name as string | undefined,
    roles: claims.realm_access?.roles ?? [],
  };
}

// -- Auth extraction from requests --

/**
 * Extract an authenticated user from a request.
 * Checks (in order): Bearer token, session cookie.
 * Returns null if no valid auth is found.
 */
export async function extractUser(
  req: Request,
  jwksUri?: string,
  issuer?: string,
): Promise<AuthenticatedUser | null> {
  // 1. Bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (jwksUri && issuer) {
      try {
        return await validateToken(token, jwksUri, issuer);
      } catch {
        return null;
      }
    }
  }

  // 2. Session cookie
  const session = await readSession(req);
  if (session) {
    return sessionToUser(session);
  }

  return null;
}

/**
 * Require authentication. Returns the user or a 401 Response.
 */
export async function requireAuth(
  req: Request,
  jwksUri?: string,
  issuer?: string,
): Promise<AuthenticatedUser | Response> {
  const user = await extractUser(req, jwksUri, issuer);
  if (!user) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return user;
}

function sessionToUser(session: SessionData): AuthenticatedUser {
  return {
    sub: session.sub,
    username: session.username,
    email: session.email,
    name: session.name,
    roles: [],
  };
}
