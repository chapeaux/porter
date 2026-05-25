/**
 * Tests for mcp_server.ts — MCP protocol handling, tool calls, resources.
 */

import {
  assertEquals,
  assertExists,
} from "@std/assert";
import { PorterMcpServer } from "../src/mcp/mcp_server.ts";

function makeServer(sessionManager?: unknown) {
  return new PorterMcpServer({
    sessionManager: sessionManager as any,
    user: { sub: "test-user", username: "tester", roles: [] },
  });
}

// ---------------------------------------------------------------------------
// Protocol basics
// ---------------------------------------------------------------------------

Deno.test("MCP: initialize returns server info", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.1" },
    },
  });

  assertEquals(resp.id, 1);
  assertExists(resp.result);
  const result = resp.result as Record<string, unknown>;
  assertEquals(result.protocolVersion, "2024-11-05");
  const serverInfo = result.serverInfo as Record<string, string>;
  assertEquals(serverInfo.name, "porter");
});

Deno.test("MCP: tools/list returns tool definitions", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });

  const result = resp.result as { tools: unknown[] };
  assertExists(result.tools);
  assertEquals(result.tools.length > 0, true);

  const names = result.tools.map((t: any) => t.name);
  assertEquals(names.includes("porter_list_models"), true);
  assertEquals(names.includes("porter_list_sessions"), true);
  assertEquals(names.includes("porter_create_session"), true);
  assertEquals(names.includes("porter_stop_session"), true);
  assertEquals(names.includes("porter_send_message"), true);
  assertEquals(names.includes("porter_list_agents"), true);
  assertEquals(names.includes("porter_list_teams"), true);
  assertEquals(names.includes("porter_add_tool"), true);
});

Deno.test("MCP: resources/list returns resource definitions", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
  });

  const result = resp.result as { resources: { uri: string }[] };
  assertExists(result.resources);
  const uris = result.resources.map((r) => r.uri);
  assertEquals(uris.includes("porter://models"), true);
  assertEquals(uris.includes("porter://sessions"), true);
});

Deno.test("MCP: unknown method returns error", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "nonexistent/method",
  });

  assertExists(resp.error);
  assertEquals(resp.error!.code, -32601);
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

Deno.test("MCP: porter_list_models returns model array", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "porter_list_models",
      arguments: { agent_only: true },
    },
  });

  const result = resp.result as { content: { text: string }[] };
  assertExists(result.content);
  const models = JSON.parse(result.content[0].text);
  assertEquals(Array.isArray(models), true);

  // Should not include embedding models when agent_only
  for (const m of models) {
    assertEquals(m.capabilities?.embedding ?? false, false);
  }
});

Deno.test("MCP: porter_list_sessions without session manager", async () => {
  const server = makeServer(); // no sessionManager
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "porter_list_sessions", arguments: {} },
  });

  const result = resp.result as { content: { text: string }[]; isError: boolean };
  assertEquals(result.isError, true);
});

Deno.test("MCP: unknown tool returns error", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "nonexistent_tool", arguments: {} },
  });

  const result = resp.result as { content: { text: string }[]; isError: boolean };
  assertEquals(result.isError, true);
  assertEquals(result.content[0].text.includes("Unknown tool"), true);
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

Deno.test("MCP: resources/read porter://models returns JSON", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "resources/read",
    params: { uri: "porter://models" },
  });

  const result = resp.result as { contents: { uri: string; text: string; mimeType: string }[] };
  assertExists(result.contents);
  assertEquals(result.contents[0].uri, "porter://models");
  assertEquals(result.contents[0].mimeType, "application/json");

  const models = JSON.parse(result.contents[0].text);
  assertEquals(Array.isArray(models), true);
});

Deno.test("MCP: resources/read unknown URI returns error", async () => {
  const server = makeServer();
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "resources/read",
    params: { uri: "porter://nonexistent" },
  });

  assertExists(resp.error);
  assertEquals(resp.error!.code, -32602);
});

Deno.test("MCP: porter_list_sessions with mock session manager", async () => {
  const mockSM = {
    hasSession: () => true,
    getSession: () => undefined,
    listSessions: () => [
      { name: "test-session", busPort: 8787, startedAt: "2024-01-01T00:00:00Z", status: "running", config: { agents: [{}, {}] } },
    ],
    createSession: async () => ({ name: "new", busPort: 8788, startedAt: "", status: "running", config: { agents: [] } }),
    stopSession: async () => "/tmp/snapshot.json",
    deleteSession: async () => {},
  };

  const server = makeServer(mockSM);
  const resp = await server.handleRequest({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "porter_list_sessions", arguments: {} },
  });

  const result = resp.result as { content: { text: string }[] };
  const sessions = JSON.parse(result.content[0].text);
  assertEquals(sessions.length, 1);
  assertEquals(sessions[0].name, "test-session");
  assertEquals(sessions[0].agents, 2);
});
