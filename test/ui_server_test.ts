/**
 * Tests for ui/server.ts — standalone startup, static assets, and API endpoints.
 *
 * Each test uses a distinct port to allow full parallelism without conflicts.
 * Ports start at 19000 + random offset to avoid clashing with other test runs.
 */

import {
  assertEquals,
  assertStringIncludes,
  assertExists,
} from "@std/assert";
import { startUiServer } from "../src/ui/server.ts";

// Base port: use a random offset above 19000 to avoid test-run collisions.
// Each test increments by 1 from this base.
const BASE_PORT = 19000 + Math.floor(Math.random() * 500);

// ---------------------------------------------------------------------------
// Static asset serving
// ---------------------------------------------------------------------------

Deno.test("ui/server: GET / serves index.html with 200", async () => {
  const server = await startUiServer({ port: BASE_PORT, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${BASE_PORT}/`);
    assertEquals(resp.status, 200);
    const ct = resp.headers.get("content-type");
    assertExists(ct);
    assertStringIncludes(ct, "text/html");
    const text = await resp.text();
    // Verify known content from index.html
    assertStringIncludes(text, "Porter");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: GET / always injects /ws proxy path into meta tag", async () => {
  const port = BASE_PORT + 1;
  // Even with a non-default busUrl, the server should inject /ws (the proxy path)
  // so the browser connects through the UI server's WebSocket proxy.
  const busUrl = "ws://myhost:1234";
  const server = await startUiServer({ port, busUrl });
  try {
    const resp = await fetch(`http://localhost:${port}/`);
    assertEquals(resp.status, 200);
    const text = await resp.text();
    // Should always inject /ws regardless of busUrl — browser uses the proxy
    assertStringIncludes(text, 'content="/ws"');
    // The raw busUrl should NOT appear in the HTML (it's cluster-internal)
    assertEquals(text.includes("myhost:1234"), false);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: /healthz returns 200 ok", async () => {
  const port = BASE_PORT + 2;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/healthz`);
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assertEquals(text, "ok");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: GET /app.js serves JavaScript asset", async () => {
  const port = BASE_PORT + 3;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/app.js`);
    assertEquals(resp.status, 200);
    const ct = resp.headers.get("content-type");
    assertExists(ct);
    assertStringIncludes(ct, "javascript");
    await resp.text(); // consume body
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: GET /porter.css serves CSS asset", async () => {
  const port = BASE_PORT + 4;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/porter.css`);
    assertEquals(resp.status, 200);
    const ct = resp.headers.get("content-type");
    assertExists(ct);
    assertStringIncludes(ct, "css");
    await resp.text();
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: GET /porter.svg serves SVG asset", async () => {
  const port = BASE_PORT + 5;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/porter.svg`);
    assertEquals(resp.status, 200);
    const ct = resp.headers.get("content-type");
    assertExists(ct);
    assertStringIncludes(ct, "svg");
    await resp.text();
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: unknown paths return 404", async () => {
  const port = BASE_PORT + 6;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/nonexistent`);
    assertEquals(resp.status, 404);
    const text = await resp.text();
    assertStringIncludes(text, "Not Found");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: deep unknown path also returns 404", async () => {
  const port = BASE_PORT + 7;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/api/doesnotexist`);
    assertEquals(resp.status, 404);
    await resp.text();
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// /api/config GET
// ---------------------------------------------------------------------------

Deno.test("ui/server: GET /api/config returns 404 for missing file", async () => {
  const port = BASE_PORT + 8;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(
      `http://localhost:${port}/api/config?path=nonexistent-porter.json`,
    );
    assertEquals(resp.status, 404);
    const data = await resp.json();
    assertExists(data.error);
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: GET /api/config reads and returns valid config file", async () => {
  const port = BASE_PORT + 9;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const cfg = { session: "test", agents: [{ name: "a" }] };
    await Deno.writeTextFile(tmpFile, JSON.stringify(cfg));

    const resp = await fetch(
      `http://localhost:${port}/api/config?path=${encodeURIComponent(tmpFile)}`,
    );
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.config.session, "test");
  } finally {
    await server.shutdown();
    await Deno.remove(tmpFile).catch(() => {});
  }
});

Deno.test("ui/server: GET /api/config rejects path traversal", async () => {
  const port = BASE_PORT + 10;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(
      `http://localhost:${port}/api/config?path=../../etc/passwd`,
    );
    assertEquals(resp.status, 400);
    const data = await resp.json();
    assertStringIncludes(data.error, "Invalid path");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: GET /api/config rejects embedded traversal", async () => {
  const port = BASE_PORT + 11;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(
      `http://localhost:${port}/api/config?path=configs/../../../etc/shadow`,
    );
    assertEquals(resp.status, 400);
    const data = await resp.json();
    assertStringIncludes(data.error, "Invalid path");
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// /api/config POST
// ---------------------------------------------------------------------------

Deno.test("ui/server: POST /api/config rejects missing session field", async () => {
  const port = BASE_PORT + 12;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { agents: [{ name: "a" }] } }),
    });
    assertEquals(resp.status, 400);
    const data = await resp.json();
    assertStringIncludes(data.error, "session");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: POST /api/config rejects missing agents field", async () => {
  const port = BASE_PORT + 13;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { session: "test" } }),
    });
    assertEquals(resp.status, 400);
    const data = await resp.json();
    assertStringIncludes(data.error, "agents");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: POST /api/config rejects empty agents array", async () => {
  const port = BASE_PORT + 14;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { session: "test", agents: [] } }),
    });
    assertEquals(resp.status, 400);
    const data = await resp.json();
    assertStringIncludes(data.error, "agents");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: POST /api/config writes valid config to file", async () => {
  const port = BASE_PORT + 15;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const cfg = {
      session: "my-session",
      agents: [{ name: "planner", role: "admin" }],
    };

    const resp = await fetch(
      `http://localhost:${port}/api/config?path=${encodeURIComponent(tmpFile)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      },
    );
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);

    // Verify the file was actually written
    const written = JSON.parse(await Deno.readTextFile(tmpFile));
    assertEquals(written.session, "my-session");
    assertEquals(written.agents.length, 1);
  } finally {
    await server.shutdown();
    await Deno.remove(tmpFile).catch(() => {});
  }
});

Deno.test("ui/server: POST /api/config rejects path traversal", async () => {
  const port = BASE_PORT + 16;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(
      `http://localhost:${port}/api/config?path=../../evil.json`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { session: "test", agents: [{ name: "a" }] },
        }),
      },
    );
    assertEquals(resp.status, 400);
    const data = await resp.json();
    assertStringIncludes(data.error, "Invalid path");
  } finally {
    await server.shutdown();
  }
});

Deno.test("ui/server: unsupported method on /api/config returns 405", async () => {
  const port = BASE_PORT + 17;
  const server = await startUiServer({ port, busUrl: "ws://test:9999" });
  try {
    const resp = await fetch(`http://localhost:${port}/api/config`, {
      method: "DELETE",
    });
    assertEquals(resp.status, 405);
    await resp.text();
  } finally {
    await server.shutdown();
  }
});
