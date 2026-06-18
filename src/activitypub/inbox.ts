/**
 * ActivityPub inbox handler.
 *
 * Processes incoming activities delivered to a team actor's inbox via
 * POST /ap/actors/{teamName}/inbox. Implements the server-to-server
 * federation protocol: signature verification, deduplication, and
 * activity routing.
 */

import type { ActivityPubConfig } from "./config.ts";
import type { FederationStore } from "./store.ts";
import type {
  Activity,
  Actor,
  APObject,
  FollowActivity,
} from "./types.ts";
import { AP_ACCEPT, AP_PUBLIC } from "./types.ts";
import { verifyDigest, verifySignature } from "./http_signatures.ts";

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface InboxCallbacks {
  onFollow: (
    teamSlug: string,
    followActivity: FollowActivity,
    remoteActor: Actor,
  ) => Promise<void>;
  onDirectMessage: (
    teamSlug: string,
    note: APObject,
    fromActorId: string,
  ) => Promise<void>;
  onMention?: (
    teamSlug: string,
    note: APObject,
    fromActorId: string,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// LRU deduplication cache (FIFO eviction, max 1000 entries)
// ---------------------------------------------------------------------------

const MAX_SEEN = 1000;
const seenActivities = new Map<string, true>();

function isDuplicate(activityId: string): boolean {
  if (seenActivities.has(activityId)) return true;

  // Evict oldest entry when at capacity (FIFO via insertion order).
  if (seenActivities.size >= MAX_SEEN) {
    const oldest = seenActivities.keys().next().value;
    if (oldest !== undefined) {
      seenActivities.delete(oldest);
    }
  }
  seenActivities.set(activityId, true);
  return false;
}

// ---------------------------------------------------------------------------
// Remote actor fetching
// ---------------------------------------------------------------------------

async function fetchRemoteActor(actorUrl: string): Promise<Actor | null> {
  try {
    const resp = await fetch(actorUrl, {
      headers: { Accept: AP_ACCEPT },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Actor;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Activity type helpers
// ---------------------------------------------------------------------------

function isDirectMessage(
  note: APObject,
  actorUrl: string,
): boolean {
  const to = note.to ?? [];
  const cc = note.cc ?? [];
  const allRecipients = [...to, ...cc];

  // It's a DM if the actor is in `to` and Public is NOT in `to` or `cc`.
  return to.includes(actorUrl) && !allRecipients.includes(AP_PUBLIC);
}

function isMention(
  note: APObject,
  actorUrl: string,
): boolean {
  const to = note.to ?? [];
  const cc = note.cc ?? [];
  const allRecipients = [...to, ...cc];

  // Public post that mentions the actor (actor in to or cc).
  return (
    allRecipients.includes(AP_PUBLIC) &&
    (to.includes(actorUrl) || cc.includes(actorUrl))
  );
}

// ---------------------------------------------------------------------------
// Activity handlers
// ---------------------------------------------------------------------------

async function handleFollow(
  teamSlug: string,
  activity: Activity,
  callbacks: InboxCallbacks,
): Promise<void> {
  const followActivity = activity as FollowActivity;
  const remoteActor = await fetchRemoteActor(activity.actor);
  if (!remoteActor) {
    console.warn(
      `[inbox] Could not fetch remote actor for Follow: ${activity.actor}`,
    );
    return;
  }
  await callbacks.onFollow(teamSlug, followActivity, remoteActor);
}

async function handleUndo(
  teamSlug: string,
  activity: Activity,
  store: FederationStore,
): Promise<void> {
  const inner = activity.object;

  // The object may be an inline Follow activity or a string reference.
  let isUndoFollow = false;
  if (typeof inner === "object" && "type" in inner && inner.type === "Follow") {
    isUndoFollow = true;
  } else if (typeof inner === "string") {
    // Treat string object as a possible Follow reference — we remove the
    // actor from followers regardless since that's the only Undo we handle.
    isUndoFollow = true;
  }

  if (isUndoFollow) {
    console.log(`[inbox] Undo Follow from ${activity.actor} for team ${teamSlug}`);
    await store.removeFollower(teamSlug, activity.actor);
    await store.removePendingFollow(teamSlug, activity.actor);
  }
}

async function handleCreate(
  teamSlug: string,
  activity: Activity,
  actorUrl: string,
  callbacks: InboxCallbacks,
): Promise<void> {
  const obj = activity.object;
  if (typeof obj === "string" || !("type" in obj)) return;

  const note = obj as APObject;
  if (note.type !== "Note") return;

  if (isDirectMessage(note, actorUrl)) {
    await callbacks.onDirectMessage(teamSlug, note, activity.actor);
  } else if (isMention(note, actorUrl) && callbacks.onMention) {
    await callbacks.onMention(teamSlug, note, activity.actor);
  }
}

// ---------------------------------------------------------------------------
// Main inbox handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming POST to a team actor's inbox.
 *
 * Processing pipeline:
 * 1. Verify HTTP Signature (401 on failure)
 * 2. Verify Digest header (400 on tampered body)
 * 3. Deduplicate by activity id
 * 4. Route by activity type
 */
export async function handleInbox(
  teamSlug: string,
  request: Request,
  config: ActivityPubConfig,
  store: FederationStore,
  callbacks: InboxCallbacks,
): Promise<Response> {
  // 1. Verify HTTP Signature
  const sigHeader = request.headers.get("signature");
  console.log(`[inbox] Signature header present: ${!!sigHeader}`);
  if (sigHeader) console.log(`[inbox] Signature: ${sigHeader.substring(0, 200)}`);
  const keyId = await verifySignature(request);
  if (!keyId) {
    console.error(`[inbox] HTTP Signature verification failed for ${request.url}`);
    return new Response("Invalid or missing HTTP Signature", { status: 401 });
  }
  console.log(`[inbox] Signature verified: ${keyId}`);

  // 2. Verify Digest
  const digestValid = await verifyDigest(request);
  if (!digestValid) {
    return new Response("Digest mismatch", { status: 400 });
  }

  // Parse the activity body
  let activity: Activity;
  try {
    activity = (await request.clone().json()) as Activity;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // 3. Deduplicate
  if (activity.id && isDuplicate(activity.id)) {
    // Already processed — return 202 to avoid re-delivery attempts.
    return new Response("Already processed", { status: 202 });
  }

  // 4. Route by activity type
  const actorUrl = `https://${config.domain}/ap/actors/${teamSlug}`;

  try {
    switch (activity.type) {
      case "Follow":
        await handleFollow(teamSlug, activity, callbacks);
        break;

      case "Undo":
        await handleUndo(teamSlug, activity, store);
        break;

      case "Create":
        await handleCreate(teamSlug, activity, actorUrl, callbacks);
        break;

      case "Delete":
        console.log(
          `[inbox] Delete activity from ${activity.actor} — no local cache to clear`,
        );
        break;

      case "Announce":
        console.log(
          `[inbox] Announce from ${activity.actor} — logged for analytics`,
        );
        break;

      default:
        console.log(
          `[inbox] Unhandled activity type: ${activity.type} from ${activity.actor}`,
        );
    }
  } catch (err) {
    console.error(`[inbox] Error handling ${activity.type}:`, err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response("Accepted", { status: 202 });
}

/** Clear the deduplication cache. Used in tests. */
export function resetInboxCache(): void {
  seenActivities.clear();
}
