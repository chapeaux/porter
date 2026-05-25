/**
 * Porter authentication module.
 *
 * OIDC (Keycloak) authentication with encrypted session cookies,
 * CSRF protection, per-user credential storage, and team persistence.
 */

export {
  discover,
  discoverOAuthAS,
  resetDiscovery,
  buildAuthUrl,
  exchangeCode,
  refreshToken,
  loadOidcConfig,
} from "./oidc.ts";
export type { OidcConfig, OidcDiscovery, TokenResponse } from "./oidc.ts";

export {
  initSessionKey,
  getRawSessionKey,
  createSessionCookie,
  readSession,
  decryptSession,
  clearSessionCookie,
  getCookieValue,
  base64UrlEncode,
  base64UrlDecode,
} from "./session.ts";
export type { SessionData } from "./session.ts";

export {
  generateCsrf,
  validateCsrf,
  clearCsrfCookie,
  generateCodeChallenge,
} from "./csrf.ts";
export type { CsrfValidation } from "./csrf.ts";

export {
  validateToken,
  extractUser,
  requireAuth,
  resetJwksCache,
} from "./middleware.ts";
export type { AuthenticatedUser } from "./middleware.ts";

export { CredentialStore } from "./credentials.ts";
export type {
  StoredCredential,
  RedactedCredential,
  ModelEndpoint,
} from "./credentials.ts";

export { UserStore } from "./user_store.ts";
export type { SavedTeam } from "./user_store.ts";

export { ModelStore } from "./model_store.ts";
export type { ModelConfig, ProviderType as ModelProviderType } from "./model_store.ts";
