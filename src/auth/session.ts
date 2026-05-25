/**
 * Encrypted session cookie management.
 *
 * Uses AES-256-GCM via the Web Crypto API. Cookie format:
 *   base64url( nonce(12 bytes) ‖ ciphertext ‖ tag )
 *
 * Auth implementation.
 */

const COOKIE_NAME = "__porter_session";
const MAX_AGE = 86400; // 24 hours
const NONCE_LENGTH = 12;

export interface SessionData {
  sub: string;
  username: string;
  email?: string;
  name?: string;
  id_token?: string;
  refresh_token?: string;
  lws_token?: string;
  issued_at: string;
  expires_at: string;
}

let _key: CryptoKey | null = null;
let _rawKey: Uint8Array | null = null;

/**
 * Initialize the session encryption key.
 * Reads PORTER_SESSION_KEY (64 hex chars = 32 bytes).
 * If not set, generates a random key (sessions won't survive restart).
 */
export async function initSessionKey(hexKey?: string): Promise<void> {
  const hex = hexKey ?? Deno.env.get("PORTER_SESSION_KEY");

  if (hex) {
    if (hex.length !== 64) {
      throw new Error("PORTER_SESSION_KEY must be 64 hex characters (32 bytes)");
    }
    _rawKey = hexToBytes(hex);
  } else {
    _rawKey = crypto.getRandomValues(new Uint8Array(32));
    console.error("[porter] Warning: no PORTER_SESSION_KEY set — sessions won't survive restart");
  }

  _key = await crypto.subtle.importKey(
    "raw",
    _rawKey.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Get the raw 32-byte key (for CSRF HMAC). */
export function getRawSessionKey(): Uint8Array {
  if (!_rawKey) throw new Error("Session key not initialized — call initSessionKey() first");
  return _rawKey;
}

/**
 * Create an encrypted session cookie header value.
 */
export async function createSessionCookie(
  data: SessionData,
  secure = true,
): Promise<string> {
  const key = getKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      plaintext,
    ),
  );

  // nonce ‖ ciphertext+tag
  const combined = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, NONCE_LENGTH);

  const encoded = base64UrlEncode(combined);
  const flags = [
    `${COOKIE_NAME}=${encoded}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${MAX_AGE}`,
  ];
  if (secure) flags.splice(2, 0, "Secure");

  return flags.join("; ");
}

/**
 * Read and decrypt a session from a request's cookies.
 * Returns null if no valid session cookie is present.
 */
export async function readSession(req: Request): Promise<SessionData | null> {
  const cookieValue = getCookieValue(req, COOKIE_NAME);
  if (!cookieValue) return null;

  try {
    return await decryptSession(cookieValue);
  } catch {
    return null;
  }
}

/**
 * Decrypt a session cookie value.
 */
export async function decryptSession(encoded: string): Promise<SessionData> {
  const key = getKey();
  const combined = base64UrlDecode(encoded);

  if (combined.length < NONCE_LENGTH + 1) {
    throw new Error("Invalid session cookie encoding");
  }

  const nonce = combined.slice(0, NONCE_LENGTH);
  const ciphertext = combined.slice(NONCE_LENGTH);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    );
  } catch {
    throw new Error("Session cookie decryption failed (wrong key or tampered)");
  }

  const json = new TextDecoder().decode(plaintext);
  let data: SessionData;
  try {
    data = JSON.parse(json) as SessionData;
  } catch {
    throw new Error("Invalid session data");
  }

  if (new Date(data.expires_at) < new Date()) {
    throw new Error("Session expired");
  }

  return data;
}

/**
 * Return a Set-Cookie header that clears the session.
 */
export function clearSessionCookie(secure = true): string {
  const flags = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) flags.splice(2, 0, "Secure");
  return flags.join("; ");
}

// -- Helpers --

function getKey(): CryptoKey {
  if (!_key) throw new Error("Session key not initialized — call initSessionKey() first");
  return _key;
}

export function getCookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(str: string): Uint8Array {
  let padded = str.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
