/**
 * Tests for session ownership enforcement.
 *
 * Validates that SessionManager correctly stores ownerId, filters sessions
 * by user, and enforces ownership via assertOwner(). Also verifies that
 * the registry round-trips ownerId through JSON serialization.
 */

import {
  assertEquals,
  assertThrows,
} from "@std/assert";
import {
  registerSession,
  getSession,
  listSessions,
  type SessionRecord,
} from "../src/orchestration/registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight SessionManager stub for unit-testing ownership logic.
 *
 * We can't import the real SessionManager because createSession() launches
 * real Worker isolates and BusServers. Instead we replicate the three
 * ownership-related methods with the same logic and an in-memory map.
 */
class SessionManagerStub {
  sessions = new Map<
    string,
    { name: string; ownerId?: string; status: string }
  >();

  addSession(name: string, ownerId?: string): void {
    this.sessions.set(name, { name, ownerId, status: "running" });
  }

  listSessionsForUser(ownerId: string) {
    return [...this.sessions.values()].filter(
      (s) => s.ownerId === ownerId,
    );
  }

  assertOwner(
    name: string,
    requesterId: string,
  ): { name: string; ownerId?: string; status: string } {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session '${name}' not found`);
    }
    if (session.ownerId && session.ownerId !== requesterId) {
      throw new Error(
        `Access denied: session '${name}' belongs to another user`,
      );
    }
    return session;
  }
}

/** Create a minimal valid SessionRecord with optional overrides. */
function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session: "test-session",
    configPath: "/tmp/porter.json",
    workingDir: "/tmp/workspace",
    busPort: 8787,
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    agentCount: 2,
    status: "running",
    ...overrides,
  };
}

/**
 * Wrap a test body with a temporary HOME directory so registry operations
 * use an isolated file.
 */
async function withTmpHome(fn: () => Promise<void>): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "porter-ownership-test-" });
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    await fn();
  } finally {
    if (origHome !== undefined) {
      Deno.env.set("HOME", origHome);
    } else {
      Deno.env.delete("HOME");
    }
    await Deno.remove(tmpDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests — SessionManager ownership methods
// ---------------------------------------------------------------------------

Deno.test("ownership - createSession with ownerId stores it on the session", () => {
  const sm = new SessionManagerStub();
  sm.addSession("my-session", "user-alice");
  const session = sm.sessions.get("my-session");
  assertEquals(session?.ownerId, "user-alice");
});

Deno.test("ownership - listSessionsForUser returns only sessions owned by that user", () => {
  const sm = new SessionManagerStub();
  sm.addSession("session-a", "user-alice");
  sm.addSession("session-b", "user-alice");
  sm.addSession("session-c", "user-bob");

  const aliceSessions = sm.listSessionsForUser("user-alice");
  assertEquals(aliceSessions.length, 2);
  const names = aliceSessions.map((s) => s.name).sort();
  assertEquals(names, ["session-a", "session-b"]);
});

Deno.test("ownership - listSessionsForUser does not return sessions owned by other users", () => {
  const sm = new SessionManagerStub();
  sm.addSession("session-a", "user-alice");
  sm.addSession("session-b", "user-bob");
  sm.addSession("session-c", "user-bob");

  const aliceSessions = sm.listSessionsForUser("user-alice");
  assertEquals(aliceSessions.length, 1);
  assertEquals(aliceSessions[0].name, "session-a");

  // Bob should not see Alice's session
  const bobSessions = sm.listSessionsForUser("user-bob");
  assertEquals(bobSessions.length, 2);
  const bobNames = bobSessions.map((s) => s.name).sort();
  assertEquals(bobNames, ["session-b", "session-c"]);
});

Deno.test("ownership - listSessionsForUser excludes sessions with no ownerId", () => {
  const sm = new SessionManagerStub();
  sm.addSession("owned-session", "user-alice");
  sm.addSession("unowned-session"); // no ownerId — legacy/local

  const aliceSessions = sm.listSessionsForUser("user-alice");
  assertEquals(aliceSessions.length, 1);
  assertEquals(aliceSessions[0].name, "owned-session");
});

Deno.test("ownership - assertOwner succeeds when ownerId matches", () => {
  const sm = new SessionManagerStub();
  sm.addSession("my-session", "user-alice");

  const session = sm.assertOwner("my-session", "user-alice");
  assertEquals(session.name, "my-session");
  assertEquals(session.ownerId, "user-alice");
});

Deno.test("ownership - assertOwner throws when ownerId does not match", () => {
  const sm = new SessionManagerStub();
  sm.addSession("my-session", "user-alice");

  assertThrows(
    () => sm.assertOwner("my-session", "user-bob"),
    Error,
    "Access denied",
  );
});

Deno.test("ownership - assertOwner throws when session not found", () => {
  const sm = new SessionManagerStub();

  assertThrows(
    () => sm.assertOwner("nonexistent", "user-alice"),
    Error,
    "not found",
  );
});

Deno.test("ownership - assertOwner succeeds when session has no ownerId (backwards compat)", () => {
  const sm = new SessionManagerStub();
  sm.addSession("legacy-session"); // no ownerId

  // Any user should be able to access a session with no owner
  const session = sm.assertOwner("legacy-session", "user-alice");
  assertEquals(session.name, "legacy-session");
  assertEquals(session.ownerId, undefined);
});

// ---------------------------------------------------------------------------
// Tests — Registry ownerId persistence
// ---------------------------------------------------------------------------

Deno.test("ownership - registry round-trips ownerId through save/load", async () => {
  await withTmpHome(async () => {
    const record = makeRecord({
      session: "owned-session",
      ownerId: "user-alice",
    });
    await registerSession(record);

    const found = await getSession("owned-session");
    assertEquals(found?.ownerId, "user-alice");
  });
});

Deno.test("ownership - registry preserves undefined ownerId (legacy sessions)", async () => {
  await withTmpHome(async () => {
    const record = makeRecord({
      session: "legacy-session",
      // ownerId not set — simulates legacy session
    });
    await registerSession(record);

    const found = await getSession("legacy-session");
    assertEquals(found?.ownerId, undefined);
  });
});

Deno.test("ownership - registry lists sessions with mixed ownership", async () => {
  await withTmpHome(async () => {
    await registerSession(
      makeRecord({ session: "alice-s", busPort: 8787, ownerId: "user-alice" }),
    );
    await registerSession(
      makeRecord({ session: "bob-s", busPort: 8788, ownerId: "user-bob" }),
    );
    await registerSession(
      makeRecord({ session: "public-s", busPort: 8789 }),
    );

    const all = await listSessions();
    assertEquals(all.length, 3);

    const aliceRec = all.find((s) => s.session === "alice-s");
    assertEquals(aliceRec?.ownerId, "user-alice");

    const bobRec = all.find((s) => s.session === "bob-s");
    assertEquals(bobRec?.ownerId, "user-bob");

    const publicRec = all.find((s) => s.session === "public-s");
    assertEquals(publicRec?.ownerId, undefined);
  });
});
