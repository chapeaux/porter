/**
 * Porter Station -- web dashboard server.
 *
 * All UI assets are embedded via import attributes so the server
 * works as a standalone executable without the source directory.
 */

import { extname, join } from "@std/path";
import { PorterMcpServer } from "../mcp/mcp_server.ts";
import {
  loadOidcConfig,
  discover,
  discoverOAuthAS,
  buildAuthUrl,
  exchangeCode,
  initSessionKey,
  createSessionCookie,
  readSession,
  clearSessionCookie,
  generateCsrf,
  validateCsrf,
  clearCsrfCookie,
  generateCodeChallenge,
  extractUser,
  requireAuth,
  CredentialStore,
  UserStore,
  type OidcConfig,
  type OidcDiscovery,
  type AuthenticatedUser,
} from "../auth/mod.ts";
import type { SavedAgent, SavedTeam } from "../auth/user_store.ts";

// Load UI assets from disk relative to this file
const UI_DIR = import.meta.dirname!;
const index_html = Deno.readTextFileSync(join(UI_DIR, "index.html"));
const app_js = Deno.readTextFileSync(join(UI_DIR, "app.js"));
const cpx_store_js = Deno.readTextFileSync(join(UI_DIR, "cpx-store.js"));
const cpx_model_config_js = Deno.readTextFileSync(join(UI_DIR, "cpx-model-config.js"));
const solid_auth_js = Deno.readTextFileSync(join(UI_DIR, "solid-auth.js"));
const porter_dialog_js = Deno.readTextFileSync(join(UI_DIR, "porter-dialog.js"));
const flipboard_js = Deno.readTextFileSync(join(UI_DIR, "flipboard.js"));
const porter_svg = Deno.readTextFileSync(join(UI_DIR, "porter.svg"));
const porter_css = Deno.readTextFileSync(join(UI_DIR, "porter.css"));
const mcp_auth_html = Deno.readTextFileSync(join(UI_DIR, "mcp-auth-result.html"));
let manifest_json = "";
try { manifest_json = Deno.readTextFileSync(join(UI_DIR, "manifest.json")); } catch { /* optional */ }
let sw_js = "";
try { sw_js = Deno.readTextFileSync(join(UI_DIR, "sw.js")); } catch { /* optional */ }
let porter_192_png: Uint8Array | null = null;
try { porter_192_png = Deno.readFileSync(join(UI_DIR, "porter-192.png")); } catch { /* optional */ }
let porter_512_png: Uint8Array | null = null;
try { porter_512_png = Deno.readFileSync(join(UI_DIR, "porter-512.png")); } catch { /* optional */ }

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Embedded assets served from memory. */
const ASSETS: Record<string, string> = {
  "/index.html": index_html,
  "/app.js": app_js,
  "/cpx-store.js": cpx_store_js,
  "/cpx-model-config.js": cpx_model_config_js,
  "/solid-auth.js": solid_auth_js,
  "/porter-dialog.js": porter_dialog_js,
  "/flipboard.js": flipboard_js,
  "/porter.svg": porter_svg,
  "/porter.css": porter_css,
  "/manifest.json": manifest_json,
  "/sw.js": sw_js,
};

/** Minimal shape of a managed session returned by SessionManager. */
export interface ManagedSession {
  name: string;
  porter: {
    metrics: { getMetrics(): unknown };
    messageStore: { flush(): Promise<void>; load(limit?: number): Promise<unknown[]> };
  };
  bus: { publish(channel: string, content: string, from?: string): Promise<void> };
  busServer: { broadcast(msg: unknown): void };
  busPort: number;
  startedAt: string;
  status: string;
  config: { agents: unknown[]; mcp_servers?: Record<string, unknown> };
  ownerId?: string;
}

/** Minimal SessionManager interface — implemented by session_manager.ts. */
export interface SessionManager {
  hasSession(name: string): boolean;
  getSession(name: string): ManagedSession | undefined;
  listSessions(): ManagedSession[];
  listSessionsForUser(ownerId: string): ManagedSession[];
  assertOwner(name: string, requesterId: string): ManagedSession;
  createSession(config: unknown, options?: { sessionName?: string; restoreFrom?: string; ownerId?: string }): Promise<ManagedSession>;
  stopSession(name: string): Promise<string>;
  deleteSession(name: string): Promise<void>;
  restartAgent(sessionName: string, agentName: string): Promise<void>;
}

/** Options for starting the UI server. */
export interface UiServerOptions {
  /** Port to listen on. Default: 3000. */
  port?: number;
  /** WebSocket bus URL. Default: ws://localhost:8787. */
  busUrl?: string;
  /** Optional in-process session manager. When present, enables live session launch/stop/delete. */
  sessionManager?: SessionManager;
  /** OIDC configuration. If omitted, auth is disabled (all endpoints are public). */
  oidcConfig?: OidcConfig;
  /** Single-user mode: skip OIDC, auto-create a default session. Used by user pods behind the router. */
  singleUser?: boolean;
  /** ActivityPub federation configuration. If omitted, federation is disabled. */
  activityPubConfig?: import("../activitypub/config.ts").ActivityPubConfig;
}

function mcpAuthResultPage(
  result: { server: string; access_token: string; refresh_token?: string; expires_in?: number } | null,
  error?: string,
): string {
  const isError = !result;
  const tokenData = result ? JSON.stringify({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expires_at: result.expires_in ? Date.now() + result.expires_in * 1000 : null,
  }) : "null";
  const storageKey = result ? `porter-mcp-token-${result.server}` : "";
  const serverName = result?.server ?? "";
  const errorMsg = error || "Unknown error";

  return mcp_auth_html
    .replace("{{IS_ERROR}}", JSON.stringify(isError))
    .replace("{{TOKEN_DATA}}", JSON.stringify(tokenData))
    .replace("{{STORAGE_KEY}}", JSON.stringify(storageKey))
    .replace("{{SERVER_NAME}}", JSON.stringify(serverName))
    .replace("{{ERROR_MSG}}", JSON.stringify(errorMsg));
}

// --- Agent/Team serialization helpers ---

/** Convert a JSON-LD (or plain JSON) agent document to a SavedAgent. */
function jsonLdToSavedAgent(json: Record<string, unknown>): SavedAgent | null {
  const name = (json.name ?? json["porter:name"]) as string;
  if (!name) return null;
  return {
    name,
    role: (json.role ?? "worker") as string,
    model: (json.model ?? json["porter:usesModel"]) as string | undefined,
    system_prompt: (json.expertise ?? json.system_prompt ?? json["porter:agentExpertise"] ?? "") as string,
    tools: (json.tools ?? json["porter:hasTool"] ?? []) as string[],
    channels: [],
    mcp_tools: [],
    max_tokens: (json.maxTokens ?? json.max_tokens ?? 8192) as number,
    reasoning: (json.reasoning ?? false) as boolean,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** Serialize a SavedAgent as JSON-LD. */
function agentToJsonLd(agent: SavedAgent, userId: string): Record<string, unknown> {
  return {
    "@context": "https://porter.chapeaux.io/agents/context.jsonld",
    "@id": `porter:${userId}/agents/${agent.name}`,
    "@type": "Agent",
    name: agent.name,
    expertise: agent.system_prompt,
    tools: agent.tools,
    model: agent.model,
    reasoning: agent.reasoning,
    maxTokens: agent.max_tokens,
    visibility: agent.visibility ?? "private",
  };
}

/** Serialize a SavedAgent as Turtle. */
function agentToTurtle(agent: SavedAgent, userId: string): string {
  const uri = `<https://porter.chapeaux.io/vocab#${userId}/agents/${agent.name}>`;
  const lines = [
    "@prefix porter: <https://porter.chapeaux.io/vocab#> .",
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    "",
    `${uri} a porter:Agent ;`,
    `  porter:name "${agent.name}" ;`,
    `  porter:agentExpertise """${(agent.system_prompt || "").replace(/"""/g, '\\"\\"\\"')}""" ;`,
  ];
  for (const t of agent.tools || []) {
    lines.push(`  porter:hasTool "${t}" ;`);
  }
  if (agent.model) lines.push(`  porter:usesModel "${agent.model}" ;`);
  lines.push(`  porter:visibility "${agent.visibility ?? "private"}" .`);
  return lines.join("\n");
}

/** Serialize a SavedTeam as JSON-LD. */
function teamToJsonLd(team: SavedTeam): Record<string, unknown> {
  return {
    "@context": "https://porter.chapeaux.io/teams/context.jsonld",
    "@type": "Team",
    name: team.name,
    pattern: team.config.pattern,
    agents: team.config.agents.map((a) => ({
      "@type": "AgentRef",
      ref: (a as unknown as Record<string, unknown>).ref ?? a.name,
      role: a.role,
      model: a.model,
    })),
  };
}

/** Serialize a SavedTeam as Turtle. */
function teamToTurtle(team: SavedTeam): string {
  const uri = `<https://porter.chapeaux.io/vocab#teams/${team.name}>`;
  const lines = [
    "@prefix porter: <https://porter.chapeaux.io/vocab#> .",
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    "",
    `${uri} a porter:Team ;`,
    `  porter:name "${team.name}" ;`,
  ];
  if (team.config.pattern) {
    lines.push(`  porter:teamPattern "${team.config.pattern}" ;`);
  }
  for (const a of team.config.agents) {
    const ref = (a as unknown as Record<string, unknown>).ref ?? a.name;
    lines.push(`  porter:hasAgentRef [ porter:agentRef "${ref}" ; porter:assignedRole "${a.role}" ] ;`);
  }
  // Replace trailing " ;" on the last triple with " ."
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, " .");
  return lines.join("\n");
}

/**
 * Start the UI server.
 */
export async function startUiServer(
  options?: UiServerOptions,
): Promise<Deno.HttpServer> {
  const port = options?.port ?? 3000;
  const busUrl =
    options?.busUrl ?? Deno.env.get("PORTER_BUS_URL") ?? "ws://localhost:8787";

  // Single-user mode: skip OIDC entirely (the router handles auth)
  const singleUser = options?.singleUser ?? (Deno.env.get("PORTER_SINGLE_USER") === "true");

  // Initialize auth if OIDC is configured (unless single-user mode)
  const oidcConfig = singleUser ? null : (options?.oidcConfig ?? loadOidcConfig());
  let oidcDiscovery: OidcDiscovery | null = null;
  const credentialStore = new CredentialStore();
  const userStore = new UserStore();

  // Always initialize session key (needed for credential encryption even without OIDC)
  await initSessionKey();

  // Initialize ActivityPub if configured
  let apRouteHandler: ((req: Request, url: URL, pathname: string) => Promise<Response | null>) | null = null;
  const apWanted = options?.activityPubConfig?.enabled || Deno.env.get("PORTER_AP_ENABLED") === "true";
  if (apWanted) {
    const { handleActivityPubRoutes } = await import("../activitypub/routes.ts");
    const { LocalFederationStore } = await import("../activitypub/store.ts");
    const { resolveApConfig } = await import("../activitypub/config.ts");
    const apConfig = resolveApConfig(options?.activityPubConfig);
    if (apConfig) {
      const apStore = new LocalFederationStore();
      const { StandaloneBackend } = await import("../activitypub/backend.ts");
      const apBackend = options?.sessionManager
        ? new StandaloneBackend(options.sessionManager as unknown as import("../activitypub/backend.ts").SessionManagerLike, userStore)
        : null;
      apRouteHandler = (req, url, pathname) =>
        handleActivityPubRoutes(req, url, pathname, {
          config: apConfig,
          store: apStore,
          backend: apBackend!,
          userStore,
          resolveUserId: async (r) => await resolveUserId(r),
        });
      console.error(`[porter] ActivityPub enabled: ${apConfig.domain}`);
    }
  }

  // Auto-detect local AI providers (cached for all subsequent requests)
  let _autoDetect: typeof import("../auth/model_autodetect.ts") | null = null;
  try {
    _autoDetect = await import("../auth/model_autodetect.ts");
    const detected = _autoDetect.detectModels();
    if (detected.length > 0) {
      console.error(`[porter] Auto-detected models: ${detected.map(m => `${m.display_name} (${m.provider_type})`).join(", ")}`);
    }
  } catch { /* model autodetect not available */ }

  if (singleUser) {
    console.error("[porter] Running in single-user mode (OIDC disabled, router handles auth)");
  } else if (oidcConfig) {
    try {
      oidcDiscovery = await discover(oidcConfig.issuer_url);
      console.error(`[porter] OIDC enabled: ${oidcConfig.issuer_url}`);
    } catch (err) {
      console.error(`[porter] OIDC init failed (auth disabled): ${(err as Error).message}`);
    }
  }

  const isSecure = (oidcConfig?.redirect_uri ?? "").startsWith("https://");

  /**
   * Resolve a user ID for storage from the request.
   * Priority: OIDC auth (sub) > X-Porter-Email header > "default".
   * When OIDC user has an email that matches an email-keyed store,
   * migrate data automatically (account linking).
   */
  async function resolveUserId(req: Request): Promise<string> {
    const user = await extractUser(req, oidcDiscovery?.jwks_uri, oidcDiscovery?.issuer);
    if (user) {
      // Account linking: if there's email-keyed data, migrate it
      if (user.email) {
        const emailKey = `email:${user.email}`;
        const emailCreds = await credentialStore.list(emailKey);
        if (emailCreds.length > 0) {
          // Migrate credentials from email-keyed storage to sub-keyed storage
          for (const cred of emailCreds) {
            await credentialStore.add(user.sub, {
              name: cred.name,
              token_type: cred.token_type,
              api_key: "", // Can't read encrypted key — user will re-enter
              models: cred.models,
            });
          }
          console.error(`[porter] Migrated ${emailCreds.length} credentials from ${emailKey} to ${user.sub}`);
        }
      }
      return user.sub;
    }

    // Solid WebID
    const webId = req.headers.get("x-porter-webid");
    if (webId && webId.startsWith("http")) {
      return `webid:${webId}`;
    }

    const email = req.headers.get("x-porter-email");
    if (email && email.includes("@")) {
      return `email:${email}`;
    }

    return "default";
  }

  /**
   * Inject credentials from the user's store into a PorterConfig before launch.
   * Builds the providers[] array from stored model credentials so agents
   * can authenticate with model APIs.
   */
  async function injectCredentials(config: Record<string, unknown>, userId: string): Promise<void> {
    const { ModelStore } = await import("../auth/model_store.ts");
    const modelStore = new ModelStore();
    const autoDetected = _autoDetect?.detectModels() ?? [];

    const modelIds = new Set<string>();
    if (config.model) modelIds.add(config.model as string);
    for (const agent of (config.agents as { model?: string }[]) || []) {
      if (agent.model) modelIds.add(agent.model);
    }

    const providers: Record<string, unknown>[] = [];
    for (const modelId of modelIds) {
      const modelConfig = await modelStore.resolve(userId, modelId);
      const resolved = await credentialStore.resolve(userId, modelId);
      const autoModel = autoDetected.find(m => m.id === modelId);

      if (!modelConfig && !resolved && !autoModel) continue;

      const providerConfig: Record<string, unknown> = {
        type: modelConfig?.provider_type ?? autoModel?.provider_type ?? "openai_compat",
        base_url: resolved?.base_url ?? modelConfig?.base_url ?? autoModel?.base_url ?? "",
        api_key: resolved?.api_key,
        api_key_env: modelConfig?.api_key_env ?? autoModel?.api_key_env,
        auth: modelConfig?.auth ?? autoModel?.auth ?? "bearer",
        chat_endpoint: modelConfig?.chat_endpoint,
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
      console.error(`[porter] injectCredentials: ${providers.length} provider(s) — ${providers.map(p => `${p.type}@${p.base_url}`).join(', ')}`);
    } else {
      console.error(`[porter] injectCredentials: no providers resolved for models: ${[...modelIds].join(', ')}`);
    }
  }

  /**
   * Check whether the authenticated user owns a session.
   * Returns null if access is allowed (user owns the session, session has no
   * owner, or auth is not configured). Returns a 403 Response if access is denied.
   *
   * When auth is not active (no OIDC configured, local dev mode), ownership
   * checks are skipped entirely for backwards compatibility.
   */
  async function checkSessionOwnership(
    req: Request,
    sessionName: string,
    sm: SessionManager,
  ): Promise<Response | null> {
    // Skip ownership checks when auth is not configured (local mode)
    if (!oidcDiscovery) return null;

    const userId = await resolveUserId(req);
    // "default" means no authenticated user — skip enforcement for backwards compat
    if (userId === "default") return null;

    try {
      sm.assertOwner(sessionName, userId);
      return null;
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const server = Deno.serve({ port, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    let pathname = url.pathname;

    if (pathname === "/") pathname = "/index.html";

    // WebSocket proxy — relay browser connections to the bus
    if (pathname === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      // Determine which bus to connect to — session-aware routing
      const sessionName = url.searchParams.get("session");
      let targetBusUrl = busUrl; // default (standalone / single-session mode)
      if (sessionName && options?.sessionManager) {
        // Ownership check for WebSocket connections
        if (oidcDiscovery) {
          const wsUserId = await resolveUserId(req);
          if (wsUserId !== "default") {
            try {
              options.sessionManager.assertOwner(sessionName, wsUserId);
            } catch {
              // Accept the WebSocket upgrade but immediately close with 4403
              const { socket: deniedSocket, response: deniedResponse } = Deno.upgradeWebSocket(req);
              deniedSocket.onopen = () => {
                deniedSocket.close(4403, "Access denied");
              };
              return deniedResponse;
            }
          }
        }

        const session = options.sessionManager.getSession(sessionName);
        if (session) {
          targetBusUrl = `ws://localhost:${session.busPort}`;
        }
      }

      // Lobby mode: serve mode with no ?session= param.
      // Accept the WebSocket but don't proxy to any backend bus — this
      // prevents an infinite reconnect loop when no sessions exist yet.
      // The browser stays "connected" and will reconnect with ?session=<name>
      // once the user creates or selects a session.
      if (options?.sessionManager && !sessionName) {
        const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
        clientSocket.onopen = () => {
          // Send an empty roster so the UI shows the empty state correctly
          clientSocket.send(JSON.stringify({
            type: "publish",
            channel: "activity",
            content: JSON.stringify({ event: "roster", agents: [] }),
            from: "porter",
            timestamp: Date.now(),
          }));
        };
        // Respond to heartbeats to keep the connection alive; ignore all else
        clientSocket.onmessage = (evt) => {
          try {
            const msg = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data));
            if (msg.type === "heartbeat" && clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now() }));
            }
          } catch { /* ignore non-JSON and unknown message types */ }
        };
        return response;
      }

      // Normal proxy path — standalone mode or session explicitly specified
      const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

      // Connect to the backend bus
      let busSocket: WebSocket | null = null;
      const pendingMessages: string[] = [];

      clientSocket.onopen = () => {
        busSocket = new WebSocket(targetBusUrl);

        busSocket.onopen = () => {
          // Flush any messages the browser sent while we were connecting
          for (const msg of pendingMessages) {
            busSocket!.send(msg);
          }
          pendingMessages.length = 0;
        };

        busSocket.onmessage = (evt) => {
          // Relay bus messages to the browser
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(evt.data);
          }
        };

        busSocket.onclose = () => {
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.close();
          }
        };

        busSocket.onerror = () => {
          pendingMessages.length = 0;
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.close();
          }
        };
      };

      clientSocket.onmessage = (evt) => {
        // Relay browser messages to the bus
        if (busSocket?.readyState === WebSocket.OPEN) {
          busSocket.send(typeof evt.data === "string" ? evt.data : String(evt.data));
        } else {
          // Buffer messages until the bus connection is ready
          pendingMessages.push(typeof evt.data === "string" ? evt.data : String(evt.data));
        }
      };

      clientSocket.onclose = () => {
        if (busSocket) {
          busSocket.close();
        }
      };

      clientSocket.onerror = () => {
        if (busSocket) {
          busSocket.close();
        }
      };

      return response;
    }

    // Health check for Kubernetes liveness/readiness probes
    if (pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // --- MCP endpoint (Streamable HTTP) ---

    if (pathname === "/mcp" && req.method === "POST") {
      // Authenticate via Bearer token, session cookie, or email header
      let mcpUser = await extractUser(req, oidcDiscovery?.jwks_uri, oidcDiscovery?.issuer);

      // Fallback: resolve identity from email header (same as REST API)
      if (!mcpUser) {
        const email = req.headers.get("x-porter-email");
        if (email && email.includes("@")) {
          mcpUser = { sub: `email:${email}`, username: email, email, roles: [] };
        }
      }

      // Fallback: Porter-issued HS256 token (from /auth/token)
      if (!mcpUser) {
        const authH = req.headers.get("authorization");
        if (authH?.startsWith("Bearer ")) {
          const tok = authH.slice(7);
          try {
            const parts = tok.split(".");
            if (parts.length === 3) {
              const { base64UrlDecode: b64d, getRawSessionKey } = await import("../auth/session.ts");
              const hdr = JSON.parse(new TextDecoder().decode(b64d(parts[0])));
              if (hdr.alg === "HS256") {
                const hmacKey = await crypto.subtle.importKey(
                  "raw",
                  getRawSessionKey().buffer as ArrayBuffer,
                  { name: "HMAC", hash: "SHA-256" },
                  false,
                  ["verify"],
                );
                const sigBytes = b64d(parts[2]);
                const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
                const valid = await crypto.subtle.verify(
                  "HMAC",
                  hmacKey,
                  sigBytes.buffer as ArrayBuffer,
                  dataBytes.buffer as ArrayBuffer,
                );
                if (valid) {
                  const claims = JSON.parse(new TextDecoder().decode(b64d(parts[1])));
                  if (claims.iss === "porter" && claims.exp > Math.floor(Date.now() / 1000)) {
                    mcpUser = {
                      sub: claims.sub,
                      username: claims.username,
                      email: claims.email,
                      name: claims.name,
                      roles: [],
                    };
                  }
                }
              }
            }
          } catch { /* invalid token format — continue to next fallback */ }
        }
      }

      // Fallback: if session cookie exists in the request, use it
      if (!mcpUser) {
        const session = await readSession(req);
        if (session) {
          mcpUser = {
            sub: session.sub,
            username: session.username,
            email: session.email,
            name: session.name,
            roles: [],
          };
        }
      }

      const mcpServer = new PorterMcpServer({
        sessionManager: options?.sessionManager,
        user: mcpUser ?? undefined,
      });

      try {
        const body = await req.json();
        const response = await mcpServer.handleRequest(body);
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (pathname === "/mcp" && req.method === "GET") {
      // Discovery hint — tell clients this is an MCP endpoint requiring auth
      return new Response(
        JSON.stringify({
          name: "porter",
          version: "0.1.0",
          description: "Porter agent orchestration MCP server",
          authentication: oidcConfig
            ? { type: "oauth2", issuer: oidcConfig.issuer_url }
            : { type: "none" },
        }),
        {
          status: oidcConfig ? 401 : 200,
          headers: {
            "Content-Type": "application/json",
            ...(oidcConfig
              ? { "WWW-Authenticate": `Bearer realm="porter"` }
              : {}),
          },
        },
      );
    }

    // --- ActivityPub federation routes ---
    if (apRouteHandler) {
      const apResponse = await apRouteHandler(req, url, pathname);
      if (apResponse) return apResponse;
    }

    if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      if (!oidcConfig || !oidcDiscovery) {
        return new Response("OIDC not configured", { status: 404 });
      }
      const fwdProto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
      const fwdHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
      const selfOrigin = `${fwdProto}://${fwdHost}`;
      return new Response(JSON.stringify({
        issuer: selfOrigin,
        authorization_endpoint: `${selfOrigin}/authorize`,
        token_endpoint: `${selfOrigin}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- OAuth authorize proxy (for MCP/CLI clients) ---
    // Proxies authorize requests to Keycloak, injecting Porter's client_id.
    if (pathname === "/authorize" && req.method === "GET" && oidcConfig && oidcDiscovery) {
      const keycloakUrl = new URL(oidcDiscovery.authorization_endpoint);
      for (const [key, value] of url.searchParams) {
        keycloakUrl.searchParams.set(key, value);
      }
      keycloakUrl.searchParams.set("client_id", oidcConfig.client_id);
      return new Response(null, {
        status: 302,
        headers: { "Location": keycloakUrl.toString() },
      });
    }

    // --- OAuth token proxy (for MCP/CLI clients) ---
    // Claude Code and other MCP clients send auth codes here.
    // Porter injects the client_secret and forwards to Keycloak.
    if (pathname === "/oauth/token") {
      if (req.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "invalid_request", error_description: "POST required" }),
          { status: 405, headers: { "Content-Type": "application/json", "Allow": "POST" } },
        );
      }
      if (!oidcConfig || !oidcDiscovery) {
        return new Response(
          JSON.stringify({ error: "server_error", error_description: "OIDC not configured" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      try {
        const body = await req.text();
        const params = new URLSearchParams(body);

        if (oidcConfig.client_secret) {
          params.set("client_secret", oidcConfig.client_secret);
        }
        params.set("client_id", oidcConfig.client_id);

        const tokenResp = await fetch(oidcDiscovery.token_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "porter-auth/0.1",
          },
          body: params.toString(),
        });

        const tokenBody = await tokenResp.text();
        return new Response(tokenBody, {
          status: tokenResp.status,
          headers: {
            "Content-Type": tokenResp.headers.get("Content-Type") || "application/json",
          },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "token_proxy_error", error_description: (err as Error).message }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // --- Solid MCP login callback ---

    if (pathname === "/api/solid-mcp-auth/callback" && req.method === "GET") {
      const { pendingMcpAuths } = await import("../mcp/mcp_server.ts");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error || !code || !state) {
        return new Response(`<html><body><p>Authentication failed: ${error || "missing parameters"}</p></body></html>`, {
          headers: { "Content-Type": "text/html" },
        });
      }

      const pending = pendingMcpAuths.get(state);
      if (!pending) {
        return new Response("<html><body><p>Auth session expired. Please try again.</p></body></html>", {
          headers: { "Content-Type": "text/html" },
        });
      }

      try {
        const discUrl = `${pending.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
        const discResp = await fetch(discUrl);
        const disc = await discResp.json();

        const tokenParams = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: pending.redirectUri,
          client_id: pending.redirectUri,
          code_verifier: pending.codeVerifier,
        });

        const tokenResp = await fetch(disc.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        });

        if (!tokenResp.ok) {
          const body = await tokenResp.text();
          throw new Error(`Token exchange failed: ${tokenResp.status} ${body.slice(0, 200)}`);
        }

        const tokens = await tokenResp.json();
        let webId = "";
        if (tokens.id_token) {
          try {
            const payload = tokens.id_token.split(".")[1];
            const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
            webId = decoded.webid || decoded.sub || "";
          } catch { /* ignore */ }
        }

        pending.result = { accessToken: tokens.access_token, webId };

        return new Response("<html><body><p>Authenticated successfully. You can close this tab and return to your IDE.</p></body></html>", {
          headers: { "Content-Type": "text/html" },
        });
      } catch (err) {
        return new Response(`<html><body><p>Authentication error: ${(err as Error).message}</p></body></html>`, {
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    // --- MCP server OIDC auth ---

    if (pathname === "/api/mcp-auth/login" && req.method === "GET") {
      const serverName = url.searchParams.get("server");
      if (!serverName) {
        return new Response("Missing server parameter", { status: 400 });
      }

      const issuerUrl = url.searchParams.get("issuer") || oidcConfig?.issuer_url;
      if (!issuerUrl) {
        return new Response("No OIDC issuer configured", { status: 501 });
      }

      try {
        const disc = await discoverOAuthAS(issuerUrl);
        const fwdProto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
        const fwdHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
        const redirectUri = `${fwdProto}://${fwdHost}/api/mcp-auth/callback`;

        // Encode server name + issuer into the CSRF redirect field so
        // the callback can discover the right token endpoint.
        const csrfPayload = JSON.stringify({ server: serverName, issuer: issuerUrl });
        const { state, codeVerifier, cookie: csrfCookie } = await generateCsrf(
          csrfPayload,
          isSecure,
          "/api/mcp-auth",
        );
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        // Build auth URL — use a minimal client_id for public-client flows
        // (OAuth AS like RHOmnibus expects "none" auth, so no secret needed)
        const clientId = oidcConfig?.client_id ?? "porter";
        const authUrl = buildAuthUrl(disc, {
          issuer_url: issuerUrl,
          client_id: clientId,
          redirect_uri: redirectUri,
        }, state, codeChallenge);

        return new Response(null, {
          status: 302,
          headers: {
            "Location": authUrl,
            "Set-Cookie": csrfCookie,
          },
        });
      } catch (err) {
        return new Response(`OAuth discovery failed: ${(err as Error).message}`, { status: 502 });
      }
    }

    if (pathname === "/api/mcp-auth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        return new Response(mcpAuthResultPage(null, desc), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (!code || !state) {
        return new Response(mcpAuthResultPage(null, "Missing code or state"), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      const csrf = await validateCsrf(req, state);
      if (!csrf) {
        return new Response(mcpAuthResultPage(null, "Invalid CSRF token"), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      let serverName: string;
      let issuerUrl: string;
      try {
        const payload = JSON.parse(csrf.redirect_to);
        serverName = payload.server;
        issuerUrl = payload.issuer;
      } catch {
        serverName = csrf.redirect_to;
        issuerUrl = oidcConfig?.issuer_url ?? "";
      }

      try {
        const disc = await discoverOAuthAS(issuerUrl);
        const fwdProto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
        const fwdHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
        const redirectUri = `${fwdProto}://${fwdHost}/api/mcp-auth/callback`;
        const clientId = oidcConfig?.client_id ?? "porter";

        // Exchange code at the MCP server's token endpoint (or Keycloak's via proxy)
        const mcpConfig: OidcConfig = {
          issuer_url: issuerUrl,
          client_id: clientId,
          redirect_uri: redirectUri,
        };
        const tokens = await exchangeCode(disc, mcpConfig, code, csrf.code_verifier);

        return new Response(mcpAuthResultPage({
          server: serverName,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
        }), {
          status: 200,
          headers: [
            ["Content-Type", "text/html"],
            ["Set-Cookie", clearCsrfCookie(isSecure, "/api/mcp-auth")],
          ],
        });
      } catch (err) {
        return new Response(mcpAuthResultPage(null, (err as Error).message), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    // --- Auth routes ---

    if (pathname === "/auth/login" && req.method === "GET" && oidcConfig && oidcDiscovery) {
      const { state, codeVerifier, cookie: csrfCookie } = await generateCsrf(
        url.searchParams.get("redirect") ?? "/",
        isSecure,
      );
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const authUrl = buildAuthUrl(oidcDiscovery, oidcConfig, state, codeChallenge);
      return new Response(null, {
        status: 302,
        headers: {
          "Location": authUrl,
          "Set-Cookie": csrfCookie,
        },
      });
    }

    if (pathname === "/auth/callback" && req.method === "GET" && oidcConfig && oidcDiscovery) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        return new Response(`Authentication error: ${desc}`, { status: 400 });
      }

      if (!code || !state) {
        return new Response("Missing code or state parameter", { status: 400 });
      }

      const csrf = await validateCsrf(req, state);
      if (!csrf) {
        return new Response("Invalid CSRF token", { status: 403 });
      }

      try {
        const tokens = await exchangeCode(oidcDiscovery, oidcConfig, code, csrf.code_verifier);

        // Decode ID token claims (we trust it since we just got it from the IdP)
        let claims: Record<string, unknown> = {};
        if (tokens.id_token) {
          const payload = tokens.id_token.split(".")[1];
          const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
          claims = JSON.parse(decoded);
        }

        const now = new Date();
        const sessionCookie = await createSessionCookie({
          sub: (claims.sub as string) ?? "",
          username: (claims.preferred_username as string) ?? "unknown",
          email: claims.email as string | undefined,
          name: claims.name as string | undefined,
          id_token: tokens.id_token,
          issued_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 86400_000).toISOString(),
        }, isSecure);

        return new Response(null, {
          status: 302,
          headers: [
            ["Location", csrf.redirect_to],
            ["Set-Cookie", sessionCookie],
            ["Set-Cookie", clearCsrfCookie(isSecure)],
          ],
        });
      } catch (err) {
        return new Response(`Token exchange failed: ${(err as Error).message}`, { status: 500 });
      }
    }

    if (pathname === "/auth/logout" && req.method === "GET") {
      const session = await readSession(req);
      const headers: [string, string][] = [
        ["Set-Cookie", clearSessionCookie(isSecure)],
      ];

      if (oidcDiscovery?.end_session_endpoint) {
        const fwdProto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
        const fwdHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
        const postLogoutUri = `${fwdProto}://${fwdHost}/`;
        const params = new URLSearchParams({
          post_logout_redirect_uri: postLogoutUri,
          client_id: oidcConfig?.client_id ?? "",
        });
        if (session?.id_token) {
          params.set("id_token_hint", session.id_token as string);
        }
        headers.push(["Location", `${oidcDiscovery.end_session_endpoint}?${params}`]);
        return new Response(null, { status: 302, headers });
      }

      headers.push(["Location", "/"]);
      return new Response(null, { status: 302, headers });
    }

    if (pathname === "/auth/me" && req.method === "GET") {
      const session = await readSession(req);
      if (!session) {
        return new Response(
          JSON.stringify({ authenticated: false, oidc_configured: !!oidcDiscovery }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      const { sub, username, email, name, id_token } = session;
      const lwsBase = Deno.env.get("PORTER_LWS_BASE_URL");
      const lwsBaseNorm = lwsBase?.replace(/\/+$/, "");
      const podUrl = lwsBaseNorm ? `${lwsBaseNorm}/${encodeURIComponent(sub)}/` : undefined;
      return new Response(
        JSON.stringify({
          authenticated: true,
          oidc_configured: !!oidcDiscovery,
          user: { sub, username, email, name },
          pod_url: podUrl,
          lws_token_endpoint: podUrl ? "/auth/lws-token" : undefined,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // --- LWS token exchange (server-side proxy to avoid CORS) ---
    if (pathname === "/auth/lws-token" && req.method === "POST") {
      const session = await readSession(req);
      if (!session?.id_token) {
        return new Response(JSON.stringify({ error: "Not authenticated" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      const lwsBase = Deno.env.get("PORTER_LWS_BASE_URL")?.replace(/\/+$/, "");
      if (!lwsBase) {
        return new Response(JSON.stringify({ error: "LWS not configured" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const { getHttpClient } = await import("../providers/types.ts");
        const tokenResp = await fetch(`${lwsBase}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: session.id_token,
            subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          }),
          client: getHttpClient(),
        });
        const data = await tokenResp.text();
        return new Response(data, {
          status: tokenResp.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 502, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- API token for MCP/CLI clients ---
    // Authenticated users can get a Bearer token for use with the MCP endpoint.
    // This avoids the need for CLI clients to complete a full OAuth flow.
    if (pathname === "/auth/token" && req.method === "GET") {
      const session = await readSession(req);
      if (!session) {
        return new Response(
          JSON.stringify({ error: "Login via SSO first" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      // Create a self-signed JWT-like token using the session key
      const { base64UrlEncode: b64, getRawSessionKey } = await import("../auth/session.ts");
      const payload = JSON.stringify({
        sub: session.sub,
        username: session.username,
        email: session.email,
        name: session.name,
        iss: "porter",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 86400,
      });
      const key = await crypto.subtle.importKey(
        "raw",
        getRawSessionKey().buffer as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const headerB64 = b64(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
      const payloadB64 = b64(new TextEncoder().encode(payload));
      const signature = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${headerB64}.${payloadB64}`)),
      );
      const token = `${headerB64}.${payloadB64}.${b64(signature)}`;
      return new Response(
        JSON.stringify({ token, expires_in: 86400 }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Credential API endpoints (auth required) ---

    if (pathname === "/api/credentials" && req.method === "GET") {
      const userId = await resolveUserId(req);
      const creds = await credentialStore.list(userId);
      return new Response(JSON.stringify({ credentials: creds }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/api/credentials" && req.method === "POST") {
      const userId = await resolveUserId(req);
      try {
        const body = await req.json();
        await credentialStore.add(userId, body);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    const credDeleteMatch = pathname.match(/^\/api\/credentials\/([^/]+)$/);
    if (credDeleteMatch && req.method === "DELETE") {
      const userId = await resolveUserId(req);
      const name = decodeURIComponent(credDeleteMatch[1]);
      const removed = await credentialStore.remove(userId, name);
      return new Response(JSON.stringify({ ok: removed }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/api/credentials/check" && req.method === "GET") {
      const userId = await resolveUserId(req);
      const expiry = await credentialStore.checkExpiry(userId);
      return new Response(JSON.stringify({ credentials: expiry }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Dynamic tool API endpoints ---

    const toolsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tools$/);
    if (toolsMatch && req.method === "GET") {
      // List tools — no auth required (read-only info)
      const sessionName = decodeURIComponent(toolsMatch[1]);
      if (options?.sessionManager) {
        const session = options.sessionManager.getSession(sessionName);
        if (!session) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
      }
      // Tool listing is not yet available at runtime — return placeholder
      return new Response(JSON.stringify({ tools: [], note: "Runtime tool listing not yet implemented" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (toolsMatch && req.method === "POST") {
      // Add a tool dynamically — publishes a bus control message
      const user = await extractUser(req, oidcDiscovery?.jwks_uri, oidcDiscovery?.issuer);
      if (!user) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const body = await req.json();
        if (!body.name || !body.definition) {
          return new Response(JSON.stringify({ error: "name and definition are required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const sessionName = decodeURIComponent(toolsMatch[1]);
        if (options?.sessionManager) {
          const session = options.sessionManager.getSession(sessionName);
          if (!session) {
            return new Response(JSON.stringify({ error: "Session not found" }), {
              status: 404, headers: { "Content-Type": "application/json" },
            });
          }
          // TODO: publish to the session's bus once we have access to it
        }
        return new Response(JSON.stringify({ ok: true, action: "add_tool", tool: body.name, agent: body.agent ?? "*" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    const toolDeleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tools\/([^/]+)$/);
    if (toolDeleteMatch && req.method === "DELETE") {
      const user = await extractUser(req, oidcDiscovery?.jwks_uri, oidcDiscovery?.issuer);
      if (!user) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      const sessionName = decodeURIComponent(toolDeleteMatch[1]);
      const toolName = decodeURIComponent(toolDeleteMatch[2]);
      // TODO: publish remove_tool control message to the session's bus
      return new Response(JSON.stringify({ ok: true, action: "remove_tool", tool: toolName, session: sessionName }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Model CRUD, validation, and availability endpoints ---

    if (pathname === "/api/models" && req.method === "GET") {
      const userId = await resolveUserId(req);
      try {
        const { ModelStore: MS } = await import("../auth/model_store.ts");
        const ms = new MS();
        const userModels = await ms.list(userId);
        const models = _autoDetect ? _autoDetect.mergeWithDetected(userModels, _autoDetect.detectModels()) : userModels;
        return new Response(JSON.stringify({ models }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ models: [], error: (err as Error).message }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (pathname === "/api/models" && req.method === "POST") {
      const userId = await resolveUserId(req);
      try {
        const body = await req.json();
        const { ModelStore: MS } = await import("../auth/model_store.ts");
        const ms = new MS();
        await ms.save(userId, body.models || []);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (pathname === "/api/models/validate" && req.method === "POST") {
      try {
        const body = await req.json();
        const { model_id, base_url, api_key, provider_type, auth, chat_endpoint } = body;
        if (!model_id || !base_url) {
          return new Response(JSON.stringify({ ok: false, error: "model_id and base_url are required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        if (!api_key && auth !== "adc") {
          return new Response(JSON.stringify({ ok: false, error: "api_key is required (unless auth is 'adc')" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }

        const { createProvider: makeProvider } = await import("../providers/mod.ts");
        const type = provider_type || "openai_compat";

        let resolvedKey = api_key;
        const looksLikeEnvVar = typeof api_key === "string" && /^[A-Z][A-Z0-9_]*$/.test(api_key);
        if (typeof api_key === "string") {
          if (api_key.startsWith("env:")) {
            resolvedKey = Deno.env.get(api_key.slice(4)) ?? "";
          } else if (looksLikeEnvVar) {
            const fromEnv = Deno.env.get(api_key);
            if (fromEnv) resolvedKey = fromEnv;
          }
        }
        // Fall back to user's credential store if we still have an env var name (not a raw key)
        if (!resolvedKey || (looksLikeEnvVar && resolvedKey === api_key)) {
          const userId = await resolveUserId(req);
          const { CredentialStore } = await import("../auth/credentials.ts");
          const store = new CredentialStore();
          const cred = await store.resolve(userId, model_id)
            ?? await store.resolveByName(userId, api_key)
            ?? await store.resolveByBaseUrl(userId, base_url);
          if (cred?.api_key) resolvedKey = cred.api_key;
        }

        try {
          const provider = makeProvider({ type, base_url, api_key: resolvedKey, auth, chat_endpoint, models: [model_id] });
          await provider.createMessage({
            model: model_id,
            max_tokens: 7,
            system: "Reply with OK.",
            messages: [{ role: "user", content: "Say hello" }],
          });
          return new Response(JSON.stringify({ ok: true, model_id }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, model_id, error: (err as Error).message }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (pathname === "/api/models/available" && req.method === "GET") {
      const userId = await resolveUserId(req);
      try {
        const { ModelStore: MS } = await import("../auth/model_store.ts");
        const ms = new MS();
        const userModels = _autoDetect ? _autoDetect.mergeWithDetected(await ms.list(userId), _autoDetect.detectModels()) : await ms.list(userId);
        const models = userModels.map(m => ({
          model_id: m.id,
          base_url: m.base_url,
          status: "valid",
          display_name: m.display_name,
          capabilities: m.capabilities,
          context_window: m.context_window,
          max_tokens: m.max_tokens,
          provider_type: m.provider_type,
        }));
        return new Response(JSON.stringify({ models }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ models: [], error: (err as Error).message }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- Session config and edit endpoints ---

    // --- Session metrics endpoint ---
    const metricsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/metrics$/);
    if (metricsMatch && req.method === "GET") {
      const sessionName = decodeURIComponent(metricsMatch[1]);
      if (!options?.sessionManager) {
        return new Response(JSON.stringify({ error: "Session management not available" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
      if (ownerErr) return ownerErr;
      const session = options.sessionManager.getSession(sessionName);
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(session.porter.metrics.getMetrics()), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Workspace sync endpoint ---
    const syncMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/sync-workspace$/);
    if (syncMatch && req.method === "POST") {
      const sessionName = decodeURIComponent(syncMatch[1]);
      if (!options?.sessionManager) {
        return new Response(JSON.stringify({ error: "Session management not available" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
      if (ownerErr) return ownerErr;
      const session = options.sessionManager.getSession(sessionName);
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const body = await req.json();
        const destination = body.destination as string;
        if (!destination) {
          return new Response(JSON.stringify({ error: "destination is required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        // deno-lint-ignore no-explicit-any
        const srcDir = (session.porter as any).metrics.getMetrics().workingDir as string | undefined;
        if (!srcDir) {
          return new Response(JSON.stringify({ error: "No workspace directory" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const { copy } = await import("@std/fs/copy");
        await copy(srcDir, destination, { overwrite: true });
        let fileCount = 0;
        for await (const entry of Deno.readDir(destination)) {
          if (entry.isFile) fileCount++;
        }
        return new Response(JSON.stringify({ ok: true, files: fileCount, source: srcDir, destination }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- Open workspace in file manager ---
    const openWsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/open-workspace$/);
    if (openWsMatch && req.method === "POST") {
      const sessionName = decodeURIComponent(openWsMatch[1]);
      if (!options?.sessionManager) {
        return new Response(JSON.stringify({ error: "Session management not available" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      const session = options.sessionManager.getSession(sessionName);
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }
      // deno-lint-ignore no-explicit-any
      const dir = (session.porter as any).metrics.getMetrics().workingDir as string | undefined;
      if (!dir) {
        return new Response(JSON.stringify({ error: "No workspace directory" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const cmd = new Deno.Command("xdg-open", { args: [dir], stdout: "null", stderr: "null" });
        cmd.spawn();
        return new Response(JSON.stringify({ ok: true, dir }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({ error: "Could not open folder" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- Session memory graph export/import ---
    const memoryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/memory$/);
    if (memoryMatch && req.method === "GET") {
      const sessionName = decodeURIComponent(memoryMatch[1]);
      if (!options?.sessionManager) {
        return new Response("", { headers: { "Content-Type": "text/turtle" } });
      }
      const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
      if (ownerErr) return ownerErr;
      const session = options.sessionManager.getSession(sessionName);
      if (session) {
        const { getGraphStore: getGS } = await import("../graph/store.ts");
        const { GRAPHS } = await import("../graph/vocabulary.ts");
        const store = getGS();
        const turtle = store ? store.dump(GRAPHS.memory) : "";
        return new Response(turtle, { headers: { "Content-Type": "text/turtle" } });
      }
      // Not running — try loading from snapshot
      try {
        const { loadSnapshot: loadSnap, snapshotPath: snapP } = await import("../runtime/snapshot.ts");
        const snap = await loadSnap(snapP(sessionName));
        return new Response(snap.memoryTurtle ?? "", { headers: { "Content-Type": "text/turtle" } });
      } catch {
        return new Response("", { headers: { "Content-Type": "text/turtle" } });
      }
    }

    if (memoryMatch && req.method === "POST") {
      const sessionName = decodeURIComponent(memoryMatch[1]);
      if (!options?.sessionManager) {
        return new Response(JSON.stringify({ error: "Session management not available" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
      if (ownerErr) return ownerErr;
      const session = options.sessionManager.getSession(sessionName);
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not running" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }
      const turtle = await req.text();
      if (!turtle.trim()) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const { getGraphStore: getGS } = await import("../graph/store.ts");
      const { GRAPHS } = await import("../graph/vocabulary.ts");
      const store = getGS();
      if (!store) {
        return new Response(JSON.stringify({ error: "Graph store not initialized" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      try {
        store.load(turtle, GRAPHS.memory);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- Session message history endpoint ---
    const historyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (historyMatch && req.method === "GET") {
      const sessionName = decodeURIComponent(historyMatch[1]);
      const limit = parseInt(url.searchParams.get("limit") ?? "500");
      if (!options?.sessionManager) {
        return new Response(JSON.stringify({ error: "Session management not available" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
      if (ownerErr) return ownerErr;
      const session = options.sessionManager.getSession(sessionName);
      if (!session) {
        // Session not running — try loading from persisted store
        const { MessageStore: MsgStore } = await import("../orchestration/message_store.ts");
        const store = new MsgStore(sessionName);
        const messages = await store.load(limit);
        return new Response(JSON.stringify({ messages, source: "persisted" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const messages = await session.porter.messageStore.load(limit);
      return new Response(JSON.stringify({ messages, source: "live" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const configMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/config$/);
    if (configMatch && req.method === "GET") {
      const sessionName = decodeURIComponent(configMatch[1]);
      if (!options?.sessionManager) {
        return new Response(JSON.stringify({ error: "Session management not available" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
      if (ownerErr) return ownerErr;
      const session = options.sessionManager.getSession(sessionName);
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ config: session.config }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const editMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/edit$/);
    if (editMatch && req.method === "POST") {
      const sessionName = decodeURIComponent(editMatch[1]);
      if (!options?.sessionManager) {
        return new Response(JSON.stringify({ error: "Session management not available" }), {
          status: 501, headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
        if (ownerErr) return ownerErr;
        const body = await req.json();
        if (!body.config?.session || !body.config?.agents?.length) {
          return new Response(JSON.stringify({ error: "config.session and config.agents are required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        // Resolve credentials from user's store
        const editUserId = await resolveUserId(req);
        await injectCredentials(body.config, editUserId);

        // Ensure the new config uses the same session name (can't rename during edit)
        body.config.session = sessionName;
        const managed = await (options.sessionManager as any).editSession(sessionName, body.config);
        return new Response(JSON.stringify({
          ok: true,
          session: managed.name,
          busPort: managed.busPort,
        }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- Agent API endpoints ---

    if (pathname === "/api/agents" && req.method === "GET") {
      const userId = await resolveUserId(req);
      const agents = await userStore.listAgents(userId);
      return new Response(JSON.stringify({ agents }), { headers: { "Content-Type": "application/json" } });
    }

    if (pathname === "/api/agents" && req.method === "POST") {
      const userId = await resolveUserId(req);
      const body = await req.json();
      if (!body.name) {
        return new Response(JSON.stringify({ error: "name is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const agent = {
        name: body.name,
        role: body.role || "worker",
        model: body.model,
        system_prompt: body.system_prompt || body.systemPrompt || "",
        prompt_sections: body.prompt_sections || body.promptSections,
        tools: body.tools || [],
        channels: body.channels || body.subscribe || [],
        mcp_tools: body.mcp_tools || body.mcpTools || [],
        max_tokens: body.max_tokens || body.maxTokens || 8192,
        max_turns: body.max_turns || body.maxTurns || undefined,
        max_context_tokens: body.max_context_tokens || body.maxContextTokens || undefined,
        reasoning: body.reasoning || false,
        _context: body._context,
        visibility: body.visibility || "private",
        author: body.author,
        created_at: body.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await userStore.saveAgent(userId, agent);
      return new Response(JSON.stringify({ ok: true, agent: agent.name }), { headers: { "Content-Type": "application/json" } });
    }

    // POST /api/agents/import — import an agent from a remote URL
    if (pathname === "/api/agents/import" && req.method === "POST") {
      const userId = await resolveUserId(req);
      try {
        const body = await req.json();
        const importUrl = body.url as string;
        const mode = (body.mode as string) || "copy";

        if (!importUrl) {
          return new Response(JSON.stringify({ error: "Missing url" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }

        // Fetch the agent definition — accept both JSON-LD and Turtle
        const resp = await fetch(importUrl, {
          headers: { "Accept": "application/ld+json, application/json, text/turtle" },
        });
        if (!resp.ok) {
          return new Response(JSON.stringify({ error: `Failed to fetch: ${resp.status}` }), {
            status: 502, headers: { "Content-Type": "application/json" },
          });
        }

        const text = await resp.text();
        const contentType = resp.headers.get("content-type") || "";
        const isTurtle = contentType.includes("turtle") || importUrl.endsWith(".ttl");
        let agent: import("../auth/user_store.ts").SavedAgent | null = null;

        if (isTurtle) {
          const { turtleToAgent } = await import("../rdf/turtle.ts");
          agent = turtleToAgent(text);
        } else {
          try {
            const json = JSON.parse(text);
            agent = jsonLdToSavedAgent(json);
          } catch {
            // Maybe it's Turtle despite Content-Type
            const { turtleToAgent } = await import("../rdf/turtle.ts");
            agent = turtleToAgent(text);
          }
        }

        if (!agent) {
          return new Response(JSON.stringify({ error: "Invalid agent format" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }

        // Dry run: just check if agent exists, don't save
        if (body.dry_run) {
          const existing = await userStore.getAgent(userId, agent.name);
          return new Response(JSON.stringify({ exists: !!existing, agent: agent.name }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (mode === "link") {
          // Store as a linked reference — save the URL, mark as linked
          agent._context = "linked";
          agent.visibility = "linked";
          // Store source URI for re-fetching
          (agent as unknown as Record<string, unknown>).linked_from = importUrl;
        } else {
          // Copy mode — store derived-from provenance
          (agent as unknown as Record<string, unknown>).derived_from = importUrl;
        }

        await userStore.saveAgent(userId, agent);
        return new Response(JSON.stringify({ ok: true, agent: agent.name }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (pathname.startsWith("/api/agents/") && req.method === "GET") {
      const agentName = decodeURIComponent(pathname.slice("/api/agents/".length));
      const userId = await resolveUserId(req);
      const agent = await userStore.getAgent(userId, agentName);
      if (!agent) {
        return new Response(JSON.stringify({ error: "Agent not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }

      // Content negotiation
      const accept = req.headers.get("accept") || "";
      if (accept.includes("application/ld+json")) {
        const jsonld = agentToJsonLd(agent, userId);
        return new Response(JSON.stringify(jsonld, null, 2), {
          headers: { "Content-Type": "application/ld+json" },
        });
      }
      if (accept.includes("text/turtle")) {
        const turtle = agentToTurtle(agent, userId);
        return new Response(turtle, {
          headers: { "Content-Type": "text/turtle" },
        });
      }
      // Default: plain JSON (existing behavior)
      return new Response(JSON.stringify(agent), { headers: { "Content-Type": "application/json" } });
    }

    if (pathname.startsWith("/api/agents/") && req.method === "DELETE") {
      const agentName = decodeURIComponent(pathname.slice("/api/agents/".length));
      const userId = await resolveUserId(req);
      const ok = await userStore.deleteAgent(userId, agentName);
      return new Response(JSON.stringify({ ok }), { headers: { "Content-Type": "application/json" } });
    }

    // --- Pattern API endpoints ---

    if (pathname === "/api/patterns" && req.method === "GET") {
      const { listPatterns: listBuiltinPatterns } = await import("../orchestration/pattern_registry.ts");
      const builtinPatterns = listBuiltinPatterns();
      const userId = await resolveUserId(req);
      const userPatterns = await userStore.listPatterns(userId);
      // Merge: built-in first, then user patterns (user patterns with same id override)
      const merged = new Map<string, import("../orchestration/pattern_registry.ts").PatternDefinition>();
      for (const p of builtinPatterns) merged.set(p.id, p);
      for (const p of userPatterns) merged.set(p.id, p);
      return new Response(JSON.stringify({ patterns: [...merged.values()] }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/api/patterns" && req.method === "POST") {
      const userId = await resolveUserId(req);
      try {
        const body = await req.json();
        if (!body.id || !body.name || !body.roles) {
          return new Response(JSON.stringify({ error: "id, name, and roles are required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const pattern = body as import("../orchestration/pattern_registry.ts").PatternDefinition;
        pattern.builtin = false;
        await userStore.savePattern(userId, pattern);
        const { registerCustomPattern } = await import("../orchestration/pattern_registry.ts");
        registerCustomPattern(pattern);
        return new Response(JSON.stringify({ ok: true, pattern: pattern.id }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    const patternDeleteMatch = pathname.match(/^\/api\/patterns\/([^/]+)$/);
    if (patternDeleteMatch && req.method === "DELETE") {
      const patternId = decodeURIComponent(patternDeleteMatch[1]);
      // Only allow deleting non-builtin patterns
      const { getPattern: getBuiltinPattern, removePattern } = await import("../orchestration/pattern_registry.ts");
      const existing = getBuiltinPattern(patternId);
      if (existing?.builtin) {
        return new Response(JSON.stringify({ error: "Cannot delete a built-in pattern" }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
      }
      const userId = await resolveUserId(req);
      const deleted = await userStore.deletePattern(userId, patternId);
      removePattern(patternId);
      return new Response(JSON.stringify({ ok: deleted }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- ActivityPub config API (always available, even when AP is not enabled) ---

    if (pathname === "/api/activitypub/config" && req.method === "GET") {
      const defaultConfig = {
        enabled: false, domain: "", approval_mode: "allowlist",
        allowlist: [], public_summaries: false, max_sessions_per_follower: 1,
      };
      if (!apRouteHandler) {
        return new Response(JSON.stringify(defaultConfig), { headers: { "Content-Type": "application/json" } });
      }
      // Try MinIO first, then filesystem fallback
      try {
        const { ApS3Client } = await import("../activitypub/s3.ts");
        const s3Cfg = (await import("../activitypub/s3.ts")).loadS3Config();
          if (!s3Cfg) throw new Error("no S3");
          const s3 = new ApS3Client(s3Cfg);
        const text = await s3.getObject("ap-config.json");
        if (text) {
          return new Response(text, { headers: { "Content-Type": "application/json" } });
        }
      } catch { /* MinIO not available */ }
      const home = Deno.env.get("HOME") ?? Deno.cwd();
      try {
        const text = await Deno.readTextFile(`${home}/.porter/activitypub/config.json`);
        return new Response(text, { headers: { "Content-Type": "application/json" } });
      } catch {
        return new Response(JSON.stringify(defaultConfig), { headers: { "Content-Type": "application/json" } });
      }
    }

    if (pathname === "/api/activitypub/teams" && req.method === "GET") {
      const showAll = url.searchParams.get("all") === "true";
      if (showAll) {
        const { listAllPublished } = await import("../activitypub/registry.ts");
        const teams = await listAllPublished();
        return new Response(JSON.stringify({ teams }), { headers: { "Content-Type": "application/json" } });
      }
      const { listFederated } = await import("../activitypub/registry.ts");
      const teams = await listFederated();
      return new Response(JSON.stringify({ teams }), { headers: { "Content-Type": "application/json" } });
    }

    if (pathname === "/api/activitypub/publish" && req.method === "POST") {
      const userId = await resolveUserId(req);
      const { publishTeam } = await import("../activitypub/registry.ts");
      try {
        const body = await req.json();
        if (!body.teamSlug) return new Response(JSON.stringify({ error: "Missing teamSlug" }), { status: 400, headers: { "Content-Type": "application/json" } });
        await publishTeam(body.teamSlug, userId);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
    }

    if (pathname === "/api/activitypub/unpublish" && req.method === "POST") {
      const { unpublishTeam } = await import("../activitypub/registry.ts");
      try {
        const body = await req.json();
        if (!body.teamSlug) return new Response(JSON.stringify({ error: "Missing teamSlug" }), { status: 400, headers: { "Content-Type": "application/json" } });
        await unpublishTeam(body.teamSlug);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
    }

    if (pathname === "/api/activitypub/toggle" && req.method === "POST") {
      const { enableTeam, disableTeam } = await import("../activitypub/registry.ts");
      try {
        const body = await req.json();
        if (!body.teamSlug) return new Response(JSON.stringify({ error: "Missing teamSlug" }), { status: 400, headers: { "Content-Type": "application/json" } });
        if (body.enabled) await enableTeam(body.teamSlug);
        else await disableTeam(body.teamSlug);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
    }

    const apFollowersMatch = pathname.match(/^\/api\/activitypub\/([^/]+)\/followers(\/(.+))?$/);
    if (apFollowersMatch) {
      const teamName = apFollowersMatch[1];
      const sub = apFollowersMatch[3];
      const { LocalFederationStore } = await import("../activitypub/store.ts");
      const apStore = new LocalFederationStore();

      if (!sub && req.method === "GET") {
        const followers = await apStore.getFollowers(teamName);
        const pending = await apStore.getPendingFollows(teamName);
        return new Response(JSON.stringify({ followers, pending }), { headers: { "Content-Type": "application/json" } });
      }

      const actionMatch = sub?.match(/^([^/]+)\/(approve|reject)$/);
      if (actionMatch && req.method === "POST") {
        const actorId = decodeURIComponent(actionMatch[1]);
        const { approveFollow, rejectFollow } = await import("../activitypub/approval.ts");
        const home = Deno.env.get("HOME") ?? Deno.cwd();
        let apConfig;
        try { apConfig = JSON.parse(await Deno.readTextFile(`${home}/.porter/activitypub/config.json`)); } catch { apConfig = { domain: "" }; }
        const result = actionMatch[2] === "approve"
          ? await approveFollow(teamName, actorId, apConfig, apStore)
          : await rejectFollow(teamName, actorId, apConfig, apStore);
        return new Response(JSON.stringify({ ok: !!result }), { headers: { "Content-Type": "application/json" } });
      }

      if (sub && !actionMatch && req.method === "DELETE") {
        const actorId = decodeURIComponent(sub);
        await apStore.removeFollower(teamName, actorId);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
    }

    if (pathname === "/api/activitypub/config" && req.method === "PUT") {
      const home = Deno.env.get("HOME") ?? Deno.cwd();
      try {
        const body = await req.json();
        const text = JSON.stringify(body, null, 2);
        // Persist to MinIO (primary) and filesystem (fallback)
        try {
          const { ApS3Client } = await import("../activitypub/s3.ts");
          const s3Cfg = (await import("../activitypub/s3.ts")).loadS3Config();
          if (!s3Cfg) throw new Error("no S3");
          const s3 = new ApS3Client(s3Cfg);
          await s3.putObject("ap-config.json", text);
        } catch { /* MinIO not available — filesystem only */ }
        const dir = `${home}/.porter/activitypub`;
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/config.json`, text);
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- Team API endpoints (auth required) ---

    if (pathname === "/api/teams" && req.method === "GET") {
      const userId = await resolveUserId(req);
      const teams = await userStore.listTeams(userId);
      return new Response(JSON.stringify({ teams }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/api/teams" && req.method === "POST") {
      const userId = await resolveUserId(req);
      try {
        const body = await req.json();
        const now = new Date().toISOString();
        const config = { ...body.config, session: body.config.session || body.name };
        await userStore.saveTeam(userId, {
          name: body.name,
          config,
          created_at: now,
          updated_at: now,
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    const teamMatch = pathname.match(/^\/api\/teams\/([^/]+)$/);
    if (teamMatch && req.method === "GET") {
      const userId = await resolveUserId(req);
      const name = decodeURIComponent(teamMatch[1]);
      const team = await userStore.getTeam(userId, name);
      if (!team) {
        return new Response(JSON.stringify({ error: "Team not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }

      // Content negotiation
      const accept = req.headers.get("accept") || "";
      if (accept.includes("application/ld+json")) {
        const jsonld = teamToJsonLd(team);
        return new Response(JSON.stringify(jsonld, null, 2), {
          headers: { "Content-Type": "application/ld+json" },
        });
      }
      if (accept.includes("text/turtle")) {
        const turtle = teamToTurtle(team);
        return new Response(turtle, {
          headers: { "Content-Type": "text/turtle" },
        });
      }
      // Default: plain JSON (existing behavior)
      return new Response(JSON.stringify(team), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (teamMatch && req.method === "PUT") {
      const userId = await resolveUserId(req);
      const name = decodeURIComponent(teamMatch[1]);
      try {
        const body = await req.json();
        const existing = await userStore.getTeam(userId, name);
        await userStore.saveTeam(userId, {
          name,
          config: body.config,
          created_at: existing?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (teamMatch && req.method === "DELETE") {
      const userId = await resolveUserId(req);
      const name = decodeURIComponent(teamMatch[1]);
      const deleted = await userStore.deleteTeam(userId, name);
      return new Response(JSON.stringify({ ok: deleted }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- SHACL validation endpoint ---
    if (pathname === "/api/validate" && req.method === "POST") {
      try {
        const body = await req.json();
        const { validateConfig } = await import("../graph/validate.ts");
        const result = await validateConfig(body.config);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ conforms: true, violations: [], error: (err as Error).message }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- Config API endpoints ---
    if (pathname === "/api/config") {
      if (req.method === "GET") {
        const configPath = url.searchParams.get("path") ?? "porter.json";
        // Prevent directory traversal
        if (configPath.includes("..")) {
          return new Response(
            JSON.stringify({ error: "Invalid path" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        try {
          const text = await Deno.readTextFile(configPath);
          const config = JSON.parse(text);
          return new Response(JSON.stringify({ config }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: (err as Error).message }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      if (req.method === "POST") {
        try {
          const body = await req.json();
          const configPath = url.searchParams.get("path") ?? "porter.json";
          // Prevent directory traversal
          if (configPath.includes("..")) {
            return new Response(
              JSON.stringify({ error: "Invalid path" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          // Basic validation
          if (!body.config?.session) {
            return new Response(
              JSON.stringify({ error: "config.session is required" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
          if (!body.config?.agents?.length) {
            return new Response(
              JSON.stringify({ error: "config.agents must have at least one entry" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          // In container deployments, the working directory may be read-only.
          // Try the requested path first; fall back to /tmp if permission denied.
          let writtenPath = configPath;
          try {
            await Deno.writeTextFile(configPath, JSON.stringify(body.config, null, 2));
          } catch (writeErr) {
            if (writeErr instanceof Deno.errors.PermissionDenied ||
                writeErr instanceof Deno.errors.NotFound) {
              // Fall back to /tmp for read-only container filesystems
              const tmpPath = `/tmp/${configPath.split("/").pop() ?? "porter.json"}`;
              await Deno.writeTextFile(tmpPath, JSON.stringify(body.config, null, 2));
              writtenPath = tmpPath;
            } else {
              throw writeErr;
            }
          }
          return new Response(
            JSON.stringify({ ok: true, path: writtenPath }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ error: (err as Error).message }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Unsupported method for /api/config
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- Sessions API endpoints ---
    if (pathname === "/api/sessions" && req.method === "GET") {
      try {
        if (options?.sessionManager) {
          // When auth is active, return only sessions owned by the authenticated user.
          // When auth is not configured (local mode), return all sessions for
          // backwards compatibility.
          let rawSessions: ManagedSession[];
          if (oidcDiscovery) {
            const sessUserId = await resolveUserId(req);
            if (sessUserId !== "default") {
              rawSessions = options.sessionManager.listSessionsForUser(sessUserId);
            } else {
              rawSessions = options.sessionManager.listSessions();
            }
          } else {
            rawSessions = options.sessionManager.listSessions();
          }
          // Return live session data from the in-process manager
          const sessions = rawSessions.map(s => ({
            session: s.name,
            busPort: s.busPort,
            agentCount: s.config.agents.length,
            startedAt: s.startedAt,
            status: s.status,
          }));
          return new Response(
            JSON.stringify({ sessions }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        // Fallback to registry (standalone mode)
        const { listSessions, pruneStale } = await import("../orchestration/registry.ts");
        await pruneStale();
        const sessions = await listSessions();
        return new Response(
          JSON.stringify({ sessions }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ sessions: [], error: (err as Error).message }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // POST /api/sessions/launch — create and start a new session
    if (pathname === "/api/sessions/launch" && req.method === "POST") {
      if (!options?.sessionManager) {
        return new Response(
          JSON.stringify({ error: "Session management not available (running in standalone mode)" }),
          { status: 501, headers: { "Content-Type": "application/json" } },
        );
      }

      try {
        const body = await req.json();
        if (!body.config?.session) {
          return new Response(
            JSON.stringify({ error: "config.session is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (!body.config?.agents?.length) {
          return new Response(
            JSON.stringify({ error: "config.agents must have at least one entry" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        // Session name can be overridden (allows multiple sessions from one team)
        const sessionName = body.session_name as string | undefined;
        const effectiveSessionName = sessionName || body.config.session;

        if (options.sessionManager.hasSession(effectiveSessionName)) {
          return new Response(
            JSON.stringify({ error: `Session '${effectiveSessionName}' already exists` }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }

        // Resolve credentials from user's store and inject into providers
        const userId = await resolveUserId(req);
        await injectCredentials(body.config, userId);

        // Resolve agent references before launching
        const agents = body.config.agents as Record<string, unknown>[];
        for (let i = 0; i < agents.length; i++) {
          const a = agents[i];
          if (a.ref && a.system_prompt === undefined && !a.tools) {
            let resolved: SavedAgent | null = null;

            const ref = a.ref as string;
            if (ref.startsWith("http://") || ref.startsWith("https://")) {
              // Remote URI — fetch agent definition
              try {
                const resp = await fetch(ref, {
                  headers: { "Accept": "application/ld+json, application/json, text/turtle" },
                });
                if (resp.ok) {
                  const contentType = resp.headers.get("content-type") || "";
                  const text = await resp.text();
                  // Detect format from content-type or URL extension
                  if (contentType.includes("turtle") || ref.endsWith(".ttl")) {
                    // TODO: parse turtle to agent
                    resolved = null;
                  } else {
                    const json = JSON.parse(text);
                    resolved = jsonLdToSavedAgent(json);
                  }
                }
              } catch { /* remote fetch failed */ }
            } else {
              // Local agent library lookup
              resolved = await userStore.getAgent(userId, ref);
            }

            if (!resolved) {
              return new Response(JSON.stringify({
                error: `Agent "${ref}" not found`,
                missing_agent: ref,
              }), { status: 400, headers: { "Content-Type": "application/json" } });
            }

            // Merge: role from team ref, everything else from resolved agent
            agents[i] = {
              name: resolved.name,
              role: a.role || resolved.role,
              model: a.model || resolved.model,
              system_prompt: resolved.system_prompt,
              tools: resolved.tools,
              max_tokens: resolved.max_tokens,
              reasoning: resolved.reasoning,
              mcp_tools: resolved.mcp_tools,
            };
          }
        }

        // Associate session with the authenticated user for ownership enforcement.
        // In local mode (no OIDC), ownerId is undefined so sessions remain public.
        const launchOwnerId = (oidcDiscovery && userId !== "default") ? userId : undefined;
        const managed = await options.sessionManager.createSession(body.config, { sessionName, ownerId: launchOwnerId });
        return new Response(
          JSON.stringify({
            ok: true,
            session: managed.name,
            busPort: managed.busPort,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // POST /api/sessions/:name/agents/:agent/restart
    const restartMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/restart$/);
    if (restartMatch && req.method === "POST") {
      const sessionName = decodeURIComponent(restartMatch[1]);
      const agentName = decodeURIComponent(restartMatch[2]);
      try {
        if (!options?.sessionManager) {
          return new Response(
            JSON.stringify({ error: "Session management not available" }),
            { status: 501, headers: { "Content-Type": "application/json" } },
          );
        }
        const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
        if (ownerErr) return ownerErr;
        await options.sessionManager.restartAgent(sessionName, agentName);
        return new Response(
          JSON.stringify({ ok: true, session: sessionName, agent: agentName }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // POST /api/sessions/:name/send — publish a message to the session's bus
    const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/send$/);
    if (sendMatch && req.method === "POST") {
      const sessionName = decodeURIComponent(sendMatch[1]);
      if (options?.sessionManager) {
        const session = options.sessionManager.getSession(sessionName);
        if (!session) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const body = await req.json();
          const channel = body.channel || "task";
          const content = body.content || "";
          const from = body.from || "api";
          await session.bus.publish(channel, content, from);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: (err as Error).message }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: "No session manager" }), {
        status: 503, headers: { "Content-Type": "application/json" },
      });
    }

    // POST /api/sessions/:name/stop
    const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (stopMatch && req.method === "POST") {
      const sessionName = decodeURIComponent(stopMatch[1]);
      try {
        if (options?.sessionManager) {
          const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
          if (ownerErr) return ownerErr;
          const snapPath = await options.sessionManager.stopSession(sessionName);
          return new Response(
            JSON.stringify({ ok: true, session: sessionName, snapshotPath: snapPath }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        // Fallback to registry-based stop (standalone mode)
        const { getSession, unregisterSession } = await import("../orchestration/registry.ts");
        const record = await getSession(sessionName);
        if (!record) {
          return new Response(
            JSON.stringify({ error: `Session '${sessionName}' not found` }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
        try {
          Deno.kill(record.pid, "SIGTERM");
        } catch {
          // Process may already be dead — clean up the registry entry
          await unregisterSession(sessionName);
        }
        return new Response(
          JSON.stringify({ ok: true, session: sessionName }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // DELETE /api/sessions/:name — stop + delete session with snapshot cleanup
    const deleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      const sessionName = decodeURIComponent(deleteMatch[1]);
      if (!options?.sessionManager) {
        return new Response(
          JSON.stringify({ error: "Session management not available" }),
          { status: 501, headers: { "Content-Type": "application/json" } },
        );
      }
      try {
        const ownerErr = await checkSessionOwnership(req, sessionName, options.sessionManager);
        if (ownerErr) return ownerErr;
        await options.sessionManager.deleteSession(sessionName);
        return new Response(
          JSON.stringify({ ok: true, session: sessionName, deleted: true }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // --- Credentials API ---
    if (pathname === "/api/credentials/check" && req.method === "GET") {
      try {
        const provider = Deno.env.get("CLAUDE_CODE_USE_VERTEX") === "1"
          ? "vertex"
          : "anthropic";

        if (provider === "vertex") {
          const projectId = Deno.env.get("ANTHROPIC_VERTEX_PROJECT_ID");
          const region = Deno.env.get("CLOUD_ML_REGION");
          const adcPath = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS") ??
            (() => {
              // Fall back to default ADC path (same location the Google SDK checks)
              const home = Deno.env.get("HOME") ??
                Deno.env.get("USERPROFILE") ?? "";
              const defaultPath =
                `${home}/.config/gcloud/application_default_credentials.json`;
              try {
                Deno.statSync(defaultPath);
                return defaultPath;
              } catch {
                return undefined;
              }
            })();

          // Check if ADC file exists and parse it (keep adcJson for token check)
          let adcExists = false;
          let adcType = "unknown";
          let adcJson: Record<string, string> = {};
          if (adcPath) {
            try {
              const text = await Deno.readTextFile(adcPath);
              const parsed = JSON.parse(text);
              adcExists = true;
              adcType = parsed.type || "unknown";
              adcJson = parsed;
            } catch { /* file missing or invalid */ }
          }

          // Verify credentials without making a full Claude API call (avoids 30s+ timeout)
          let tokenOk = false;
          let tokenError = "";
          if (adcExists) {
            if (adcType === "service_account") {
              // Service accounts use JWT signing — if key file has required fields, it's valid
              tokenOk = !!(adcJson.client_email && adcJson.private_key);
              if (!tokenOk) {
                tokenError =
                  "Service account key is missing client_email or private_key";
              }
            } else if (adcType === "authorized_user") {
              // Test refresh token via OAuth2 token endpoint (fast, < 2s)
              try {
                const tokenResp = await fetch(
                  "https://oauth2.googleapis.com/token",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                      grant_type: "refresh_token",
                      client_id: adcJson.client_id || "",
                      client_secret: adcJson.client_secret || "",
                      refresh_token: adcJson.refresh_token || "",
                    }),
                    signal: AbortSignal.timeout(10000),
                  },
                );
                if (tokenResp.ok) {
                  tokenOk = true;
                } else {
                  const errBody = await tokenResp.text();
                  tokenError = `Token refresh failed (${tokenResp.status}): ${
                    errBody.slice(0, 200)
                  }`;
                }
              } catch (err) {
                tokenError = (err as Error).message;
              }
            } else {
              tokenError = `Unknown credential type: ${adcType}`;
            }
          }

          return new Response(
            JSON.stringify({
              provider: "vertex",
              projectId: projectId || null,
              region: region || null,
              adcPath: adcPath || null,
              adcExists,
              adcType,
              tokenOk,
              tokenError,
              configured: !!(projectId && region && adcExists),
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } else {
          // Anthropic direct
          const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
          const hasKey = !!apiKey;
          let keyOk = false;
          let keyError = "";

          if (hasKey) {
            // Validate key format only — no API call to avoid latency/timeouts
            keyOk = apiKey!.startsWith("sk-ant-") || apiKey!.startsWith("sk-");
            if (!keyOk) {
              keyError =
                "API key format appears invalid (expected sk-ant-... or sk-...)";
            }
          }

          return new Response(
            JSON.stringify({
              provider: "anthropic",
              hasKey,
              keyOk,
              keyError,
              configured: hasKey,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
      } catch (err) {
        return new Response(
          JSON.stringify({
            provider: "unknown",
            configured: false,
            tokenOk: false,
            tokenError: (err as Error).message,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // POST /api/credentials — update credentials
    if (pathname === "/api/credentials" && req.method === "POST") {
      try {
        const body = await req.json();

        if (body.type === "anthropic_key") {
          Deno.env.set("ANTHROPIC_API_KEY", body.key);
          return new Response(
            JSON.stringify({
              ok: true,
              message: "API key updated for this session",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        if (body.type === "vertex_adc") {
          const adcPath = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS") ??
            "/gcp/application_default_credentials.json";
          try {
            const adc = JSON.parse(body.credentials);
            if (!adc.type || (!adc.client_email && !adc.client_id)) {
              return new Response(
                JSON.stringify({
                  error:
                    "Invalid credentials JSON: missing 'type' or identity fields",
                }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            await Deno.writeTextFile(adcPath, JSON.stringify(adc, null, 2));
            return new Response(
              JSON.stringify({ ok: true, message: "Vertex AI credentials updated" }),
              { headers: { "Content-Type": "application/json" } },
            );
          } catch (writeErr) {
            return new Response(
              JSON.stringify({
                error: `Failed to write credentials: ${
                  (writeErr as Error).message
                }`,
              }),
              {
                status: 500,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }

        return new Response(
          JSON.stringify({ error: "Unknown credential type" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // --- Consolidated config export/import ---

    if (pathname === "/api/config/export" && req.method === "GET") {
      const userId = await resolveUserId(req);
      const agents = await userStore.listAgents(userId);
      const teams = await userStore.listTeams(userId);
      const { ModelStore: MS } = await import("../auth/model_store.ts");
      const modelStore = new MS();
      const models = await modelStore.list(userId);

      const configStoreEl = undefined; // server-side — no DOM
      // MCP servers are client-side only (localStorage); export as empty
      const { exportAllAsJsonLd } = await import("../rdf/turtle.ts");

      const resources = {
        agents,
        teams,
        models: models.map(m => ({
          id: m.id,
          display_name: m.display_name,
          provider_type: m.provider_type,
          base_url: m.base_url,
          auth: m.auth,
          context_window: m.context_window,
          max_tokens: m.max_tokens,
          capabilities: m.capabilities,
        })),
        mcp: [] as import("../rdf/turtle.ts").McpConfig[],
      };

      const jsonld = exportAllAsJsonLd(resources);
      return new Response(JSON.stringify(jsonld, null, 2), {
        headers: {
          "Content-Type": "application/ld+json",
          "Content-Disposition": 'attachment; filename="porter-config.jsonld"',
        },
      });
    }

    if (pathname === "/api/config/import" && req.method === "POST") {
      const userId = await resolveUserId(req);
      const contentType = req.headers.get("content-type") || "";
      const text = await req.text();

      const { importConsolidatedJsonLd, importConsolidatedTurtle } = await import("../rdf/turtle.ts");

      let resources;
      if (contentType.includes("turtle")) {
        resources = importConsolidatedTurtle(text);
      } else {
        resources = importConsolidatedJsonLd(JSON.parse(text));
      }

      // Save agents
      for (const agent of resources.agents) {
        await userStore.saveAgent(userId, agent);
      }
      // Save teams
      for (const team of resources.teams) {
        await userStore.saveTeam(userId, team);
      }
      // Save models
      if (resources.models.length > 0) {
        const { ModelStore: MS } = await import("../auth/model_store.ts");
        const ms = new MS();
        const existing = await ms.list(userId);
        const existingIds = new Set(existing.map(m => m.id));
        for (const model of resources.models) {
          if (!existingIds.has(model.id)) {
            await ms.add(userId, model as import("../auth/model_store.ts").ModelConfig);
          }
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        imported: {
          agents: resources.agents.length,
          teams: resources.teams.length,
          models: resources.models.length,
          mcp: resources.mcp.length,
        },
        models_needing_keys: resources.models
          .filter(m => m.auth === "bearer")
          .map(m => ({ id: m.id, display_name: m.display_name, base_url: m.base_url })),
      }), { headers: { "Content-Type": "application/json" } });
    }

    // --- RDF parse endpoint (server-side N3.js parsing for browser clients) ---
    if (pathname === "/api/rdf/parse" && req.method === "POST") {
      const type = url.searchParams.get("type") || "agent";
      const turtle = await req.text();
      try {
        const { turtleToAgent, turtleToTeam, turtleToModel, turtleToMcp } = await import("../rdf/turtle.ts");
        let result: unknown = null;
        switch (type) {
          case "agent": result = turtleToAgent(turtle); break;
          case "team": result = turtleToTeam(turtle); break;
          case "model": result = turtleToModel(turtle); break;
          case "mcp": result = turtleToMcp(turtle); break;
          default:
            return new Response(JSON.stringify({ error: `Unknown type: ${type}` }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
        }
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- RDF serialize endpoint (server-side N3.js serialization for browser clients) ---
    if (pathname === "/api/rdf/serialize" && req.method === "POST") {
      const type = url.searchParams.get("type") || "agent";
      try {
        const body = await req.json();
        const { agentToTurtle: agentTtl, teamToTurtle: teamTtl, modelToTurtle, mcpToTurtle } = await import("../rdf/turtle.ts");
        const uri = body._uri || "";
        let turtle = "";
        switch (type) {
          case "agent": turtle = agentTtl(body, uri); break;
          case "team": turtle = teamTtl(body, uri); break;
          case "model": turtle = modelToTurtle(body, uri); break;
          case "mcp": turtle = mcpToTurtle(body, uri); break;
          default:
            return new Response(JSON.stringify({ error: `Unknown type: ${type}` }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
        }
        return new Response(turtle, {
          headers: { "Content-Type": "text/turtle" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- SPARQL query endpoint ---
    if (pathname === "/api/sparql" && req.method === "GET") {
      const query = url.searchParams.get("query");
      if (!query) {
        return new Response(JSON.stringify({ error: "query parameter required" }),
          { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (!query.trim().toUpperCase().startsWith("SELECT")) {
        return new Response(JSON.stringify({ error: "Only SELECT queries allowed" }),
          { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const { getGraphStore } = await import("../graph/store.ts");
      const store = getGraphStore();
      if (!store) {
        return new Response(JSON.stringify({ error: "Graph store not initialized" }),
          { status: 501, headers: { "Content-Type": "application/json" } });
      }
      try {
        const results = store.query(query);
        return new Response(JSON.stringify({ results }),
          { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }),
          { status: 400, headers: { "Content-Type": "application/json" } });
      }
    }

    // Serve binary PNG icons
    if (pathname === "/porter-192.png" && porter_192_png) {
      return new Response(porter_192_png.buffer as ArrayBuffer, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }
    if (pathname === "/porter-512.png" && porter_512_png) {
      return new Response(porter_512_png.buffer as ArrayBuffer, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }

    if (!(pathname in ASSETS)) {
      // Dynamic fallback for UI module files (ES module imports from subdirectories)
      if (pathname.endsWith(".js") && !pathname.includes("..")) {
        try {
          const filePath = join(UI_DIR, pathname.slice(1));
          const content = await Deno.readTextFile(filePath);
          return new Response(content, {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" },
          });
        } catch { /* fall through to 404 */ }
      }
      return new Response("Not Found", { status: 404 });
    }

    let content = ASSETS[pathname];
    const ext = extname(pathname);
    const contentType = MIME[ext] ?? "application/octet-stream";

    // Inject bus URL into index.html
    if (pathname === "/index.html") {
      const injectedUrl = "/ws";
      content = content.replace(
        'content="ws://localhost:8787"',
        `content="${injectedUrl}"`,
      );
    }

    // Cache-Control per asset type
    let cacheControl = "public, max-age=86400";
    if (pathname === "/sw.js") cacheControl = "no-cache, no-store";
    else if (pathname.endsWith(".html") || pathname === "/manifest.json") cacheControl = "no-cache";

    return new Response(content, {
      headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
    });
  });

  return server;
}

// Standalone entry point — allows `deno run --allow-all ui/server.ts`
if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORTER_UI_PORT") ?? "3000");
  const busUrl = Deno.env.get("PORTER_BUS_URL") ?? "ws://localhost:8787";
  await startUiServer({ port, busUrl });
  console.log(`Porter Station listening on http://localhost:${port}`);
  console.log(`Bus URL: ${busUrl}`);
}
