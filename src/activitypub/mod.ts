/**
 * ActivityPub federation module for Porter.
 *
 * Enables fediverse users to follow Porter team actors and interact
 * with agent sessions via direct messages.
 *
 * @module
 */

export type {
  ActivityPubConfig,
  ApprovalMode,
} from "./config.ts";
export { resolveApConfig, apBaseUrl } from "./config.ts";

export type {
  Actor,
  Activity,
  APObject,
  APTag,
  APAttachment,
  APContext,
  AcceptActivity,
  AnnounceActivity,
  CreateActivity,
  DeleteActivity,
  FollowActivity,
  RejectActivity,
  UndoActivity,
  OrderedCollection,
  OrderedCollectionPage,
  PublicKey,
  Endpoints,
  WebFingerLink,
  WebFingerResponse,
} from "./types.ts";
export { AP_CONTEXT, AP_PUBLIC, AP_CONTENT_TYPE, AP_ACCEPT } from "./types.ts";

export { getOrCreateKeyPair, importPublicKey, resetKeyCache } from "./keys.ts";
export type { KeyPair } from "./keys.ts";

export {
  signRequest,
  verifySignature,
  verifyDigest,
  resetPublicKeyCache,
} from "./http_signatures.ts";

export {
  getApContext,
  setApContext,
  resetApContext,
} from "./context.ts";
export type { ApContext, PostOptions, ReplyOptions } from "./context.ts";

export {
  publishTeam,
  unpublishTeam,
  disableTeam,
  enableTeam,
  resolveOwner,
  listFederated,
} from "./registry.ts";
export type { FederationEntry, FederationRegistry } from "./registry.ts";

export { LocalFederationStore } from "./store.ts";
export type {
  FederationStore,
  FollowerRecord,
  ConversationMap,
  PendingFollow,
} from "./store.ts";

export { handleWebFinger } from "./webfinger.ts";

export {
  buildActorDocument,
  buildWelcomeMessage,
  buildRosterHtml,
  handleActorRequest,
} from "./actor.ts";

export type {
  ActivityPubBackend,
  SessionHandle,
  SessionStatus,
} from "./backend.ts";
