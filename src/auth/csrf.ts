/**
 * CSRF protection for the OIDC authorization flow.
 *
 * Uses HMAC-SHA256 to sign the state token. The cookie stores:
 *   mac|redirect_to|code_verifier
 *
 * Auth implementation.
 */

import {
  base64UrlEncode,
  base64UrlDecode,
  getCookieValue,
  getRawSessionKey,
} from "./session.ts";

const COOKIE_NAME = "__porter_csrf";
const MAX_AGE = 300; // 5 minutes

export interface CsrfValidation {
  redirect_to: string;
  code_verifier: string;
}

let _hmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  if (_hmacKey) return _hmacKey;
  _hmacKey = await crypto.subtle.importKey(
    "raw",
    getRawSessionKey().buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return _hmacKey;
}

/**
 * Generate a CSRF state token and the corresponding Set-Cookie header.
 *
 * Returns { state, codeVerifier, cookie } where:
 * - state: the random token sent to the IdP as `state` query param
 * - codeVerifier: the PKCE code verifier for the token exchange
 * - cookie: the Set-Cookie header value to send to the browser
 */
export async function generateCsrf(
  redirectTo = "/",
  secure = true,
  cookiePath = "/",
): Promise<{ state: string; codeVerifier: string; cookie: string }> {
  // Generate state token (32 random bytes)
  const stateBytes = crypto.getRandomValues(new Uint8Array(32));
  const state = base64UrlEncode(stateBytes);

  // Generate PKCE code verifier (32 random bytes)
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64UrlEncode(verifierBytes);

  // MAC = HMAC-SHA256(key, state)
  const key = await getHmacKey();
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(state)),
  );
  const macEncoded = base64UrlEncode(mac);

  // Cookie payload: mac|redirect_to|code_verifier
  const payload = `${macEncoded}|${redirectTo}|${codeVerifier}`;

  const flags = [
    `${COOKIE_NAME}=${payload}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${cookiePath}`,
    `Max-Age=${MAX_AGE}`,
  ];
  if (secure) flags.splice(2, 0, "Secure");

  return { state, codeVerifier, cookie: flags.join("; ") };
}

/**
 * Validate a CSRF state token against the stored cookie.
 *
 * Returns the redirect_to and code_verifier if valid, null otherwise.
 */
export async function validateCsrf(
  req: Request,
  state: string,
): Promise<CsrfValidation | null> {
  const cookieValue = getCookieValue(req, COOKIE_NAME);
  if (!cookieValue) { console.error("[csrf] No CSRF cookie found"); return null; }

  const parts = cookieValue.split("|");
  if (parts.length < 3) { console.error(`[csrf] Bad cookie format: ${parts.length} parts`); return null; }

  const [macEncoded, redirectTo, codeVerifier] = parts;

  // Recompute MAC for the given state
  const key = await getHmacKey();
  const expectedMac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(state)),
  );
  const expectedMacEncoded = base64UrlEncode(expectedMac);

  // Constant-time comparison
  if (!constantTimeEqual(macEncoded, expectedMacEncoded)) {
    console.error(`[csrf] MAC mismatch: cookie=${macEncoded.slice(0, 20)}... expected=${expectedMacEncoded.slice(0, 20)}... state=${state.slice(0, 20)}... parts=${parts.length}`);
    return null;
  }

  return { redirect_to: redirectTo, code_verifier: codeVerifier };
}

/**
 * Return a Set-Cookie header that clears the CSRF cookie.
 */
export function clearCsrfCookie(secure = true, cookiePath = "/"): string {
  const flags = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${cookiePath}`,
    "Max-Age=0",
  ];
  if (secure) flags.splice(2, 0, "Secure");
  return flags.join("; ");
}

/**
 * Generate a PKCE S256 code challenge from a code verifier.
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return base64UrlEncode(digest);
}

// Constant-time string comparison
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
