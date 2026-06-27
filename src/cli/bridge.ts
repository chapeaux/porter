/**
 * Porter CLI Bridge -- MCP Streamable HTTP server exposing filesystem tools.
 *
 * Runs a lightweight HTTP server that speaks the MCP Streamable HTTP protocol,
 * allowing browser-native Porter to connect and gain filesystem access.
 *
 * Transport:
 *   POST /mcp -- JSON-RPC 2.0 requests (initialize, tools/list, tools/call)
 *   OPTIONS /mcp -- CORS preflight
 *
 * Usage:
 *   porter bridge [--port 3333] [--workspace /path/to/project]
 */

import { parseFlag } from "./flags.ts";
import type { ToolEntry, ToolResult } from "../tools/mod.ts";

// -- JSON-RPC types --

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// -- Tool names exposed by the bridge --

const BRIDGE_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "git",
  "glob",
  "grep",
  "list_dir",
] as const;

type BridgeToolName = typeof BRIDGE_TOOL_NAMES[number];

// -- Tool loading --

const toolCache = new Map<string, ToolEntry>();

async function loadTool(name: BridgeToolName): Promise<ToolEntry> {
  const cached = toolCache.get(name);
  if (cached) return cached;

  let mod: { default: ToolEntry };
  switch (name) {
    case "read_file":
      mod = await import("../tools/read_file.ts");
      break;
    case "write_file":
      mod = await import("../tools/write_file.ts");
      break;
    case "edit_file":
      mod = await import("../tools/edit_file.ts");
      break;
    case "bash":
      mod = await import("../tools/bash.ts");
      break;
    case "git":
      mod = await import("../tools/git.ts");
      break;
    case "glob":
      mod = await import("../tools/glob.ts");
      break;
    case "grep":
      mod = await import("../tools/grep.ts");
      break;
    case "list_dir":
      mod = await import("../tools/list_dir.ts");
      break;
    default:
      throw new Error(`Unknown bridge tool: ${name}`);
  }

  const entry = mod.default;
  toolCache.set(name, entry);
  return entry;
}

/** Load all bridge tools and return their MCP-format definitions. */
async function loadAllTools(): Promise<
  { name: string; description: string; inputSchema: Record<string, unknown> }[]
> {
  const defs: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];
  for (const name of BRIDGE_TOOL_NAMES) {
    const entry = await loadTool(name);
    defs.push({
      name: entry.definition.name,
      description: entry.definition.description,
      inputSchema: entry.definition.input_schema as Record<string, unknown>,
    });
  }
  return defs;
}

/** Set the working directory on all tools that support it. */
async function setToolWorkspace(workspace: string): Promise<void> {
  // Tools with setWorkingDir: read_file, write_file, edit_file, glob, grep, list_dir
  const toolsWithWorkingDir: BridgeToolName[] = [
    "read_file", "write_file", "edit_file", "glob", "grep", "list_dir",
  ];
  for (const name of toolsWithWorkingDir) {
    const mod = await import(`../tools/${name}.ts`);
    if (typeof mod.setWorkingDir === "function") {
      mod.setWorkingDir(workspace);
    }
  }
}

// -- CORS headers --

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsHeaders(): Headers {
  return new Headers(CORS_HEADERS);
}

// -- JSON-RPC helpers --

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(
  id: number | string | null,
  result: ToolResult,
): JsonRpcResponse {
  return ok(id, {
    content: [{ type: "text", text: result.content }],
    isError: result.is_error ?? false,
  });
}

// -- Request handler --

async function handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = request.id ?? null;

  try {
    switch (request.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "porter-bridge",
            version: "0.1.0",
          },
        });

      case "notifications/initialized":
        return ok(id, {});

      case "tools/list": {
        const tools = await loadAllTools();
        return ok(id, { tools });
      }

      case "tools/call": {
        const name = request.params?.name as string;
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

        if (!name) {
          return error(id, -32602, "Missing tool name in params.name");
        }

        if (!BRIDGE_TOOL_NAMES.includes(name as BridgeToolName)) {
          return error(id, -32602, `Unknown tool: ${name}. Available: ${BRIDGE_TOOL_NAMES.join(", ")}`);
        }

        console.error(`[porter] Tool call: ${name}(${JSON.stringify(args)})`);

        const entry = await loadTool(name as BridgeToolName);
        const result = await entry.execute(args);
        return toolResult(id, result);
      }

      default:
        return error(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (err) {
    return error(id, -32603, (err as Error).message);
  }
}

// -- HTTP handler --

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // MCP endpoint
  if (url.pathname === "/mcp" && req.method === "POST") {
    try {
      const body = await req.text();
      const request = JSON.parse(body) as JsonRpcRequest;
      const response = await handleJsonRpc(request);

      const headers = corsHeaders();
      headers.set("Content-Type", "application/json");

      // Notifications (no id) get no response body
      if (request.id === undefined) {
        return new Response(null, { status: 204, headers });
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers,
      });
    } catch {
      const headers = corsHeaders();
      headers.set("Content-Type", "application/json");
      const errResp: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      return new Response(JSON.stringify(errResp), {
        status: 400,
        headers,
      });
    }
  }

  // Health check
  if (url.pathname === "/" && req.method === "GET") {
    const headers = corsHeaders();
    headers.set("Content-Type", "application/json");
    return new Response(
      JSON.stringify({ status: "ok", server: "porter-bridge" }),
      { status: 200, headers },
    );
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders() });
}

// -- CLI entry point --

export async function cmdBridge(args: string[]): Promise<void> {
  const portStr = parseFlag(args, "--port");
  const port = portStr ? parseInt(portStr, 10) : 3333;
  const workspace = parseFlag(args, "--workspace") ?? Deno.cwd();

  // Set workspace on filesystem tools
  await setToolWorkspace(workspace);

  console.error(`[porter] Bridge listening on http://localhost:${port}`);
  console.error(`[porter] Workspace: ${workspace}`);
  console.error(
    `[porter] Providing: ${BRIDGE_TOOL_NAMES.join(", ")}`,
  );

  Deno.serve({ port, hostname: "localhost" }, handler);
}
