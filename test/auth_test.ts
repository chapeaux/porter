/**
 * Tests for auth module — session encryption, CSRF round-trips,
 * credential storage encrypt/decrypt.
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert";
import {
  initSessionKey,
  createSessionCookie,
  decryptSession,
  readSession,
  clearSessionCookie,
  type SessionData,
} from "../src/auth/session.ts";
import {
  generateCsrf,
  validateCsrf,
  generateCodeChallenge,
} from "../src/auth/csrf.ts";
import { CredentialStore } from "../src/auth/credentials.ts";

// Initialize with a fixed test key
const TEST_KEY = "a".repeat(64); // 32 bytes of 0xaa

// ---------------------------------------------------------------------------
// Session encryption
// ---------------------------------------------------------------------------

Deno.test("session: encrypt and decrypt round trip", async () => {
  await initSessionKey(TEST_KEY);

  const data: SessionData = {
    sub: "user-123",
    username: "testuser",
    email: "test@example.com",
    name: "Test User",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  };

  const cookie = await createSessionCookie(data, false);
  // Cookie format: __porter_session=<encoded>; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400
  const encoded = cookie.split(";")[0].split("=").slice(1).join("=");

  const decrypted = await decryptSession(encoded);
  assertEquals(decrypted.sub, "user-123");
  assertEquals(decrypted.username, "testuser");
  assertEquals(decrypted.email, "test@example.com");
});

Deno.test("session: expired session is rejected", async () => {
  await initSessionKey(TEST_KEY);

  const data: SessionData = {
    sub: "user-123",
    username: "testuser",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(), // Already expired
  };

  const cookie = await createSessionCookie(data, false);
  const encoded = cookie.split(";")[0].split("=").slice(1).join("=");

  await assertRejects(
    () => decryptSession(encoded),
    Error,
    "Session expired",
  );
});

Deno.test("session: tampered cookie fails decryption", async () => {
  await initSessionKey(TEST_KEY);

  const data: SessionData = {
    sub: "user-123",
    username: "testuser",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  };

  const cookie = await createSessionCookie(data, false);
  let encoded = cookie.split(";")[0].split("=").slice(1).join("=");
  // Tamper with the encoded value
  encoded = encoded.slice(0, -2) + "XX";

  await assertRejects(
    () => decryptSession(encoded),
    Error,
  );
});

Deno.test("session: readSession extracts from Cookie header", async () => {
  await initSessionKey(TEST_KEY);

  const data: SessionData = {
    sub: "user-456",
    username: "alice",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  };

  const cookie = await createSessionCookie(data, false);
  const encoded = cookie.split(";")[0]; // __porter_session=<value>

  const req = new Request("http://localhost/test", {
    headers: { "Cookie": encoded },
  });

  const session = await readSession(req);
  assertExists(session);
  assertEquals(session!.sub, "user-456");
  assertEquals(session!.username, "alice");
});

Deno.test("session: readSession returns null for missing cookie", async () => {
  await initSessionKey(TEST_KEY);
  const req = new Request("http://localhost/test");
  const session = await readSession(req);
  assertEquals(session, null);
});

Deno.test("session: clearSessionCookie sets Max-Age=0", () => {
  const cookie = clearSessionCookie(false);
  assertEquals(cookie.includes("Max-Age=0"), true);
  assertEquals(cookie.includes("__porter_session=;"), true);
});

Deno.test("session: different keys produce different ciphertexts", async () => {
  const data: SessionData = {
    sub: "user-123",
    username: "testuser",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  };

  await initSessionKey("a".repeat(64));
  const cookie1 = await createSessionCookie(data, false);

  await initSessionKey("b".repeat(64));
  const cookie2 = await createSessionCookie(data, false);

  const val1 = cookie1.split(";")[0].split("=").slice(1).join("=");
  const val2 = cookie2.split(";")[0].split("=").slice(1).join("=");
  assertNotEquals(val1, val2);
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

Deno.test("csrf: generate and validate round trip", async () => {
  await initSessionKey(TEST_KEY);

  const { state, codeVerifier, cookie } = await generateCsrf("/dashboard", false);
  assertExists(state);
  assertExists(codeVerifier);
  assertExists(cookie);

  // Simulate browser sending the cookie back
  const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
  const req = new Request("http://localhost/auth/callback", {
    headers: { "Cookie": `__porter_csrf=${cookieValue}` },
  });

  const result = await validateCsrf(req, state);
  assertExists(result);
  assertEquals(result!.redirect_to, "/dashboard");
  assertEquals(result!.code_verifier, codeVerifier);
});

Deno.test("csrf: wrong state is rejected", async () => {
  await initSessionKey(TEST_KEY);

  const { cookie } = await generateCsrf("/", false);
  const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
  const req = new Request("http://localhost/auth/callback", {
    headers: { "Cookie": `__porter_csrf=${cookieValue}` },
  });

  const result = await validateCsrf(req, "wrong-state-token");
  assertEquals(result, null);
});

Deno.test("csrf: missing cookie returns null", async () => {
  await initSessionKey(TEST_KEY);

  const req = new Request("http://localhost/auth/callback");
  const result = await validateCsrf(req, "any-state");
  assertEquals(result, null);
});

Deno.test("csrf: code challenge is SHA-256 of verifier", async () => {
  const verifier = "test-verifier-value";
  const challenge = await generateCodeChallenge(verifier);
  assertExists(challenge);
  // Challenge should be base64url-encoded SHA-256 (43 chars for 32 bytes)
  assertEquals(challenge.length, 43);
  // Should not contain + or / (base64url)
  assertEquals(challenge.includes("+"), false);
  assertEquals(challenge.includes("/"), false);
});

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

Deno.test("credential store: add and list round trip", async () => {
  await initSessionKey(TEST_KEY);
  const store = new CredentialStore();
  const userId = `test-cred-${Date.now()}`;

  await store.add(userId, {
    name: "test-key",
    token_type: "sandbox",
    api_key: "sandbox_testuser",
    models: [
      { model_id: "ibm-granite/granite-3.3-8b-instruct", base_url: "https://granite.example.com" },
    ],
    expires_at: new Date(Date.now() + 21 * 86400_000).toISOString(),
  });

  const list = await store.list(userId);
  assertEquals(list.length, 1);
  assertEquals(list[0].name, "test-key");
  assertEquals(list[0].token_type, "sandbox");
  assertEquals(list[0].api_key_preview, "sand...user");
  assertEquals(list[0].models.length, 1);

  // Resolve
  const resolved = await store.resolve(userId, "ibm-granite/granite-3.3-8b-instruct");
  assertExists(resolved);
  assertEquals(resolved!.api_key, "sandbox_testuser");
  assertEquals(resolved!.base_url, "https://granite.example.com");

  // Cleanup
  await store.remove(userId, "test-key");
  const after = await store.list(userId);
  assertEquals(after.length, 0);

  // Clean up the file
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  try { await Deno.remove(`${home}/.porter/users/${userId}`, { recursive: true }); } catch { /* ok */ }
});

Deno.test("credential store: check expiry for sandbox tokens", async () => {
  await initSessionKey(TEST_KEY);
  const store = new CredentialStore();
  const userId = `test-expiry-${Date.now()}`;

  await store.add(userId, {
    name: "expiring",
    token_type: "sandbox",
    api_key: "sandbox_user",
    models: [],
    expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
  });

  const expiry = await store.checkExpiry(userId);
  assertEquals(expiry.length, 1);
  assertEquals(expiry[0].name, "expiring");
  assertEquals(expiry[0].days_remaining >= 4 && expiry[0].days_remaining <= 5, true);

  // Cleanup
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  try { await Deno.remove(`${home}/.porter/users/${userId}`, { recursive: true }); } catch { /* ok */ }
});
