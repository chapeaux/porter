/**
 * Router server -- lightweight HTTP + WebSocket reverse proxy.
 *
 * Authenticates users via OIDC, provisions per-user orchestrator pods
 * on demand, and reverse-proxies all traffic to the user's pod.
 *
 * Architecture:
 *   Browser --> Router Pod (this server)
 *                 +--> User-A Pod (porter serve --single-user)
 *                 +--> User-B Pod (porter serve --single-user)
 *                 +--> ...
 */

import {
  loadOidcConfig,
  discover,
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
  type OidcConfig,
  type OidcDiscovery,
} from "../auth/mod.ts";
import { PodRegistry } from "./pod_registry.ts";

export interface RouterOptions {
  port: number;
  idleTimeoutMinutes: number;
  namespace?: string;
  /** ActivityPub federation configuration. If omitted, federation is disabled. */
  activityPubConfig?: import("../activitypub/config.ts").ActivityPubConfig;
}

/** Client-side page templates — loaded from src/ui/ files. */
const LOADING_PAGE = Deno.readTextFileSync(new URL("../ui/loading.html", import.meta.url));
const AUTH_CHOOSE_TEMPLATE = Deno.readTextFileSync(new URL("../ui/auth-choose.html", import.meta.url));
const LOGGED_OUT_PAGE = Deno.readTextFileSync(new URL("../ui/logged-out.html", import.meta.url));

/**
 * Start the router server.
 *
 * The server handles OIDC auth, pod provisioning, and reverse proxying.
 */
export async function startRouter(options: RouterOptions): Promise<Deno.HttpServer> {
  const port = options.port;
  const namespace = options.namespace ?? Deno.env.get("PORTER_NAMESPACE") ?? "porter";
  const idleTimeoutMs = options.idleTimeoutMinutes * 60 * 1000;

  // Initialize auth
  const oidcConfig = loadOidcConfig();
  let oidcDiscovery: OidcDiscovery | null = null;

  await initSessionKey();

  if (oidcConfig) {
    try {
      oidcDiscovery = await discover(oidcConfig.issuer_url);
      console.log(`[router] OIDC enabled: ${oidcConfig.issuer_url}`);
    } catch (err) {
      console.error(`[router] OIDC init failed: ${(err as Error).message}`);
      console.error("[router] The router requires OIDC for user identification. Exiting.");
      Deno.exit(1);
    }
  } else {
    console.error("[router] WARNING: No OIDC configured. The router will not authenticate users.");
    console.error("[router] Set PORTER_OIDC_ISSUER_URL and PORTER_OIDC_CLIENT_ID to enable auth.");
  }

  const isSecure = (oidcConfig?.redirect_uri ?? "").startsWith("https://");

  // Server-side PKCE state store — maps state tokens to code verifiers
  const pendingLogins = new Map<string, {
    codeVerifier: string; redirectTo: string; createdAt: number;
    solidIssuer?: string; solidClientId?: string; solidCallbackUri?: string; solidTokenEndpoint?: string;
  }>();
  // Server-side token store — keeps large tokens out of cookies (4KB limit)
  const userTokens = new Map<string, { id_token?: string; refresh_token?: string; lws_token?: string }>();
  // Solid IdP cache — discovery + client registration (1 hour TTL)
  // deno-lint-ignore no-explicit-any
  const solidIdpCache = new Map<string, { discovery: any; clientId: string; callbackUri: string; cachedAt: number }>();
  // Clean up stale PKCE entries every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - 300_000;
    for (const [k, v] of pendingLogins) { if (v.createdAt < cutoff) pendingLogins.delete(k); }
  }, 300_000);

  // Initialize pod registry
  const podRegistry = new PodRegistry(namespace, idleTimeoutMs);
  podRegistry.startIdleSweep();
  console.log(`[router] Pod registry initialized (namespace: ${namespace}, idle timeout: ${options.idleTimeoutMinutes}m)`);

  // Initialize SPARQL-backed AP store if S3 is configured
  try {
    const { loadS3Config, ApS3Client } = await import("../activitypub/s3.ts");
    const s3Config = loadS3Config();
    if (s3Config) {
      const { SparqApStore } = await import("../activitypub/sparq_store.ts");
      const { setSparqStore } = await import("../activitypub/registry.ts");
      const s3 = new ApS3Client(s3Config);
      const sparqStore = new SparqApStore(s3);
      await sparqStore.init();
      setSparqStore(sparqStore);
      console.log("[router] SPARQL AP store initialized (sparq WASM + MinIO persistence)");
    }
  } catch (err) {
    console.error(`[router] SPARQL AP store init failed: ${(err as Error).message}`);
    console.error("[router] Falling back to local file-based AP storage");
  }

  // Initialize ActivityPub if configured
  let apRouteHandler: ((req: Request, url: URL, pathname: string) => Promise<Response | null>) | null = null;
  let apConfig: import("../activitypub/config.ts").ActivityPubConfig | null = null;
  const apExplicit = options.activityPubConfig;
  const apEnvEnabled = Deno.env.get("PORTER_AP_ENABLED");
  const apWanted = apExplicit?.enabled || apEnvEnabled === "true";
  console.error(`[router] AP check: explicit=${apExplicit?.enabled}, env=${apEnvEnabled}, wanted=${apWanted}`);
  if (apWanted) {
    try {
      const { handleActivityPubRoutes } = await import("../activitypub/routes.ts");
      const { LocalFederationStore } = await import("../activitypub/store.ts");
      const { resolveApConfig } = await import("../activitypub/config.ts");
      const { UserStore } = await import("../auth/user_store.ts");
      const { getSparqStore } = await import("../activitypub/registry.ts");
      const sparq = getSparqStore();
      const sparqConfig = sparq?.getConfig();
      apConfig = sparqConfig ?? resolveApConfig(apExplicit);
      if (apConfig) {
        const liveConfig = apConfig;
        const apStore = sparq ?? new LocalFederationStore();
        const apUserStore = new UserStore();
        const { RouterBackend } = await import("../activitypub/backend.ts");
        const apBackend = new RouterBackend(podRegistry, apUserStore);
        const apResolveUserId = async (r: Request): Promise<string> => {
          const u = await extractUser(r, oidcDiscovery?.jwks_uri, oidcDiscovery?.issuer);
          if (u) return u.sub;
          const s = await readSession(r);
          if (s?.sub) return s.sub;
          const webId = r.headers.get("x-porter-webid");
          if (webId) return `webid:${webId}`;
          return "default";
        };
        apRouteHandler = (req, url, pathname) =>
          handleActivityPubRoutes(req, url, pathname, {
            config: liveConfig,
            store: apStore,
            backend: apBackend,
            userStore: apUserStore,
            resolveUserId: apResolveUserId,
          });
        console.error(`[router] ActivityPub enabled: ${liveConfig.domain}`);
      } else {
        console.error("[router] ActivityPub wanted but config resolution failed");
      }
    } catch (err) {
      console.error(`[router] ActivityPub init failed: ${(err as Error).message}`);
    }
  }

  const server = Deno.serve({ port, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // --- Health check and static assets (no auth) ---
    if (pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    if (pathname === "/porter.svg") {
      try {
        const svgPath = new URL("../ui/porter.svg", import.meta.url);
        const svg = await Deno.readTextFile(svgPath);
        return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
      } catch {
        return new Response("", { status: 404 });
      }
    }
    if (pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }
    if (pathname === "/sw.js") {
      try {
        const sw = await Deno.readTextFile(new URL("../ui/sw.js", import.meta.url));
        return new Response(sw, { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-cache, no-store" } });
      } catch { return new Response("", { status: 404 }); }
    }
    if (pathname === "/manifest.json") {
      try {
        const m = await Deno.readTextFile(new URL("../ui/manifest.json", import.meta.url));
        return new Response(m, { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" } });
      } catch { return new Response("{}", { status: 404 }); }
    }
    if (pathname === "/porter-192.png" || pathname === "/porter-512.png") {
      try {
        const icon = await Deno.readFile(new URL("../ui" + pathname, import.meta.url));
        return new Response(icon, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
      } catch { return new Response("", { status: 404 }); }
    }

    // --- Auth routes (no proxy) ---

    if (pathname === "/auth/choose" && req.method === "GET") {
      const redirect = url.searchParams.get("redirect") ?? "/";
      const ssoUrl = `/auth/login?redirect=${encodeURIComponent(redirect)}`;
      const html = AUTH_CHOOSE_TEMPLATE
        .replaceAll("{{SSO_URL}}", ssoUrl)
        .replaceAll("{{REDIRECT}}", encodeURIComponent(redirect))
        .replaceAll("{{SSO_HIDDEN}}", oidcConfig ? "" : "hidden");
      return new Response(html,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    // Server-side PKCE state store (avoids CSRF cookie delivery issues)
    if (pathname === "/auth/login" && req.method === "GET" && oidcConfig && oidcDiscovery) {
      const redirectTo = url.searchParams.get("redirect") ?? "/";
      const { state, codeVerifier } = await generateCsrf(redirectTo, isSecure);
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const authUrl = buildAuthUrl(oidcDiscovery, oidcConfig, state, codeChallenge);
      pendingLogins.set(state, { codeVerifier, redirectTo, createdAt: Date.now() });
      return new Response(null, {
        status: 302,
        headers: { "Location": authUrl },
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

      const cookieHeader = req.headers.get("cookie") ?? "(none)";
      const hasCsrf = cookieHeader.includes("__porter_csrf");
      const pending = pendingLogins.get(state!);
      if (!pending) {
        // State already consumed (browser double-request) or expired.
        const existingSession = await readSession(req);
        if (existingSession?.sub) {
          return new Response(null, { status: 302, headers: { "Location": "/" } });
        }
        return new Response("Login session expired. Please try again.", { status: 403 });
      }
      pendingLogins.delete(state!);
      const csrf = { redirect_to: pending.redirectTo, code_verifier: pending.codeVerifier };

      try {
        const tokens = await exchangeCode(oidcDiscovery, oidcConfig, code, csrf.code_verifier);

        let claims: Record<string, unknown> = {};
        if (tokens.id_token) {
          const payload = tokens.id_token.split(".")[1];
          const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
          claims = JSON.parse(decoded);
        }

        // Exchange ID token for LWS access token at login time (while it's fresh)
        let lwsToken: string | undefined;
        const lwsBase = Deno.env.get("PORTER_LWS_BASE_URL")?.replace(/\/+$/, "");
        if (lwsBase && tokens.id_token) {
          try {
            const { getHttpClient } = await import("../providers/types.ts");
            const lwsResp = await fetch(`${lwsBase}/token`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: tokens.id_token,
                subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              }),
              client: getHttpClient(),
            });
            if (lwsResp.ok) {
              const lwsData = await lwsResp.json();
              lwsToken = lwsData.access_token;
              console.error(`[router] LWS token exchange succeeded`);
            } else {
              const body = await lwsResp.text().catch(() => "");
              console.error(`[router] LWS token exchange failed: ${lwsResp.status} ${body}`);
            }
          } catch (err) {
            console.error(`[router] LWS token exchange error: ${(err as Error).message}`);
          }
        }

        const sub = (claims.sub as string) ?? "";
        // Store large tokens server-side to keep cookie under 4KB
        userTokens.set(sub, {
          id_token: tokens.id_token,
          refresh_token: tokens.refresh_token,
          lws_token: lwsToken,
        });

        const now = new Date();
        const sessionCookie = await createSessionCookie({
          sub,
          username: (claims.preferred_username as string) ?? "unknown",
          email: claims.email as string | undefined,
          name: claims.name as string | undefined,
          issued_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 86400_000).toISOString(),
        }, isSecure);

        return new Response(null, {
          status: 302,
          headers: [
            ["Location", csrf.redirect_to || "/"],
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

      // Revoke the refresh token to kill the Keycloak SSO session
      const storedTokens = session?.sub ? userTokens.get(session.sub) : undefined;
      if (session?.sub) userTokens.delete(session.sub);
      if (storedTokens?.refresh_token && oidcDiscovery) {
        const revokeUrl = (oidcDiscovery as unknown as Record<string, unknown>).revocation_endpoint as string
          ?? oidcDiscovery.token_endpoint?.replace(/\/token$/, "/revoke");
        if (revokeUrl) {
          try {
            await fetch(revokeUrl, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: storedTokens.refresh_token,
                token_type_hint: "refresh_token",
                client_id: oidcConfig?.client_id ?? "",
              }),
            });
          } catch { /* best effort */ }
        }
      }

      const isSolidUser = session?.sub?.startsWith("http");
      if (!isSolidUser && oidcDiscovery?.end_session_endpoint) {
        const fwdProto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
        const fwdHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
        const postLogoutUri = `${fwdProto}://${fwdHost}/auth/logged-out`;
        const params = new URLSearchParams({
          post_logout_redirect_uri: postLogoutUri,
          client_id: oidcConfig?.client_id ?? "",
        });
        if (storedTokens?.id_token) {
          params.set("id_token_hint", storedTokens.id_token);
        }
        headers.push(["Location", `${oidcDiscovery.end_session_endpoint}?${params}`]);
        return new Response(null, { status: 302, headers });
      }

      headers.push(["Location", "/auth/logged-out"]);
      return new Response(null, { status: 302, headers });
    }

    if (pathname === "/auth/logged-out" && req.method === "GET") {
      return new Response(LOGGED_OUT_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- Solid OIDC login (dynamic client registration + PKCE) ---

    if (pathname === "/auth/solid-login" && req.method === "GET") {
      const issuer = url.searchParams.get("issuer")?.replace(/\/+$/, "");
      const redirectTo = url.searchParams.get("redirect") ?? "/";
      if (!issuer) {
        return new Response("Missing issuer parameter", { status: 400 });
      }

      try {
        const { discoverOAuthAS } = await import("../auth/oidc.ts");

        // Cache discovery + client registration per issuer
        let cached = solidIdpCache.get(issuer);
        const fwdProto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
        const fwdHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
        const callbackUri = `${fwdProto}://${fwdHost}/auth/solid-callback`;

        if (!cached || Date.now() - cached.cachedAt > 3600_000) {
          const t0 = Date.now();
          const solidDiscovery = await discoverOAuthAS(issuer);
          console.log(`[solid-login] Discovery: ${Date.now() - t0}ms`);
          const regEndpoint = (solidDiscovery as unknown as Record<string, string>).registration_endpoint;
          let clientId: string;
          if (regEndpoint) {
            const t1 = Date.now();
            const regResp = await fetch(regEndpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_name: "Porter",
                redirect_uris: [callbackUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
                application_type: "web",
              }),
            });
            if (!regResp.ok) {
              const text = await regResp.text().catch(() => "");
              return new Response(`Solid client registration failed: ${regResp.status} ${text}`, { status: 502 });
            }
            const regData = await regResp.json();
            console.log(`[solid-login] Registration: ${Date.now() - t1}ms`);
            clientId = regData.client_id;
          } else {
            clientId = callbackUri;
          }
          cached = {
            discovery: solidDiscovery,
            clientId,
            callbackUri,
            cachedAt: Date.now(),
          };
          solidIdpCache.set(issuer, cached);
          console.log(`[solid-login] Total uncached: ${Date.now() - t0}ms`);
        } else {
          console.log(`[solid-login] Cache hit for ${issuer}`);
        }

        const idp = cached!;
        const { state, codeVerifier } = await generateCsrf(redirectTo, isSecure);
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        pendingLogins.set(state, {
          codeVerifier,
          redirectTo,
          createdAt: Date.now(),
          solidIssuer: issuer,
          solidClientId: idp.clientId,
          solidCallbackUri: idp.callbackUri,
          solidTokenEndpoint: idp.discovery.token_endpoint,
        });

        const params = new URLSearchParams({
          response_type: "code",
          client_id: idp.clientId,
          redirect_uri: idp.callbackUri,
          state,
          scope: "openid webid profile offline_access",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });

        return new Response(null, {
          status: 302,
          headers: { "Location": `${idp.discovery.authorization_endpoint}?${params}` },
        });
      } catch (err) {
        return new Response(`Solid login failed: ${(err as Error).message}`, { status: 500 });
      }
    }

    if (pathname === "/auth/solid-callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`Solid auth error: ${url.searchParams.get("error_description") ?? error}`, { status: 400 });
      }
      if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
      }

      const pending = pendingLogins.get(state);
      if (!pending || !pending.solidTokenEndpoint) {
        return new Response("Login session expired. Please try again.", { status: 403 });
      }
      pendingLogins.delete(state);

      try {
        const tokenResp = await fetch(pending.solidTokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: pending.solidCallbackUri!,
            client_id: pending.solidClientId!,
            code_verifier: pending.codeVerifier,
          }),
        });

        if (!tokenResp.ok) {
          const text = await tokenResp.text().catch(() => "");
          return new Response(`Solid token exchange failed: ${tokenResp.status} ${text}`, { status: 502 });
        }

        const tokens = await tokenResp.json();
        let claims: Record<string, unknown> = {};
        if (tokens.id_token) {
          const payload = tokens.id_token.split(".")[1];
          claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
        }

        const sub = (claims.webid ?? claims.sub ?? "") as string;
        if (!sub) {
          return new Response("No WebID or sub in ID token", { status: 400 });
        }

        // Exchange for LWS token if configured
        let lwsToken: string | undefined;
        const lwsBase = Deno.env.get("PORTER_LWS_BASE_URL")?.replace(/\/+$/, "");
        if (lwsBase && tokens.id_token) {
          try {
            const { getHttpClient } = await import("../providers/types.ts");
            const lwsResp = await fetch(`${lwsBase}/token`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: tokens.id_token,
                subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              }),
              client: getHttpClient(),
            });
            if (lwsResp.ok) {
              lwsToken = (await lwsResp.json()).access_token;
            }
          } catch { /* LWS is optional for Solid users */ }
        }

        userTokens.set(sub, {
          id_token: tokens.id_token,
          refresh_token: tokens.refresh_token,
          lws_token: lwsToken,
        });

        const subPath = sub.replace(/#.*$/, "");
        const username = (claims.preferred_username ?? claims.name ?? subPath.split("/").filter(Boolean).pop() ?? "solid-user") as string;
        const now = new Date();
        const sessionCookie = await createSessionCookie({
          sub,
          username,
          email: claims.email as string | undefined,
          name: claims.name as string | undefined,
          issued_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 86400_000).toISOString(),
        }, isSecure);

        const redirectTo = pending.redirectTo || "/";
        return new Response(null, {
          status: 302,
          headers: {
            "Location": redirectTo,
            "Set-Cookie": sessionCookie,
          },
        });
      } catch (err) {
        return new Response(`Solid auth failed: ${(err as Error).message}`, { status: 500 });
      }
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
      const isSolidUser = sub.startsWith("http");
      let podUrl: string | undefined;
      let tokenEndpoint: string | undefined;

      if (isSolidUser) {
        // Solid user: discover Pod from WebID profile
        try {
          const profileUrl = sub.replace(/#.*$/, "");
          const resp = await fetch(profileUrl, { headers: { Accept: "text/turtle" } });
          if (resp.ok) {
            const turtle = await resp.text();
            const storageMatch = turtle.match(/(?:pim:storage|space:storage|<http:\/\/www\.w3\.org\/ns\/pim\/space#storage>)\s+<([^>]+)>/);
            if (storageMatch) podUrl = storageMatch[1];
          }
        } catch { /* discovery failed */ }
        // Solid users get their access token via /auth/lws-token if we have it
        const tokens = userTokens.get(sub);
        if (tokens?.lws_token || tokens?.id_token) {
          tokenEndpoint = "/auth/lws-token";
        }
      } else {
        // SSO user: Pod on LWS/Tudor
        const lwsBase = Deno.env.get("PORTER_LWS_BASE_URL")?.replace(/\/+$/, "");
        podUrl = lwsBase ? `${lwsBase}/${encodeURIComponent(sub)}/` : undefined;
        tokenEndpoint = podUrl ? "/auth/lws-token" : undefined;
      }

      return new Response(
        JSON.stringify({
          authenticated: true,
          oidc_configured: !!oidcDiscovery,
          user: { sub, username, email, name },
          pod_url: podUrl,
          lws_token_endpoint: tokenEndpoint,
          solid_user: isSolidUser,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // --- LWS token (return the token exchanged at login time) ---
    if (pathname === "/auth/lws-token" && req.method === "POST") {
      const session = await readSession(req);
      if (!session?.sub) {
        return new Response(JSON.stringify({ error: "Not authenticated" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      const tokens = userTokens.get(session.sub);
      const accessToken = tokens?.lws_token ?? tokens?.id_token;
      if (!accessToken) {
        return new Response(JSON.stringify({ error: "No token available" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ access_token: accessToken, token_type: "Bearer" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Pod status API (for the loading page to poll) ---

    if (pathname === "/api/pod-status" && req.method === "GET") {
      const user = await extractUser(req, oidcDiscovery?.jwks_uri, oidcDiscovery?.issuer);
      const session = await readSession(req);
      const userId = user?.sub ?? session?.sub;

      if (!userId) {
        return new Response(JSON.stringify({ ready: false, error: "Not authenticated" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const entry = podRegistry.get(userId);
      if (!entry) {
        return new Response(JSON.stringify({ ready: false, error: "No pod provisioned" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const ready = await podRegistry.checkReady(userId);
      return new Response(JSON.stringify({ ready, podName: entry.podName }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Router status endpoint (for debugging) ---

    if (pathname === "/api/router-status" && req.method === "GET") {
      const entries = podRegistry.listEntries();
      return new Response(JSON.stringify({
        namespace,
        idleTimeoutMinutes: options.idleTimeoutMinutes,
        activePods: entries.length,
        pods: entries.map(e => ({
          userId: e.userId,
          podName: e.podName,
          ready: e.ready,
          idleMinutes: Math.round((Date.now() - e.lastSeen) / 60000),
        })),
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- ActivityPub federation routes (before OIDC gate — AP uses HTTP Signatures) ---
    if (apRouteHandler) {
      // Protocol routes (webfinger, actor, inbox, etc.) handled directly by router
      if (!pathname.startsWith("/api/")) {
        const apResponse = await apRouteHandler(req, url, pathname);
        if (apResponse) return apResponse;
      }

      // Publish/unpublish/toggle: write to router's registry so WebFinger can resolve teams,
      // then let the request continue to the user pod via proxy for its own copy.
      if ((pathname === "/api/activitypub/publish" || pathname === "/api/activitypub/unpublish" || pathname === "/api/activitypub/toggle") && req.method === "POST") {
        try {
          const clonedBody = await req.clone().json();
          const slug = clonedBody?.teamSlug;
          if (slug) {
            const { publishTeam, unpublishTeam, enableTeam, disableTeam } = await import("../activitypub/registry.ts");
            if (pathname.endsWith("/publish")) {
              const session = await readSession(req);
              await publishTeam(slug, session?.sub ?? "unknown");
            } else if (pathname.endsWith("/unpublish")) {
              await unpublishTeam(slug);
            } else if (pathname.endsWith("/toggle")) {
              if (clonedBody.enabled) await enableTeam(slug);
              else await disableTeam(slug);
            }
          }
        } catch { /* let the pod handle errors */ }
        // Fall through to proxy — pod also needs the registry update
      }

      // Config save: update the router's live AP config and persist to sparq store
      if (pathname === "/api/activitypub/config" && req.method === "PUT" && apConfig) {
        try {
          const clonedBody = await req.clone().json();
          Object.assign(apConfig, clonedBody);
          const { getSparqStore } = await import("../activitypub/registry.ts");
          const sparq = getSparqStore();
          if (sparq) await sparq.saveConfig(apConfig);
        } catch { /* let the pod handle errors */ }
        // Fall through to proxy
      }
    }

    // --- Require authentication for everything below ---

    const user = await extractUser(req, oidcDiscovery?.jwks_uri, oidcDiscovery?.issuer);
    const session = await readSession(req);
    const userId = user?.sub ?? session?.sub;

    if (!userId) {
      // Solid OIDC callback — serve the full app (all static assets) so
      // solid-auth.js can process the code exchange in the browser.
      if (url.searchParams.has("code") && url.searchParams.has("state")) {
        const accept = req.headers.get("accept") ?? "";
        if (accept.includes("text/html")) {
          try {
            const html = Deno.readTextFileSync(new URL("../ui/index.html", import.meta.url));
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
          } catch { /* fall through to login chooser */ }
        }
      }
      // Serve UI static assets without auth (needed for Solid callback and PWA)
      if (pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".html")) {
        try {
          const filePath = new URL("../ui" + pathname, import.meta.url);
          const content = await Deno.readTextFile(filePath);
          const ct = pathname.endsWith(".js") ? "application/javascript"
            : pathname.endsWith(".css") ? "text/css"
            : "text/html; charset=utf-8";
          return new Response(content, { headers: { "Content-Type": ct } });
        } catch { /* not a UI file — fall through */ }
      }
      // Not authenticated: show login chooser for browser requests, 401 for API
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("text/html")) {
        const redirectTo = encodeURIComponent(url.pathname + url.search);
        return new Response(null, {
          status: 302,
          headers: { "Location": `/auth/choose?redirect=${redirectTo}` },
        });
      }
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- AP API from router's sparq store (after auth, before pod provisioning) ---
    if (apRouteHandler && pathname.startsWith("/api/activitypub/")) {
      const apResponse = await apRouteHandler(req, url, pathname);
      if (apResponse) return apResponse;
    }

    // --- Pod lookup and provisioning ---

    let entry = podRegistry.get(userId);

    if (!entry) {
      // Provision a new pod for this user
      try {
        entry = await podRegistry.provision(userId);
      } catch (err) {
        console.error(`[router] Failed to provision pod for ${userId}: ${(err as Error).message}`);
        return new Response(`Failed to provision workspace: ${(err as Error).message}`, { status: 500 });
      }
    }

    // Touch to reset idle timer
    podRegistry.touch(userId);

    // If pod is not ready, serve the loading page or reject the request
    if (!entry.ready) {
      const ready = await podRegistry.checkReady(userId);
      if (!ready) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return new Response("Pod not ready", { status: 503 });
        }
        const accept = req.headers.get("accept") ?? "";
        if (accept.includes("text/html")) {
          return new Response(LOADING_PAGE, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(JSON.stringify({ status: "starting", podName: entry.podName }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // --- WebSocket proxy ---

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return proxyWebSocket(req, entry.podUrl);
    }

    // --- HTTP reverse proxy ---

    const resp = await proxyHttp(req, entry.podUrl);
    if (resp.status === 502) {
      podRegistry.evict(userId);
      console.log(`[router] Evicted stale entry for ${userId} after proxy failure`);
    }
    return resp;
  });

  console.log(`[router] Router listening on http://0.0.0.0:${port}`);
  return server;
}

/**
 * Reverse-proxy an HTTP request to the user's pod.
 */
async function proxyHttp(req: Request, podUrl: string): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = `${podUrl}${url.pathname}${url.search}`;

  // Build forwarded headers
  const headers = new Headers(req.headers);
  headers.set("X-Forwarded-For", headers.get("x-forwarded-for") ?? "unknown");
  headers.set("X-Forwarded-Proto", headers.get("x-forwarded-proto") ?? url.protocol.replace(":", ""));
  headers.set("X-Forwarded-Host", headers.get("host") ?? url.host);

  // Remove hop-by-hop headers
  headers.delete("connection");
  headers.delete("upgrade");

  try {
    const proxyResp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    // Copy response headers, excluding hop-by-hop
    const respHeaders = new Headers(proxyResp.headers);
    respHeaders.delete("connection");
    respHeaders.delete("transfer-encoding");

    return new Response(proxyResp.body, {
      status: proxyResp.status,
      statusText: proxyResp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    console.error(`[router] Proxy error: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: "Backend unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Proxy a WebSocket connection to the user's pod.
 * Upgrades both sides and relays frames bidirectionally.
 */
function proxyWebSocket(req: Request, podUrl: string): Response {
  const url = new URL(req.url);
  const wsUrl = podUrl.replace(/^http/, "ws") + url.pathname + url.search;

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  let backendSocket: WebSocket | null = null;
  const pendingMessages: string[] = [];

  clientSocket.onopen = () => {
    backendSocket = new WebSocket(wsUrl);

    backendSocket.onopen = () => {
      // Flush buffered messages
      for (const msg of pendingMessages) {
        backendSocket!.send(msg);
      }
      pendingMessages.length = 0;
    };

    backendSocket.onmessage = (evt) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(evt.data);
      }
    };

    backendSocket.onclose = () => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    };

    backendSocket.onerror = () => {
      pendingMessages.length = 0;
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    };
  };

  clientSocket.onmessage = (evt) => {
    if (backendSocket?.readyState === WebSocket.OPEN) {
      backendSocket.send(typeof evt.data === "string" ? evt.data : String(evt.data));
    } else {
      pendingMessages.push(typeof evt.data === "string" ? evt.data : String(evt.data));
    }
  };

  clientSocket.onclose = () => {
    if (backendSocket) {
      backendSocket.close();
    }
  };

  clientSocket.onerror = () => {
    if (backendSocket) {
      backendSocket.close();
    }
  };

  return response;
}
