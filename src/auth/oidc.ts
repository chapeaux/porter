/**
 * OIDC client — discovery and token exchange.
 *
 * Auth implementation.
 * Supports PKCE S256 for public clients and client_secret for
 * confidential clients.
 */

export interface OidcConfig {
  issuer_url: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

let _discovery: OidcDiscovery | null = null;

/**
 * Fetch OIDC metadata from the well-known endpoint.
 * Caches the result for the process lifetime.
 */
export async function discover(issuerUrl: string): Promise<OidcDiscovery> {
  if (_discovery) return _discovery;

  const url = `${issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "porter-auth/0.1" },
  });

  if (!resp.ok) {
    throw new Error(`OIDC discovery failed: ${resp.status} ${resp.statusText}`);
  }

  _discovery = (await resp.json()) as OidcDiscovery;
  return _discovery;
}

/**
 * Discover OAuth Authorization Server metadata.
 * Tries /.well-known/oauth-authorization-server first, falls back to
 * /.well-known/openid-configuration. Returns the same shape as OIDC discovery.
 * Results are NOT cached (each MCP server may have a different issuer).
 */
export async function discoverOAuthAS(issuerUrl: string): Promise<OidcDiscovery> {
  const base = issuerUrl.replace(/\/+$/, "");

  const oauthUrl = `${base}/.well-known/oauth-authorization-server`;
  try {
    const resp = await fetch(oauthUrl, { headers: { "User-Agent": "porter-auth/0.1" } });
    if (resp.ok) {
      const meta = await resp.json();
      return {
        issuer: meta.issuer ?? base,
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        jwks_uri: meta.jwks_uri ?? "",
      };
    }
  } catch { /* fall through to OIDC */ }

  const oidcUrl = `${base}/.well-known/openid-configuration`;
  const resp = await fetch(oidcUrl, { headers: { "User-Agent": "porter-auth/0.1" } });
  if (!resp.ok) {
    throw new Error(`OAuth discovery failed for ${base}: neither oauth-authorization-server nor openid-configuration found`);
  }
  return (await resp.json()) as OidcDiscovery;
}

/** Reset cached discovery (for testing). */
export function resetDiscovery(): void {
  _discovery = null;
}

/**
 * Build the authorization URL for the OIDC login redirect.
 */
export function buildAuthUrl(
  discovery: OidcDiscovery,
  config: OidcConfig,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    state,
    scope: "openid profile email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(
  discovery: OidcDiscovery,
  config: OidcConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirect_uri,
    client_id: config.client_id,
    code_verifier: codeVerifier,
  });

  if (config.client_secret) {
    body.set("client_secret", config.client_secret);
  }

  const resp = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "porter-auth/0.1",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Token exchange failed: ${resp.status} ${resp.statusText}: ${text}`);
  }

  return (await resp.json()) as TokenResponse;
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshToken(
  discovery: OidcDiscovery,
  config: OidcConfig,
  refreshTokenValue: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: config.client_id,
  });

  if (config.client_secret) {
    body.set("client_secret", config.client_secret);
  }

  const resp = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "porter-auth/0.1",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Token refresh failed: ${resp.status} ${resp.statusText}: ${text}`);
  }

  return (await resp.json()) as TokenResponse;
}

/**
 * Load OIDC config from environment variables.
 * Returns null if OIDC is not configured (Porter runs without auth).
 */
export function loadOidcConfig(): OidcConfig | null {
  const issuerUrl = Deno.env.get("PORTER_OIDC_ISSUER_URL");
  const clientId = Deno.env.get("PORTER_OIDC_CLIENT_ID");

  if (!issuerUrl || !clientId) return null;

  return {
    issuer_url: issuerUrl,
    client_id: clientId,
    client_secret: Deno.env.get("PORTER_OIDC_CLIENT_SECRET"),
    redirect_uri: Deno.env.get("PORTER_OIDC_REDIRECT_URI") ?? "http://localhost:3000/auth/callback",
  };
}
