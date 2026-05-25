/**
 * MCP client — connects to external MCP servers and wraps their tools
 * as Porter ToolEntry objects.
 *
 * Supports two transports:
 * - stdio: spawns a subprocess, communicates via stdin/stdout
 * - http: Streamable HTTP transport (POST to endpoint)
 *
 * Uses JSON-RPC 2.0 protocol per the MCP specification.
 */

import type { ToolDefinition } from "../providers/types.ts";
import type { ToolEntry, ToolResult } from "../tools/mod.ts";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /** For stdio: command to run. */
  command?: string;
  /** For stdio: arguments for the command. */
  args?: string[];
  /** For HTTP: endpoint URL. */
  url?: string;
  /** Environment variables to set for the server process. */
  env?: Record<string, string>;
  /** OIDC auth config for HTTP-transport servers. */
  auth?: {
    type: "oidc";
    /** OIDC issuer URL. If omitted, uses Porter's configured issuer. */
    issuer_url?: string;
  };
  /** Runtime-only: injected access token (not persisted to config files). */
  access_token?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export class McpClient {
  private serverName: string;
  config: McpServerConfig;
  private process: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readBuffer = "";
  private nextId = 1;
  private tools: Map<string, ToolDefinition> = new Map();
  private connected = false;
  private sessionId: string | null = null;

  constructor(config: McpServerConfig) {
    this.serverName = config.name;
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.config.transport === "stdio") {
      await this.connectStdio();
    } else {
      await this.connectHttp();
      const hasAuth = !!this.config.access_token || !!this.config.env?.["AUTHORIZATION"];
      console.error(`[mcp] ${this.serverName}: connecting to ${this.config.url} (auth: ${hasAuth ? 'yes' : 'none'})`);
    }

    // Initialize the MCP session
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "porter", version: "0.1.0" },
    });

    // Send initialized notification (no response expected)
    await this.sendNotification("notifications/initialized", {});

    // Discover tools
    await this.refreshTools();

    this.connected = true;
  }

  private async connectStdio(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`MCP server '${this.serverName}': stdio transport requires 'command'`);
    }

    const env: Record<string, string> = { ...Deno.env.toObject() };
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        env[k] = v;
      }
    }

    const cmd = new Deno.Command(this.config.command, {
      args: this.config.args ?? [],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env,
    });

    this.process = cmd.spawn();
    this.writer = this.process.stdin.getWriter();
    this.reader = this.process.stdout.getReader();
  }

  private async connectHttp(): Promise<void> {
    if (!this.config.url) {
      throw new Error(`MCP server '${this.serverName}': http transport requires 'url'`);
    }
    await Promise.resolve();
  }

  private _getAuthHeaders(): Record<string, string> {
    if (this.config.access_token) {
      return { Authorization: `Bearer ${this.config.access_token}` };
    }
    if (this.config.env?.["AUTHORIZATION"]) {
      return { Authorization: this.config.env["AUTHORIZATION"] };
    }
    return {};
  }

  async refreshTools(): Promise<void> {
    const result = await this.sendRequest("tools/list", {}) as { tools: McpToolDef[] };
    this.tools.clear();

    for (const t of result.tools ?? []) {
      this.tools.set(t.name, {
        name: t.name,
        description: t.description ?? "",
        input_schema: {
          type: "object",
          properties: t.inputSchema?.properties ?? {},
          required: t.inputSchema?.required,
        },
      });
    }
  }

  getTools(): ToolEntry[] {
    const entries: ToolEntry[] = [];

    for (const [name, definition] of this.tools) {
      const client = this;
      entries.push({
        definition,
        async execute(params: Record<string, unknown>): Promise<ToolResult> {
          return client.callTool(name, params);
        },
      });
    }

    return entries;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.sendRequest("tools/call", {
        name,
        arguments: params,
      }) as McpToolResult;

      const text = result.content
        ?.map((c) => c.text)
        .join("\n") ?? "";

      return {
        content: text,
        is_error: result.isError,
      };
    } catch (err) {
      return {
        content: `MCP tool '${name}' error: ${(err as Error).message}`,
        is_error: true,
      };
    }
  }

  close(): void {
    this.connected = false;

    if (this.writer) {
      try { this.writer.close(); } catch { /* ignore */ }
      this.writer = null;
    }
    if (this.reader) {
      try { this.reader.cancel(); } catch { /* ignore */ }
      this.reader = null;
    }
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch { /* ignore */ }
      this.process = null;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get name(): string {
    return this.serverName;
  }

  // -- JSON-RPC transport --

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    if (this.config.transport === "http") {
      return this.sendHttpRequest(request);
    }

    return this.sendStdioRequest(request);
  }

  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    if (this.config.transport === "http") {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this._getAuthHeaders(),
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      await fetch(this.config.url!, {
        method: "POST",
        headers,
        body: JSON.stringify(notification),
      });
      return;
    }

    if (this.writer) {
      const line = JSON.stringify(notification) + "\n";
      await this.writer.write(new TextEncoder().encode(line));
    }
  }

  private async sendHttpRequest(request: JsonRpcRequest): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this._getAuthHeaders(),
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const resp = await fetch(this.config.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`MCP HTTP error: ${resp.status} ${resp.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const json = await resp.json() as JsonRpcResponse;
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }

    return json.result;
  }

  private async sendStdioRequest(request: JsonRpcRequest): Promise<unknown> {
    if (!this.writer || !this.reader) {
      throw new Error("MCP stdio transport not connected");
    }

    const line = JSON.stringify(request) + "\n";
    await this.writer.write(new TextEncoder().encode(line));

    // Read response lines until we get one matching our ID
    const decoder = new TextDecoder();
    while (true) {
      // Check if we already have a complete line in the buffer
      const newlineIdx = this.readBuffer.indexOf("\n");
      if (newlineIdx >= 0) {
        const responseLine = this.readBuffer.slice(0, newlineIdx);
        this.readBuffer = this.readBuffer.slice(newlineIdx + 1);

        if (responseLine.trim()) {
          try {
            const json = JSON.parse(responseLine) as JsonRpcResponse;
            if (json.id === request.id) {
              if (json.error) {
                throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
              }
              return json.result;
            }
            // Not our response (notification or different ID), skip
          } catch {
            // Not valid JSON, skip
          }
        }
        continue;
      }

      // Read more data
      const { done, value } = await this.reader.read();
      if (done) {
        throw new Error("MCP server closed stdout unexpectedly");
      }
      this.readBuffer += decoder.decode(value, { stream: true });
    }
  }
}

/**
 * Connect to all configured MCP servers and return a map of
 * server name -> McpClient.
 */
export async function connectMcpServers(
  configs: Record<string, McpServerConfig>,
): Promise<Map<string, McpClient>> {
  const clients = new Map<string, McpClient>();

  for (const [name, config] of Object.entries(configs)) {
    const client = new McpClient({ ...config, name });
    try {
      await client.connect();
      clients.set(name, client);
      console.error(`[porter] MCP server '${name}' connected (${client.getToolDefinitions().length} tools)`);
    } catch (err) {
      console.error(`[porter] MCP server '${name}' failed to connect: ${(err as Error).message}`);
    }
  }

  return clients;
}

/**
 * Collect tools from connected MCP servers, filtered by agent config.
 *
 * mcp_tools patterns:
 * - "server.*" → all tools from server
 * - "server.tool_name" → specific tool
 */
export function collectMcpTools(
  clients: Map<string, McpClient>,
  mcpToolPatterns: string[],
): ToolEntry[] {
  const entries: ToolEntry[] = [];

  for (const pattern of mcpToolPatterns) {
    const dotIdx = pattern.indexOf(".");
    if (dotIdx < 0) continue;

    const serverName = pattern.slice(0, dotIdx);
    const toolPattern = pattern.slice(dotIdx + 1);

    const client = clients.get(serverName);
    if (!client) continue;

    const tools = client.getTools();

    if (toolPattern === "*") {
      // All tools from this server, prefixed with server name
      for (const tool of tools) {
        entries.push({
          definition: {
            ...tool.definition,
            name: `${serverName}__${tool.definition.name}`,
          },
          execute: tool.execute,
        });
      }
    } else {
      // Specific tool
      const tool = tools.find((t) => t.definition.name === toolPattern);
      if (tool) {
        entries.push({
          definition: {
            ...tool.definition,
            name: `${serverName}__${tool.definition.name}`,
          },
          execute: tool.execute,
        });
      }
    }
  }

  return entries;
}
