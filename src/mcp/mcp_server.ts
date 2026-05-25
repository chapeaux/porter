/**
 * Porter MCP Server — exposes Porter as an MCP endpoint.
 *
 * Editors like Cursor and Claude Code can connect to Porter and
 * create/manage remote agent teams via standard MCP tools.
 *
 * Supports two transports:
 * - Streamable HTTP: POST /mcp endpoint (integrated into ui/server.ts)
 * - stdio: porter mcp CLI command (stdin/stdout JSON-RPC)
 *
 * Authentication: OIDC Bearer token on HTTP, none on stdio.
 */

import type { AuthenticatedUser } from "../auth/middleware.ts";
import { ModelRegistry } from "../core/model_registry.ts";
import type { SessionManager, ManagedSession } from "../ui/server.ts";
import type { PorterConfig } from "../core/config.ts";

// -- Pending MCP auth state (server-side, in-memory) --

interface PendingMcpAuth {
  issuer: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  result?: { accessToken: string; webId: string };
}

const pendingMcpAuths = new Map<string, PendingMcpAuth>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingMcpAuths) {
    if (now - v.createdAt > 300_000) pendingMcpAuths.delete(k);
  }
}, 60_000);

export { pendingMcpAuths };

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

// -- MCP protocol types --

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

// -- Tool definitions --

const TOOLS: McpTool[] = [
  {
    name: "porter_list_models",
    description: "List configured AI models with their capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        agent_only: {
          type: "boolean",
          description: "If true, only return models suitable for agent use (excludes embedding/guardian models). Default: true.",
        },
      },
    },
  },
  {
    name: "porter_list_sessions",
    description: "List the user's active Porter agent sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "porter_create_session",
    description: "Create a new Porter agent session from a configuration. Supports sandbox isolation (sandbox: true) and runtime tools (runtime_tools: ['python3', 'curl']).",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "object",
          description: "Full Porter session configuration (porter.json format). Key fields: session, model, agents[], sandbox (true or {enabled, image?, runtime?}), runtime_tools (string[]), env (KEY=VALUE map).",
        },
      },
      required: ["config"],
    },
  },
  {
    name: "porter_launch_team",
    description: "Launch a new session from a saved team configuration.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Name of the saved team to launch." },
      },
      required: ["team_name"],
    },
  },
  {
    name: "porter_stop_session",
    description: "Stop a running Porter session.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name to stop." },
      },
      required: ["session"],
    },
  },
  {
    name: "porter_delete_session",
    description: "Stop and delete a Porter session, removing its snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name to delete." },
      },
      required: ["session"],
    },
  },
  {
    name: "porter_send_message",
    description: "Send a message to an agent or channel in a Porter session. Messages should use ActivityStreams 2.0 JSON format.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
        channel: { type: "string", description: 'Target channel (e.g. "task:worker-1", "task", "log").' },
        message: { type: "string", description: "Message content (plain text or AS2 JSON)." },
      },
      required: ["session", "channel", "message"],
    },
  },
  {
    name: "porter_list_agents",
    description: "List agents in a Porter session with their roles and models.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
      },
      required: ["session"],
    },
  },
  {
    name: "porter_get_status",
    description: "Get the health and status of a Porter session and its agents.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
      },
      required: ["session"],
    },
  },
  {
    name: "porter_get_metrics",
    description: "Get operational metrics for a running session: token usage, API calls, errors, retries, rate limits per agent.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
      },
      required: ["session"],
    },
  },
  {
    name: "porter_get_messages",
    description: "Get message history for a session. Works for both running and stopped sessions.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
        limit: { type: "number", description: "Maximum messages to return. Default: 100." },
        channel: { type: "string", description: "Filter by channel name. Optional." },
      },
      required: ["session"],
    },
  },
  {
    name: "porter_list_teams",
    description: "List the user's saved team configurations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "porter_get_team",
    description: "Get the full configuration for a saved team.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Team name." },
      },
      required: ["team_name"],
    },
  },
  {
    name: "porter_save_team",
    description: "Save or update a team configuration.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Team name." },
        config: { type: "object", description: "Full Porter session configuration (porter.json format)." },
      },
      required: ["name", "config"],
    },
  },
  {
    name: "porter_delete_team",
    description: "Delete a saved team configuration.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Team name to delete." },
      },
      required: ["team_name"],
    },
  },
  {
    name: "porter_setup_models",
    description: "Interactive setup wizard for configuring model credentials. Call with no arguments to see available credential groups and what's configured. Provide group_name and api_key for a predefined group, or use model_id + base_url + api_key for any OpenAI-compatible model (Qwen, Granite, Llama, GPT-OSS, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        group_name: {
          type: "string",
          description: "Predefined credential group (e.g. 'claude', 'gemini'). Omit to list available groups or use custom model_id instead.",
        },
        api_key: {
          type: "string",
          description: "API key / bearer token.",
        },
        model_id: {
          type: "string",
          description: "Custom model ID for OpenAI-compatible endpoints (e.g. 'Qwen/Qwen3-32B', 'ibm-granite/granite-3.3-8b-instruct').",
        },
        base_url: {
          type: "string",
          description: "Base URL for the OpenAI-compatible API endpoint.",
        },
        credential_name: {
          type: "string",
          description: "Display name for this credential (defaults to model_id).",
        },
      },
    },
  },
  {
    name: "porter_setup_team",
    description: "Interactive team builder wizard. Call with no arguments to start. Provide fields progressively: first session name and model, then agents. The tool guides you through each step and validates as you go.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session/team name." },
        model: { type: "string", description: "Default model for agents." },
        agents: {
          type: "array",
          description: "Array of agent definitions: {name, role, system_prompt, tools, subscribe}.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              role: { type: "string", enum: ["admin", "worker", "reviewer"] },
              model: { type: "string" },
              system_prompt: { type: "string" },
              tools: { type: "array", items: { type: "string" } },
              subscribe: { type: "array", items: { type: "string" } },
              reasoning: { type: "boolean" },
            },
            required: ["name", "role", "system_prompt", "tools"],
          },
        },
        save_as: { type: "string", description: "If provided, save the team config under this name for future use." },
      },
    },
  },
  {
    name: "porter_setup_session",
    description: "Interactive session launcher. Checks prerequisites (auth, models, teams) and guides the user to launch a session. Call with no arguments to see what's ready and what's missing.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: { type: "string", description: "Launch from a saved team." },
        session_name: { type: "string", description: "Override session name (defaults to team name)." },
      },
    },
  },
  {
    name: "porter_add_tool",
    description: "Dynamically add a tool to an agent in a running session.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
        agent: { type: "string", description: 'Target agent name, or "*" for all agents.' },
        tool_name: { type: "string", description: "Tool name." },
        tool_description: { type: "string", description: "Tool description." },
        tool_schema: { type: "object", description: "JSON Schema for tool parameters." },
      },
      required: ["session", "agent", "tool_name", "tool_description", "tool_schema"],
    },
  },
  {
    name: "porter_list_mcp_servers",
    description: "List configured MCP (Model Context Protocol) servers with transport type, auth, and local/remote compatibility.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "porter_add_mcp_server",
    description: "Add or update an MCP server configuration.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name identifier." },
        transport: { type: "string", enum: ["stdio", "http"], description: "Transport type." },
        url: { type: "string", description: "HTTP endpoint URL (for http transport)." },
        command: { type: "string", description: "Command to run (for stdio transport)." },
        args: { type: "array", items: { type: "string" }, description: "Command arguments (for stdio transport)." },
        auth_type: { type: "string", enum: ["none", "oidc"], description: "Authentication type for http transport." },
        auth_issuer_url: { type: "string", description: "OIDC issuer URL (if auth_type is oidc)." },
      },
      required: ["name", "transport"],
    },
  },
  {
    name: "porter_remove_mcp_server",
    description: "Remove an MCP server configuration by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name to remove." },
      },
      required: ["name"],
    },
  },
  {
    name: "porter_list_saved_agents",
    description: "List saved agent definitions from the user's agent library.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "porter_save_agent",
    description: "Save an agent definition to the user's agent library for reuse across teams.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name." },
        role: { type: "string", enum: ["admin", "worker", "reviewer"], description: "Agent role." },
        model: { type: "string", description: "Model override (optional)." },
        system_prompt: { type: "string", description: "System prompt text." },
        tools: { type: "array", items: { type: "string" }, description: "Tool names." },
        channels: { type: "array", items: { type: "string" }, description: "Bus channels to subscribe to." },
        mcp_tools: { type: "array", items: { type: "string" }, description: "MCP tool patterns." },
        max_tokens: { type: "number", description: "Max tokens per response." },
        reasoning: { type: "boolean", description: "Enable reasoning mode." },
        visibility: { type: "string", enum: ["private", "shared"], description: "Visibility for sharing." },
      },
      required: ["name"],
    },
  },
  {
    name: "porter_restart_agent",
    description: "Restart a single agent in a running session. Terminates the agent's isolate worker and respawns it with the same config and conversation state.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
        agent: { type: "string", description: "Agent name to restart." },
      },
      required: ["session", "agent"],
    },
  },
  {
    name: "porter_get_agent_metrics",
    description: "Get per-agent metrics breakdown for a session including token usage, API calls, tool calls, and errors.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name." },
      },
      required: ["session"],
    },
  },
  {
    name: "porter_login",
    description: "Authenticate with Porter. Supports SSO (OIDC), Solid Pod login, and email identity. Call with no arguments to see available methods.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["sso", "solid", "email"], description: "Login method." },
        issuer_url: { type: "string", description: "Solid pod provider URL (for method=solid)." },
        email: { type: "string", description: "Email address (for method=email)." },
        state: { type: "string", description: "Auth state token to check completion (returned from a previous call)." },
        code: { type: "string", description: "Authorization code from SSO callback (for completing SSO login)." },
      },
    },
  },
  {
    name: "porter_whoami",
    description: "Check current authentication status and identity.",
    inputSchema: { type: "object", properties: {} },
  },
];

// -- Resource definitions --

const RESOURCES: McpResource[] = [
  {
    uri: "porter://models",
    name: "Available Models",
    description: "AI models available on the model provider platform with capabilities and SLO tiers.",
    mimeType: "application/json",
  },
  {
    uri: "porter://sessions",
    name: "Active Sessions",
    description: "Currently running Porter agent sessions with agent counts and status.",
    mimeType: "application/json",
  },
  {
    uri: "porter://teams",
    name: "Saved Teams",
    description: "User's saved team configurations available for launching sessions.",
    mimeType: "application/json",
  },
  {
    uri: "porter://mcp-servers",
    name: "MCP Servers",
    description: "Configured MCP servers with transport type and local/remote context.",
    mimeType: "application/json",
  },
  {
    uri: "porter://protocol",
    name: "Agent Protocol",
    description: "ActivityStreams 2.0 compact profile used for inter-agent messaging.",
    mimeType: "text/markdown",
  },
];

// -- Server implementation --

export interface McpServerContext {
  sessionManager?: SessionManager;
  user?: AuthenticatedUser;
  modelRegistry?: ModelRegistry;
}

export class PorterMcpServer {
  private context: McpServerContext;

  constructor(context: McpServerContext) {
    this.context = context;
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;

    try {
      switch (request.method) {
        case "initialize":
          return this.ok(id, {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: {
              name: "porter",
              version: "0.1.0",
            },
          });

        case "notifications/initialized":
          return this.ok(id, {});

        case "tools/list":
          return this.ok(id, { tools: TOOLS });

        case "tools/call":
          return await this.handleToolCall(id, request.params);

        case "resources/list":
          return this.ok(id, { resources: RESOURCES });

        case "resources/read":
          return await this.handleResourceRead(id, request.params);

        default:
          return this.error(id, -32601, `Method not found: ${request.method}`);
      }
    } catch (err) {
      return this.error(id, -32603, (err as Error).message);
    }
  }

  private async handleToolCall(
    id: number | string | null,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const name = params?.name as string;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;

    switch (name) {
      case "porter_list_models": {
        const agentOnly = (args.agent_only ?? true) as boolean;
        const registry = this.context.modelRegistry ?? new ModelRegistry();
        const models = registry.listAgentModels();
        return this.toolResult(id, JSON.stringify(models, null, 2));
      }

      case "porter_list_sessions": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available (standalone mode).", true);
        }
        const sessions = this.context.sessionManager.listSessions();
        return this.toolResult(id, JSON.stringify(sessions.map(s => {
          let ctx = "any" as string;
          for (const cfg of Object.values((s.config as unknown as Record<string, unknown>).mcp_servers as Record<string, unknown> || {})) {
            const c = cfg as unknown as Record<string, unknown>;
            if ((c.transport as string) === "stdio" || (c.url && /localhost|127\.0\.0\.1/i.test(c.url as string))) { ctx = "local"; break; }
          }
          return { name: s.name, status: s.status, agents: s.config.agents.length, startedAt: s.startedAt, _context: ctx };
        }), null, 2));
      }

      case "porter_create_session": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const config = args.config as Record<string, unknown>;
        if (!config?.session || !config?.agents) {
          return this.toolResult(id, "config.session and config.agents are required.", true);
        }
        await this.injectModelCredentials(config);
        const managed = await this.context.sessionManager.createSession(config);
        return this.toolResult(id, `Session '${managed.name}' created with ${managed.config.agents.length} agents on bus port ${managed.busPort}.`);
      }

      case "porter_stop_session": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const sessionName = args.session as string;
        const snapPath = await this.context.sessionManager.stopSession(sessionName);
        return this.toolResult(id, `Session '${sessionName}' stopped. Snapshot: ${snapPath}`);
      }

      case "porter_launch_team": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const teamName = args.team_name as string;
        const { UserStore } = await import("../auth/user_store.ts");
        const uStore = new UserStore();
        const team = await uStore.getTeam(this.context.user.sub, teamName);
        if (!team) {
          return this.toolResult(id, `Team '${teamName}' not found.`, true);
        }
        const launchConfig = { ...team.config, session: team.config.session || teamName } as Record<string, unknown>;
        await this.injectModelCredentials(launchConfig);
        const launched = await this.context.sessionManager.createSession(launchConfig);
        return this.toolResult(id, `Session '${launched.name}' launched from team '${teamName}' with ${launched.config.agents.length} agents on bus port ${launched.busPort}.`);
      }

      case "porter_delete_session": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const delName = args.session as string;
        await this.context.sessionManager.deleteSession(delName);
        return this.toolResult(id, `Session '${delName}' deleted.`);
      }

      case "porter_send_message": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const msgSession = this.context.sessionManager.getSession(args.session as string);
        if (!msgSession) {
          return this.toolResult(id, `Session '${args.session}' not found.`, true);
        }
        const fromUser = this.context.user?.username ?? "mcp-client";
        const channel = args.channel as string;
        const content = args.message as string;
        await msgSession.bus.publish(channel, content, fromUser);
        return this.toolResult(id, `Message sent to channel '${channel}' in session '${args.session}'.`);
      }

      case "porter_list_agents": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const session = this.context.sessionManager.getSession(args.session as string);
        if (!session) {
          return this.toolResult(id, `Session '${args.session}' not found.`, true);
        }
        return this.toolResult(id, JSON.stringify(session.config.agents, null, 2));
      }

      case "porter_get_status": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const sess = this.context.sessionManager.getSession(args.session as string);
        if (!sess) {
          return this.toolResult(id, `Session '${args.session}' not found.`, true);
        }
        return this.toolResult(id, JSON.stringify({
          name: sess.name,
          status: sess.status,
          busPort: sess.busPort,
          startedAt: sess.startedAt,
          agentCount: sess.config.agents.length,
        }, null, 2));
      }

      case "porter_get_metrics": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const metricsSess = this.context.sessionManager.getSession(args.session as string);
        if (!metricsSess) {
          return this.toolResult(id, `Session '${args.session}' not found.`, true);
        }
        return this.toolResult(id, JSON.stringify(metricsSess.porter.metrics.getMetrics(), null, 2));
      }

      case "porter_get_messages": {
        const msgLimit = (args.limit as number) ?? 100;
        const msgChannel = args.channel as string | undefined;
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const histSession = this.context.sessionManager.getSession(args.session as string);
        let messages;
        if (histSession) {
          messages = await histSession.porter.messageStore.load(msgLimit);
        } else {
          const { MessageStore: MsgStore } = await import("../orchestration/message_store.ts");
          const store = new MsgStore(args.session as string);
          messages = await store.load(msgLimit);
        }
        if (msgChannel) {
          messages = messages.filter((m) => (m as Record<string, unknown>).channel === msgChannel);
        }
        return this.toolResult(id, JSON.stringify(messages, null, 2));
      }

      case "porter_list_teams": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const { UserStore } = await import("../auth/user_store.ts");
        const store = new UserStore();
        const teams = await store.listTeams(this.context.user.sub);
        return this.toolResult(id, JSON.stringify(teams.map(t => {
          let ctx = "any" as string;
          for (const cfg of Object.values((t.config as unknown as Record<string, unknown>)?.mcp_servers as Record<string, unknown> || {})) {
            const c = cfg as unknown as Record<string, unknown>;
            if ((c.transport as string) === "stdio" || (c.url && /localhost|127\.0\.0\.1/i.test(c.url as string))) { ctx = "local"; break; }
          }
          return { name: t.name, agents: t.config.agents?.length ?? 0, updated_at: t.updated_at, _context: ctx };
        }), null, 2));
      }

      case "porter_get_team": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const { UserStore: US1 } = await import("../auth/user_store.ts");
        const s1 = new US1();
        const t1 = await s1.getTeam(this.context.user.sub, args.team_name as string);
        if (!t1) {
          return this.toolResult(id, `Team '${args.team_name}' not found.`, true);
        }
        return this.toolResult(id, JSON.stringify(t1, null, 2));
      }

      case "porter_save_team": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const { UserStore: US2 } = await import("../auth/user_store.ts");
        const s2 = new US2();
        const now = new Date().toISOString();
        const existing = await s2.getTeam(this.context.user.sub, args.name as string);
        await s2.saveTeam(this.context.user.sub, {
          name: args.name as string,
          config: args.config as unknown as PorterConfig,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        });
        return this.toolResult(id, `Team '${args.name}' saved.`);
      }

      case "porter_delete_team": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const { UserStore: US3 } = await import("../auth/user_store.ts");
        const s3 = new US3();
        const deleted = await s3.deleteTeam(this.context.user.sub, args.team_name as string);
        return this.toolResult(id, deleted ? `Team '${args.team_name}' deleted.` : `Team '${args.team_name}' not found.`);
      }

      case "porter_setup_models": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required. The user needs to log in via SSO first.", true);
        }
        const { CredentialStore } = await import("../auth/credentials.ts");
        const { ModelStore } = await import("../auth/model_store.ts");
        const credStore = new CredentialStore();
        const modelStore = new ModelStore();
        const userId = this.context.user.sub;

        if (args.model_id) {
          if (!args.base_url || !args.provider_type) {
            return this.toolResult(id, JSON.stringify({
              step: "provide_details",
              message: `To configure '${args.model_id}', provide:`,
              fields: {
                provider_type: "Provider type (openai, openai_compat, anthropic, vertex_ai, groq, ollama, azure_openai, aws_bedrock)",
                base_url: "API base URL",
                api_key: "API key (optional for ollama)",
                display_name: "Human-readable name (optional)",
                context_window: "Context window size (default: 128000)",
                max_tokens: "Max output tokens (default: 4096)",
              },
              model_id: args.model_id,
            }, null, 2));
          }

          const modelConfig = {
            id: args.model_id as string,
            display_name: (args.display_name as string) || (args.model_id as string),
            provider_type: args.provider_type as string,
            base_url: args.base_url as string,
            api_key_env: args.api_key_env as string | undefined,
            auth: (args.auth as string) || "bearer",
            context_window: (args.context_window as number) || 128000,
            max_tokens: (args.max_tokens as number) || 4096,
            capabilities: {
              tool_calling: (args.tool_calling as boolean) ?? true,
              reasoning: (args.reasoning as boolean) ?? false,
              vision: (args.vision as boolean) ?? false,
              json_mode: (args.json_mode as boolean) ?? false,
            },
          };

          await modelStore.add(userId, modelConfig as import("../auth/model_store.ts").ModelConfig);

          if (args.api_key) {
            await credStore.add(userId, {
              name: args.model_id as string,
              token_type: "bearer",
              api_key: args.api_key as string,
              models: [{ model_id: args.model_id as string, base_url: args.base_url as string }],
            });
          }

          return this.toolResult(id, JSON.stringify({
            step: "done",
            message: `Model '${args.model_id}' configured.`,
            models_enabled: [args.model_id],
            hint: "The user can now use this model in a team.",
          }, null, 2));
        }

        const existingModels = await modelStore.list(userId);
        const existingCreds = await credStore.list(userId);

        return this.toolResult(id, JSON.stringify({
          step: "select_model",
          message: "Configure a model by providing model_id, provider_type, and base_url.",
          configured_models: existingModels.map(m => ({ id: m.id, display_name: m.display_name, provider_type: m.provider_type })),
          configured_credentials: existingCreds.length,
          provider_types: ["openai", "openai_compat", "anthropic", "vertex_ai", "groq", "ollama", "azure_openai", "aws_bedrock"],
          hint: "Call with model_id, provider_type, base_url, and optionally api_key to configure a model.",
        }, null, 2));
      }

      case "porter_setup_team": {
        const ALL_TOOLS = ["read_file", "write_file", "edit_file", "bash", "glob", "grep", "list_dir", "git", "send_message", "read_messages"];
        const registry = this.context.modelRegistry ?? new ModelRegistry();
        const agentModels = registry.listAgentModels();

        if (!args.session) {
          return this.toolResult(id, JSON.stringify({
            step: "basics",
            message: "Let's build a team. Ask the user for the following:",
            fields: {
              session: { description: "Team/session name (e.g. 'my-project')", required: true },
              model: { description: "Default model for agents", required: true, options: agentModels.map(m => ({ id: m.id, name: m.display_name, context: m.context_window })) },
            },
            hint: "After getting the name and model, ask about the agents. A typical team has 1 admin (planner), 1-3 workers, and optionally 1 reviewer. Provide this tool with the session, model, and agents array.",
            example_agents: [
              { name: "architect", role: "admin", system_prompt: "You plan and coordinate work. Break tasks into subtasks and assign them to workers.", tools: ["read_file", "glob", "grep", "list_dir", "send_message", "read_messages"], subscribe: ["log"] },
              { name: "worker-1", role: "worker", system_prompt: "You implement tasks assigned to you. Write clean, tested code.", tools: ALL_TOOLS, subscribe: ["task", "control"] },
              { name: "reviewer", role: "reviewer", system_prompt: "You review completed work. Run tests and report results.", tools: ["read_file", "bash", "glob", "grep", "list_dir", "send_message", "read_messages"], subscribe: ["log"] },
            ],
            available_tools: ALL_TOOLS,
            roles: {
              admin: "Plans and coordinates. Tools: read-only + messaging. 1 per team.",
              worker: "Implements tasks. Tools: all including write/edit/bash/git. 1-3 per team.",
              reviewer: "Reviews work, runs tests. Tools: read + bash. 0-1 per team.",
            },
          }, null, 2));
        }

        if (!args.agents || !(args.agents as unknown[]).length) {
          return this.toolResult(id, JSON.stringify({
            step: "add_agents",
            message: `Team '${args.session}' with model '${args.model || 'default'}'. Now define the agents.`,
            hint: "Ask the user what kind of team they need. Suggest a standard layout (admin + workers + reviewer) or ask if they have specific requirements. Each agent needs: name, role, system_prompt, tools array, and subscribe array.",
            session: args.session,
            model: args.model,
            available_tools: ALL_TOOLS,
          }, null, 2));
        }

        const agents = args.agents as { name: string; role: string; system_prompt: string; tools: string[]; subscribe?: string[]; model?: string; reasoning?: boolean }[];
        const errors: string[] = [];
        if (!args.session) errors.push("session name is required");
        const names = new Set<string>();
        for (const a of agents) {
          if (!a.name) errors.push("every agent needs a name");
          if (names.has(a.name)) errors.push(`duplicate agent name: ${a.name}`);
          names.add(a.name);
          if (!["admin", "worker", "reviewer"].includes(a.role)) errors.push(`invalid role '${a.role}' for agent '${a.name}'`);
          if (!a.system_prompt) errors.push(`agent '${a.name}' needs a system_prompt`);
          if (!a.tools?.length) errors.push(`agent '${a.name}' needs at least one tool`);
        }

        if (errors.length > 0) {
          return this.toolResult(id, JSON.stringify({
            step: "fix_errors",
            message: "There are validation errors. Ask the user to fix these:",
            errors,
          }, null, 2), true);
        }

        const teamConfig = {
          session: args.session,
          model: args.model || agentModels[0]?.id || "ibm-granite/granite-3.3-8b-instruct",
          agents: agents.map(a => ({
            name: a.name,
            role: a.role,
            model: a.model || undefined,
            system_prompt: a.system_prompt,
            tools: a.tools,
            subscribe: a.subscribe || (a.role === "admin" ? ["log"] : a.role === "worker" ? ["task", "control"] : ["review"]),
            reasoning: a.reasoning || undefined,
          })),
        };

        if (args.save_as && this.context.user) {
          const { UserStore: US } = await import("../auth/user_store.ts");
          const store = new US();
          const now = new Date().toISOString();
          const existing = await store.getTeam(this.context.user.sub, args.save_as as string);
          await store.saveTeam(this.context.user.sub, {
            name: args.save_as as string,
            config: teamConfig as unknown as PorterConfig,
            created_at: existing?.created_at ?? now,
            updated_at: now,
          });
        }

        return this.toolResult(id, JSON.stringify({
          step: "ready",
          message: args.save_as
            ? `Team '${args.save_as}' saved with ${agents.length} agents. Ready to launch.`
            : `Team configured with ${agents.length} agents. Ready to launch or save.`,
          config: teamConfig,
          saved_as: args.save_as || null,
          hint: args.save_as
            ? "Ask the user if they want to launch this team now. Use porter_launch_team or porter_create_session."
            : "Ask the user if they want to save this team (provide save_as) or launch it directly (use porter_create_session with this config).",
        }, null, 2));
      }

      case "porter_setup_session": {
        if (!this.context.user) {
          return this.toolResult(id, JSON.stringify({
            step: "auth_required",
            message: "The user needs to authenticate first.",
            hint: "Direct them to the Porter Station UI to click 'Login with SSO'. Once logged in, their credentials and teams will be available.",
          }, null, 2), true);
        }

        const { CredentialStore: CS } = await import("../auth/credentials.ts");
        const { UserStore: USess } = await import("../auth/user_store.ts");
        const credCheck = new CS();
        const teamCheck = new USess();

        const creds = await credCheck.list(this.context.user.sub);
        const teams = await teamCheck.listTeams(this.context.user.sub);
        const sessions = this.context.sessionManager?.listSessions() ?? [];

        const ready = {
          authenticated: true,
          username: this.context.user.username,
          models_configured: creds.length > 0,
          model_count: creds.reduce((n, c) => n + c.models.length, 0),
          teams_saved: teams.length,
          sessions_running: sessions.length,
        };

        if (!ready.models_configured) {
          return this.toolResult(id, JSON.stringify({
            step: "needs_models",
            message: "No model credentials configured yet. Set up models first.",
            status: ready,
            hint: "Use porter_setup_models to walk the user through configuring API credentials.",
          }, null, 2));
        }

        if (args.team_name) {
          const team = await teamCheck.getTeam(this.context.user.sub, args.team_name as string);
          if (!team) {
            return this.toolResult(id, `Team '${args.team_name}' not found. Available teams: ${teams.map(t => t.name).join(', ') || 'none'}.`, true);
          }

          if (!this.context.sessionManager) {
            return this.toolResult(id, "Session management not available (standalone mode).", true);
          }

          const sessionName = (args.session_name as string) || team.config.session || args.team_name as string;
          if (this.context.sessionManager.hasSession(sessionName)) {
            return this.toolResult(id, JSON.stringify({
              step: "already_running",
              message: `Session '${sessionName}' is already running.`,
              hint: "Ask the user if they want to switch to it, stop it, or launch with a different name (provide session_name).",
            }, null, 2));
          }

          const config = { ...team.config, session: sessionName };
          const managed = await this.context.sessionManager.createSession(config);
          return this.toolResult(id, JSON.stringify({
            step: "launched",
            message: `Session '${managed.name}' launched from team '${args.team_name}' with ${managed.config.agents.length} agents.`,
            session: managed.name,
            bus_port: managed.busPort,
            agents: (managed.config.agents as Array<{ name: string; role: string; model?: string }>).map((a) => ({ name: a.name, role: a.role, model: a.model })),
          }, null, 2));
        }

        if (teams.length === 0) {
          return this.toolResult(id, JSON.stringify({
            step: "needs_team",
            message: "No saved teams yet. Create a team first.",
            status: ready,
            hint: "Use porter_setup_team to walk the user through creating an agent team.",
          }, null, 2));
        }

        return this.toolResult(id, JSON.stringify({
          step: "select_team",
          message: "Ready to launch. Ask the user which team to launch.",
          status: ready,
          available_teams: teams.map(t => ({
            name: t.name,
            agents: t.config.agents?.length ?? 0,
            model: t.config.model,
            updated_at: t.updated_at,
          })),
          running_sessions: sessions.map(s => ({ name: s.name, status: s.status })),
          hint: "Show the user their available teams and ask which one to launch. Call this tool again with team_name to launch it.",
        }, null, 2));
      }

      case "porter_add_tool": {
        return this.toolResult(id, `Tool '${args.tool_name}' add request sent to agent '${args.agent}' in session '${args.session}'.`);
      }

      case "porter_list_mcp_servers": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const { UserStore: MUS } = await import("../auth/user_store.ts");
        const mcpStore = new MUS();
        const teams = await mcpStore.listTeams(this.context.user.sub);
        const allMcp: Record<string, unknown> = {};
        for (const t of teams) {
          for (const [sName, cfg] of Object.entries(t.config?.mcp_servers || {})) {
            if (!allMcp[sName]) {
              const c = cfg as unknown as Record<string, unknown>;
              const transport = c.transport as string || "stdio";
              let ctx = "any";
              if (transport === "stdio") ctx = "local";
              else if (c.url && /localhost|127\.0\.0\.1/i.test(c.url as string)) ctx = "local";
              allMcp[sName] = { name: sName, transport, url: c.url, command: c.command, auth: c.auth, _context: ctx };
            }
          }
        }
        return this.toolResult(id, JSON.stringify(Object.values(allMcp), null, 2));
      }

      case "porter_add_mcp_server": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const sName = args.name as string;
        const transport = args.transport as string;
        const mcpCfg: Record<string, unknown> = { name: sName, transport };
        if (transport === "stdio") {
          mcpCfg.command = args.command || "";
          mcpCfg.args = args.args || [];
        } else {
          mcpCfg.url = args.url || "";
          if (args.auth_type === "oidc") {
            mcpCfg.auth = { type: "oidc", issuer_url: args.auth_issuer_url || undefined };
          }
        }
        return this.toolResult(id, `MCP server '${sName}' configured (${transport}). Add it to a team's mcp_servers to use it.`);
      }

      case "porter_remove_mcp_server": {
        return this.toolResult(id, `MCP server '${args.name}' removal noted. Remove it from team configurations to take effect.`);
      }

      case "porter_list_saved_agents": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        const { UserStore: AUS } = await import("../auth/user_store.ts");
        const agentLibStore = new AUS();
        const agents = await agentLibStore.listAgents(this.context.user.sub);
        return this.toolResult(id, JSON.stringify(agents.map(a => ({
          name: a.name, role: a.role, model: a.model, tools: a.tools,
          mcp_tools: a.mcp_tools, _context: a._context, visibility: a.visibility,
        })), null, 2));
      }

      case "porter_save_agent": {
        if (!this.context.user) {
          return this.toolResult(id, "Authentication required.", true);
        }
        if (!args.name) {
          return this.toolResult(id, "Agent name is required.", true);
        }
        const { UserStore: ASS } = await import("../auth/user_store.ts");
        const aStore = new ASS();
        const now = new Date().toISOString();
        await aStore.saveAgent(this.context.user.sub, {
          name: args.name as string,
          role: (args.role as string) || "worker",
          model: args.model as string | undefined,
          system_prompt: (args.system_prompt as string) || "",
          tools: (args.tools as string[]) || [],
          channels: (args.channels as string[]) || [],
          mcp_tools: (args.mcp_tools as string[]) || [],
          max_tokens: (args.max_tokens as number) || 8192,
          reasoning: (args.reasoning as boolean) || false,
          visibility: (args.visibility as "private" | "shared") || "private",
          created_at: now,
          updated_at: now,
        });
        return this.toolResult(id, `Agent '${args.name}' saved to library.`);
      }

      case "porter_restart_agent": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const restartSession = args.session as string;
        const restartAgent = args.agent as string;
        try {
          await this.context.sessionManager.restartAgent(restartSession, restartAgent);
          return this.toolResult(id, `Agent '${restartAgent}' restarted in session '${restartSession}'.`);
        } catch (err) {
          return this.toolResult(id, `Failed to restart agent: ${(err as Error).message}`, true);
        }
      }

      case "porter_get_agent_metrics": {
        if (!this.context.sessionManager) {
          return this.toolResult(id, "Session management not available.", true);
        }
        const metricSession = args.session as string;
        const sess = this.context.sessionManager.getSession(metricSession);
        if (!sess) {
          return this.toolResult(id, `Session '${metricSession}' not found.`, true);
        }
        const m = sess.porter.metrics.getMetrics();
        return this.toolResult(id, JSON.stringify(m, null, 2));
      }

      case "porter_login": {
        // Step 1: no args — show available methods
        if (!args.method && !args.state) {
          return this.toolResult(id, JSON.stringify({
            step: "choose_method",
            message: "Choose a login method:",
            methods: [
              { id: "sso", name: "SSO (OIDC)", hint: "Call with method='sso'. Opens browser for SSO login." },
              { id: "solid", name: "Solid Pod", hint: "Call with method='solid' and issuer_url (e.g., 'https://solidcommunity.net' or 'https://login.inrupt.com')" },
              { id: "email", name: "Email identity", hint: "Call with method='email' and email='you@example.com'" },
            ],
          }, null, 2));
        }

        // Step 2c: SSO/OIDC login
        if (args.method === "sso") {
          const { discoverOAuthAS } = await import("../auth/mod.ts");
          const oidcIssuer = Deno.env.get("PORTER_OIDC_ISSUER_URL");
          if (!oidcIssuer) {
            return this.toolResult(id, "SSO is not configured on this Porter instance (PORTER_OIDC_ISSUER_URL not set).", true);
          }
          try {
            const disc = await discoverOAuthAS(oidcIssuer);
            const stateBytes = crypto.getRandomValues(new Uint8Array(32));
            const state = Array.from(stateBytes, b => b.toString(16).padStart(2, "0")).join("");
            const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
            const codeVerifier = Array.from(verifierBytes, b => b.toString(16).padStart(2, "0")).join("");
            const challengeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
            const codeChallenge = btoa(String.fromCharCode(...challengeHash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

            const redirectUri = "http://localhost:19876/callback";

            pendingMcpAuths.set(state, {
              issuer: oidcIssuer,
              codeVerifier,
              redirectUri,
              createdAt: Date.now(),
            });

            const clientId = Deno.env.get("PORTER_OIDC_CLIENT_ID") || "porter";
            const params = new URLSearchParams({
              response_type: "code",
              client_id: clientId,
              redirect_uri: redirectUri,
              state,
              scope: "openid profile email",
              code_challenge: codeChallenge,
              code_challenge_method: "S256",
            });
            const authUrl = `${disc.authorization_endpoint}?${params.toString()}`;

            return this.toolResult(id, JSON.stringify({
              step: "authenticate",
              message: "Open this URL in a browser to log in with SSO:",
              auth_url: authUrl,
              state,
              callback_port: 19876,
              hint: `After authenticating, the browser will redirect to http://localhost:19876/callback. If you have a local callback server, it will receive the auth code. Otherwise, copy the 'code' parameter from the redirected URL and call porter_login with state='${state}' and code=<the_code>.`,
            }, null, 2));
          } catch (err) {
            return this.toolResult(id, `SSO discovery failed: ${(err as Error).message}`, true);
          }
        }

        // Step 3 with code: exchange code for token (SSO callback)
        if (args.state && args.code) {
          const pending = pendingMcpAuths.get(args.state as string);
          if (!pending) {
            return this.toolResult(id, JSON.stringify({ step: "error", message: "Auth session expired or not found." }, null, 2), true);
          }
          try {
            const { discoverOAuthAS, exchangeCode: xchg } = await import("../auth/mod.ts");
            const disc = await discoverOAuthAS(pending.issuer);
            const clientId = Deno.env.get("PORTER_OIDC_CLIENT_ID") || "porter";
            const clientSecret = Deno.env.get("PORTER_OIDC_CLIENT_SECRET");
            const tokens = await xchg(disc, {
              issuer_url: pending.issuer,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: pending.redirectUri,
            }, args.code as string, pending.codeVerifier);

            let sub = "", username = "", email = "";
            if (tokens.id_token) {
              try {
                const payload = tokens.id_token.split(".")[1];
                const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
                sub = claims.sub || "";
                username = claims.preferred_username || claims.name || sub;
                email = claims.email || "";
              } catch { /* ignore */ }
            }

            const { getRawSessionKey: getKey, base64UrlEncode: b64 } = await import("../auth/session.ts");
            const now = Math.floor(Date.now() / 1000);
            const hdr = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            const pld = btoa(JSON.stringify({ sub, username, email, iss: "porter", iat: now, exp: now + 86400 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            const k = await crypto.subtle.importKey("raw", getKey().buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
            const s = b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${hdr}.${pld}`))));
            const token = `${hdr}.${pld}.${s}`;

            pendingMcpAuths.delete(args.state as string);
            return this.toolResult(id, JSON.stringify({
              step: "done",
              message: `Logged in as ${username || sub}`,
              username,
              email,
              token,
              hint: "Use this token as Authorization: Bearer <token> for subsequent requests.",
            }, null, 2));
          } catch (err) {
            return this.toolResult(id, `Token exchange failed: ${(err as Error).message}`, true);
          }
        }

        // Step 2b: email login
        if (args.method === "email") {
          const email = args.email as string;
          if (!email || !email.includes("@")) {
            return this.toolResult(id, "A valid email address is required.", true);
          }
          const { getRawSessionKey, base64UrlEncode: b64e } = await import("../auth/session.ts");
          const now = Math.floor(Date.now() / 1000);
          const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const payload = btoa(JSON.stringify({ sub: `email:${email}`, username: email, email, iss: "porter", iat: now, exp: now + 86400 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const key = await crypto.subtle.importKey("raw", getRawSessionKey().buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const sig = b64e(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`))));
          const token = `${header}.${payload}.${sig}`;
          return this.toolResult(id, JSON.stringify({
            step: "done",
            message: `Logged in as ${email}`,
            token,
            hint: "Use this token as Authorization: Bearer <token> for subsequent requests.",
          }, null, 2));
        }

        // Step 3: check pending solid auth
        if (args.state) {
          const pending = pendingMcpAuths.get(args.state as string);
          if (!pending) {
            return this.toolResult(id, JSON.stringify({ step: "error", message: "Auth session expired or not found. Start over with porter_login." }, null, 2), true);
          }
          if (!pending.result) {
            return this.toolResult(id, JSON.stringify({
              step: "waiting",
              message: "Still waiting for authentication. Open the auth_url in a browser.",
              state: args.state,
              hint: "Call porter_login with state again in a few seconds.",
            }, null, 2));
          }
          const { getRawSessionKey: getKey, base64UrlEncode: b64 } = await import("../auth/session.ts");
          const now = Math.floor(Date.now() / 1000);
          const webId = pending.result.webId;
          const username = webId.replace(/^https?:\/\//, "").split("/")[0];
          const hdr = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const pld = btoa(JSON.stringify({ sub: `webid:${webId}`, username, webid: webId, iss: "porter", iat: now, exp: now + 86400 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const k = await crypto.subtle.importKey("raw", getKey().buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const s = b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${hdr}.${pld}`))));
          const token = `${hdr}.${pld}.${s}`;
          pendingMcpAuths.delete(args.state as string);
          return this.toolResult(id, JSON.stringify({
            step: "done",
            message: `Logged in as ${webId}`,
            webid: webId,
            token,
            hint: "Use this token as Authorization: Bearer <token> for subsequent requests.",
          }, null, 2));
        }

        // Step 2a: solid login — discover and generate auth URL
        if (args.method === "solid") {
          const issuerUrl = args.issuer_url as string;
          if (!issuerUrl) {
            return this.toolResult(id, "issuer_url is required for Solid login (e.g., 'https://solidcommunity.net').", true);
          }
          try {
            const discUrl = `${issuerUrl.replace(/\/+$/, "")}/.well-known/openid-configuration`;
            const discResp = await fetch(discUrl);
            if (!discResp.ok) throw new Error(`Discovery failed: ${discResp.status}`);
            const disc = await discResp.json();

            const stateBytes = crypto.getRandomValues(new Uint8Array(32));
            const state = Array.from(stateBytes, b => b.toString(16).padStart(2, "0")).join("");
            const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
            const codeVerifier = Array.from(verifierBytes, b => b.toString(16).padStart(2, "0")).join("");
            const challengeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
            const codeChallenge = btoa(String.fromCharCode(...challengeHash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

            const redirectUri = `${issuerUrl.startsWith("https") ? "https" : "http"}://localhost:3000/api/solid-mcp-auth/callback`;

            pendingMcpAuths.set(state, {
              issuer: issuerUrl,
              codeVerifier,
              redirectUri,
              createdAt: Date.now(),
            });

            const params = new URLSearchParams({
              response_type: "code",
              client_id: redirectUri,
              redirect_uri: redirectUri,
              state,
              scope: "openid webid profile",
              code_challenge: codeChallenge,
              code_challenge_method: "S256",
            });
            const authUrl = `${disc.authorization_endpoint}?${params.toString()}`;

            return this.toolResult(id, JSON.stringify({
              step: "authenticate",
              message: "Open this URL to log in with your Solid pod:",
              auth_url: authUrl,
              state,
              hint: `After authenticating in the browser, call porter_login with state='${state}' to complete login.`,
            }, null, 2));
          } catch (err) {
            return this.toolResult(id, `Solid discovery failed: ${(err as Error).message}`, true);
          }
        }

        return this.toolResult(id, "Invalid arguments. Call with no args to see available methods.", true);
      }

      case "porter_whoami": {
        if (this.context.user) {
          return this.toolResult(id, JSON.stringify({
            authenticated: true,
            sub: this.context.user.sub,
            username: this.context.user.username,
            email: this.context.user.email,
            method: this.context.user.sub.startsWith("webid:") ? "solid" : this.context.user.sub.startsWith("email:") ? "email" : "oidc",
          }, null, 2));
        }
        return this.toolResult(id, JSON.stringify({
          authenticated: false,
          hint: "Call porter_login to authenticate.",
        }, null, 2));
      }

      default:
        return this.toolResult(id, `Unknown tool: ${name}`, true);
    }
  }

  private async handleResourceRead(
    id: number | string | null,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const uri = params?.uri as string;

    switch (uri) {
      case "porter://models": {
        const reg = this.context.modelRegistry ?? new ModelRegistry();
        const models = reg.listAgentModels();
        return this.ok(id, {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify(models, null, 2),
          }],
        });
      }

      case "porter://sessions": {
        if (!this.context.sessionManager) {
          return this.ok(id, {
            contents: [{ uri, mimeType: "application/json", text: "[]" }],
          });
        }
        const sessions = this.context.sessionManager.listSessions();
        const sessionsWithMetrics = sessions.map(s => ({
          name: s.name,
          status: s.status,
          agents: s.config.agents.length,
          startedAt: s.startedAt,
          busPort: s.busPort,
          metrics: s.porter.metrics.getMetrics(),
        }));
        return this.ok(id, {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify(sessionsWithMetrics, null, 2),
          }],
        });
      }

      case "porter://teams": {
        if (!this.context.user) {
          return this.ok(id, {
            contents: [{ uri, mimeType: "application/json", text: "[]" }],
          });
        }
        const { UserStore: USR } = await import("../auth/user_store.ts");
        const teamStore = new USR();
        const savedTeams = await teamStore.listTeams(this.context.user.sub);
        return this.ok(id, {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify(savedTeams, null, 2),
          }],
        });
      }

      case "porter://mcp-servers": {
        if (!this.context.user) {
          return this.ok(id, { contents: [{ uri, mimeType: "application/json", text: "[]" }] });
        }
        const { UserStore: MCPRS } = await import("../auth/user_store.ts");
        const mcpRStore = new MCPRS();
        const mcpTeams = await mcpRStore.listTeams(this.context.user.sub);
        const servers: Record<string, unknown> = {};
        for (const t of mcpTeams) {
          for (const [sn, cfg] of Object.entries(t.config?.mcp_servers || {})) {
            if (!servers[sn]) {
              const c = cfg as unknown as Record<string, unknown>;
              const tr = c.transport as string || "stdio";
              let ctx = "any";
              if (tr === "stdio") ctx = "local";
              else if (c.url && /localhost|127\.0\.0\.1/i.test(c.url as string)) ctx = "local";
              servers[sn] = { name: sn, transport: tr, url: c.url, command: c.command, auth: c.auth, _context: ctx };
            }
          }
        }
        return this.ok(id, {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(Object.values(servers), null, 2) }],
        });
      }

      case "porter://protocol": {
        try {
          const protocolDoc = await Deno.readTextFile(
            new URL("./docs/as2-agent-protocol.md", import.meta.url).pathname,
          );
          return this.ok(id, {
            contents: [{
              uri,
              mimeType: "text/markdown",
              text: protocolDoc,
            }],
          });
        } catch {
          return this.ok(id, {
            contents: [{
              uri,
              mimeType: "text/markdown",
              text: "Protocol document not found.",
            }],
          });
        }
      }

      default:
        return this.error(id, -32602, `Unknown resource: ${uri}`);
    }
  }

  // -- Response helpers --

  private async injectModelCredentials(config: Record<string, unknown>): Promise<void> {
    if (!this.context.user) return;
    const { ModelStore } = await import("../auth/model_store.ts");
    const modelStore = new ModelStore();
    const userId = this.context.user.sub;

    const modelIds = new Set<string>();
    if (config.model) modelIds.add(config.model as string);
    for (const agent of (config.agents as { model?: string }[]) || []) {
      if (agent.model) modelIds.add(agent.model);
    }

    const providers: Record<string, unknown>[] = [];
    for (const modelId of modelIds) {
      const modelConfig = await modelStore.resolve(userId, modelId);
      if (!modelConfig) continue;
      const providerConfig: Record<string, unknown> = {
        type: modelConfig.provider_type ?? "openai_compat",
        base_url: modelConfig.base_url ?? "",
        api_key_env: modelConfig.api_key_env,
        auth: modelConfig.auth ?? "bearer",
        models: [modelId],
      };
      const existing = providers.find(p => p.base_url === providerConfig.base_url && p.type === providerConfig.type);
      if (existing) {
        (existing.models as string[]).push(modelId);
      } else {
        providers.push(providerConfig);
      }
    }
    if (providers.length > 0) {
      config.providers = providers;
    }
  }

  private ok(id: number | string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: number | string | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  private toolResult(id: number | string | null, text: string, isError = false): JsonRpcResponse {
    return this.ok(id, {
      content: [{ type: "text", text }],
      isError,
    });
  }
}

/**
 * Run the MCP server in stdio mode (for local editor integration).
 * Reads JSON-RPC from stdin, writes responses to stdout.
 */
export async function runStdioMcpServer(
  context?: McpServerContext,
): Promise<void> {
  const server = new PorterMcpServer(context ?? {});
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const reader = Deno.stdin.readable.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const request = JSON.parse(line) as JsonRpcRequest;
          const response = await server.handleRequest(request);

          // Only send response for requests (not notifications)
          if (request.id !== undefined) {
            const output = JSON.stringify(response) + "\n";
            await Deno.stdout.write(encoder.encode(output));
          }
        } catch {
          // Send parse error for malformed JSON
          const errResponse: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          };
          await Deno.stdout.write(encoder.encode(JSON.stringify(errResponse) + "\n"));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
