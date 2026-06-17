/**
 * Session-scoped ActivityPub context singleton.
 *
 * Follows the same get/set pattern as getBus()/setBus() in
 * src/runtime/bus.ts. Set by the session bridge when an AP-initiated
 * session starts; read by agent AP tools (ap_post, ap_reply, ap_boost).
 */

/** Options for creating a post to followers. */
export interface PostOptions {
  content: string;
  visibility: string;
  summary?: string;
}

/** Options for replying in the DM thread. */
export interface ReplyOptions {
  content: string;
  attachments?: Array<{ path: string; description?: string }>;
}

/** AP context available to agent tools during an AP-initiated session. */
export interface ApContext {
  /** Team actor URL (e.g. "https://porter.example.com/ap/actors/devteam"). */
  actorUrl: string;
  /** The remote fediverse user's actor URL. */
  remoteActorUrl: string;
  /** The inReplyTo URL for the current DM thread. */
  inReplyTo: string | null;

  /** Post a Note to followers. */
  post(options: PostOptions): Promise<void>;
  /** Reply directly in the DM thread. */
  reply(options: ReplyOptions): Promise<void>;
  /** Boost a post by URL. */
  boost(url: string): Promise<void>;
}

let _context: ApContext | null = null;

/** Get the current AP context, or null if AP is not enabled for this session. */
export function getApContext(): ApContext | null {
  return _context;
}

/** Set the AP context for the current session. Called by the session bridge. */
export function setApContext(ctx: ApContext | null): void {
  _context = ctx;
}

/** Reset the AP context. Used in tests and session teardown. */
export function resetApContext(): void {
  _context = null;
}
