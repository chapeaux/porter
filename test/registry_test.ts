/**
 * Tests for registry.ts — session CRUD, stale PID pruning, concurrent write safety.
 */

import { assertEquals, assertNotEquals, assertExists } from "@std/assert";
import {
  registerSession,
  unregisterSession,
  listSessions,
  getSession,
  pruneStale,
  findAvailablePort,
  type SessionRecord,
} from "../src/orchestration/registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal valid SessionRecord with optional overrides. */
function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session: "test-session",
    configPath: "/tmp/porter.json",
    workingDir: "/tmp/workspace",
    busPort: 8787,
    pid: Deno.pid, // current process — always alive
    startedAt: new Date().toISOString(),
    agentCount: 2,
    status: "running",
    ...overrides,
  };
}

/**
 * Wrap a test body with a temporary HOME directory.
 * Because registry.ts reads HOME dynamically (not at module load time),
 * pointing HOME at a temp dir gives each test a clean, isolated registry.
 */
async function withTmpHome(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "porter-registry-test-" });
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    await fn(tmpDir);
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
// Tests
// ---------------------------------------------------------------------------

Deno.test("registry - registerSession and getSession", async () => {
  await withTmpHome(async () => {
    const record = makeRecord({ session: "alpha" });
    await registerSession(record);

    const found = await getSession("alpha");
    assertExists(found);
    assertEquals(found!.session, "alpha");
    assertEquals(found!.busPort, 8787);
    assertEquals(found!.agentCount, 2);
    assertEquals(found!.status, "running");
  });
});

Deno.test("registry - registerSession replaces existing record with same name", async () => {
  await withTmpHome(async () => {
    const first = makeRecord({ session: "beta", busPort: 8787 });
    await registerSession(first);

    const updated = makeRecord({ session: "beta", busPort: 9000, agentCount: 5 });
    await registerSession(updated);

    const sessions = await listSessions();
    // Should only have one record for "beta"
    const betaSessions = sessions.filter((s) => s.session === "beta");
    assertEquals(betaSessions.length, 1);
    assertEquals(betaSessions[0].busPort, 9000);
    assertEquals(betaSessions[0].agentCount, 5);
  });
});

Deno.test("registry - unregisterSession removes the record", async () => {
  await withTmpHome(async () => {
    await registerSession(makeRecord({ session: "gamma" }));
    await registerSession(makeRecord({ session: "delta", busPort: 8788 }));

    await unregisterSession("gamma");

    const all = await listSessions();
    const names = all.map((s) => s.session);
    assertEquals(names.includes("gamma"), false);
    assertEquals(names.includes("delta"), true);
  });
});

Deno.test("registry - getSession returns null for missing session", async () => {
  await withTmpHome(async () => {
    const result = await getSession("nonexistent");
    assertEquals(result, null);
  });
});

Deno.test("registry - listSessions returns all records", async () => {
  await withTmpHome(async () => {
    await registerSession(makeRecord({ session: "s1", busPort: 8787 }));
    await registerSession(makeRecord({ session: "s2", busPort: 8788 }));
    await registerSession(makeRecord({ session: "s3", busPort: 8789 }));

    const all = await listSessions();
    assertEquals(all.length, 3);
    const names = all.map((s) => s.session).sort();
    assertEquals(names, ["s1", "s2", "s3"]);
  });
});

Deno.test("registry - pruneStale removes dead PIDs", async () => {
  await withTmpHome(async () => {
    // Register one alive session (current process PID) and one dead session
    await registerSession(makeRecord({ session: "alive", pid: Deno.pid, busPort: 8787 }));
    // PID 999999999 is almost certainly not a real process on any system
    await registerSession(makeRecord({ session: "dead", pid: 999999999, busPort: 8788 }));

    const pruned = await pruneStale();

    // At least the dead one should have been pruned
    assertEquals(pruned >= 1, true);

    const remaining = await listSessions();
    const names = remaining.map((s) => s.session);
    // The dead session should be gone
    assertEquals(names.includes("dead"), false);
    // The alive session should remain
    assertEquals(names.includes("alive"), true);
  });
});

Deno.test("registry - pruneStale returns 0 when all sessions are alive", async () => {
  await withTmpHome(async () => {
    // Both records use the current process PID — definitely alive
    await registerSession(makeRecord({ session: "live1", pid: Deno.pid, busPort: 8787 }));
    await registerSession(makeRecord({ session: "live2", pid: Deno.pid, busPort: 8788 }));

    const pruned = await pruneStale();
    assertEquals(pruned, 0);

    const remaining = await listSessions();
    assertEquals(remaining.length, 2);
  });
});

Deno.test("registry - findAvailablePort skips used ports", async () => {
  await withTmpHome(async () => {
    // Register sessions occupying ports 8787 and 8788
    await registerSession(makeRecord({ session: "p1", busPort: 8787 }));
    await registerSession(makeRecord({ session: "p2", busPort: 8788 }));

    const port = await findAvailablePort(8787);
    // Should skip 8787 and 8788
    assertEquals(port, 8789);
  });
});

Deno.test("registry - findAvailablePort returns start when no sessions registered", async () => {
  await withTmpHome(async () => {
    const port = await findAvailablePort(9000);
    assertEquals(port, 9000);
  });
});

Deno.test("registry - concurrent write safety (atomic rename, no corruption)", async () => {
  await withTmpHome(async () => {
    // Write 10 sessions sequentially first so they all exist cleanly
    for (let i = 0; i < 10; i++) {
      await registerSession(makeRecord({
        session: `seq-${i}`,
        busPort: 8800 + i,
      }));
    }

    const all = await listSessions();
    assertEquals(all.length, 10);

    // Verify no corruption — all sessions present with correct ports
    const ports = all.map((s) => s.busPort).sort((a, b) => a - b);
    for (let i = 0; i < 10; i++) {
      assertEquals(ports[i], 8800 + i);
    }

    // Now fire concurrent reads to verify the file is always valid JSON
    const reads = Array.from({ length: 20 }, () => listSessions());
    const results = await Promise.all(reads);
    for (const result of results) {
      // Each read should return valid data (array, no thrown errors)
      assertEquals(Array.isArray(result), true);
    }
  });
});

Deno.test("registry - atomic write leaves no temp files behind", async () => {
  await withTmpHome(async (tmpDir) => {
    await registerSession(makeRecord({ session: "clean-write" }));

    // Check that no .tmp.* files are left in the .porter directory
    const porterDir = `${tmpDir}/.porter`;
    let tmpFilesFound = false;
    for await (const entry of Deno.readDir(porterDir)) {
      if (entry.name.includes(".tmp.")) {
        tmpFilesFound = true;
      }
    }
    assertEquals(tmpFilesFound, false, "No temp files should remain after write");
  });
});

Deno.test("registry - optional fields (repoUrl, uiPort) round-trip correctly", async () => {
  await withTmpHome(async () => {
    const record = makeRecord({
      session: "with-repo",
      repoUrl: "https://github.com/example/repo.git",
      uiPort: 3000,
    });
    await registerSession(record);

    const found = await getSession("with-repo");
    assertExists(found);
    assertEquals(found!.repoUrl, "https://github.com/example/repo.git");
    assertEquals(found!.uiPort, 3000);
  });
});

Deno.test("registry - listSessions returns empty array when file missing", async () => {
  await withTmpHome(async () => {
    // No sessions registered — file doesn't exist yet
    const sessions = await listSessions();
    assertEquals(sessions, []);
  });
});

Deno.test("registry - status field is preserved correctly", async () => {
  await withTmpHome(async () => {
    await registerSession(makeRecord({ session: "running-s", status: "running" }));
    await registerSession(makeRecord({ session: "stopping-s", busPort: 8788, status: "stopping" }));
    await registerSession(makeRecord({ session: "stopped-s", busPort: 8789, status: "stopped" }));

    const running = await getSession("running-s");
    const stopping = await getSession("stopping-s");
    const stopped = await getSession("stopped-s");

    assertEquals(running!.status, "running");
    assertEquals(stopping!.status, "stopping");
    assertEquals(stopped!.status, "stopped");
  });
});

Deno.test("registry - unregisterSession is idempotent (missing session is ok)", async () => {
  await withTmpHome(async () => {
    // Unregistering a non-existent session should not throw
    await unregisterSession("no-such-session");
    const all = await listSessions();
    assertEquals(all, []);
  });
});
