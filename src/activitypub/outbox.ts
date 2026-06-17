/**
 * ActivityPub outbox collection.
 *
 * Manages outgoing activities for each team actor: creating Notes,
 * DM replies, and Announce (boost) activities, recording them in an
 * in-memory outbox, and serving the outbox as a paginated
 * OrderedCollection.
 */

import type {
  Activity,
  CreateActivity,
  AnnounceActivity,
  APObject,
  OrderedCollection,
  OrderedCollectionPage,
} from "./types.ts";
import { AP_CONTEXT, AP_PUBLIC, AP_CONTENT_TYPE } from "./types.ts";
import type { ActivityPubConfig } from "./config.ts";
import { apBaseUrl } from "./config.ts";

const PAGE_SIZE = 20;
const MAX_OUTBOX_SIZE = 200;

/** In-memory outbox for sent activities (per team). */
const outboxes = new Map<string, Activity[]>();

// ---------------------------------------------------------------------------
// Activity constructors
// ---------------------------------------------------------------------------

/** Create a Note activity for posting to followers. */
export function createNote(
  teamSlug: string,
  config: ActivityPubConfig,
  options: {
    content: string;
    visibility: "public" | "followers_only";
    summary?: string;
    inReplyTo?: string | null;
    to?: string[];
    cc?: string[];
    attachments?: Array<{
      type: string;
      mediaType: string;
      url: string;
      name?: string;
    }>;
  },
): CreateActivity {
  const base = apBaseUrl(config);
  const actorUrl = `${base}/ap/actors/${teamSlug}`;
  const followersUrl = `${actorUrl}/followers`;
  const postId = `${actorUrl}/posts/${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const to =
    options.to ??
    (options.visibility === "public" ? [AP_PUBLIC] : [followersUrl]);
  const cc =
    options.cc ??
    (options.visibility === "public" ? [followersUrl] : []);

  const noteObject: APObject = {
    id: postId,
    type: "Note",
    attributedTo: actorUrl,
    content: options.content,
    published: now,
    to,
    cc,
  };

  if (options.summary !== undefined) {
    noteObject.summary = options.summary;
  }

  if (options.inReplyTo !== undefined) {
    noteObject.inReplyTo = options.inReplyTo;
  }

  if (options.attachments && options.attachments.length > 0) {
    noteObject.attachment = options.attachments.map((a) => ({
      type: a.type,
      mediaType: a.mediaType,
      url: a.url,
      name: a.name,
    }));
  }

  return {
    "@context": AP_CONTEXT,
    id: `${postId}/activity`,
    type: "Create",
    actor: actorUrl,
    object: noteObject,
    to,
    cc,
    published: now,
  };
}

/** Create a DM reply Note (addressed only to the recipient). */
export function createDirectReply(
  teamSlug: string,
  config: ActivityPubConfig,
  options: {
    content: string;
    inReplyTo: string;
    toActorUrl: string;
    attachments?: Array<{
      type: string;
      mediaType: string;
      url: string;
      name?: string;
    }>;
  },
): CreateActivity {
  const base = apBaseUrl(config);
  const actorUrl = `${base}/ap/actors/${teamSlug}`;
  const postId = `${actorUrl}/posts/${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const to = [options.toActorUrl];

  const noteObject: APObject = {
    id: postId,
    type: "Note",
    attributedTo: actorUrl,
    content: options.content,
    published: now,
    inReplyTo: options.inReplyTo,
    to,
    cc: [],
  };

  if (options.attachments && options.attachments.length > 0) {
    noteObject.attachment = options.attachments.map((a) => ({
      type: a.type,
      mediaType: a.mediaType,
      url: a.url,
      name: a.name,
    }));
  }

  return {
    "@context": AP_CONTEXT,
    id: `${postId}/activity`,
    type: "Create",
    actor: actorUrl,
    object: noteObject,
    to,
    cc: [],
    published: now,
  };
}

/** Create an Announce (boost) activity. */
export function createAnnounce(
  teamSlug: string,
  config: ActivityPubConfig,
  objectUrl: string,
): AnnounceActivity {
  const base = apBaseUrl(config);
  const actorUrl = `${base}/ap/actors/${teamSlug}`;
  const followersUrl = `${actorUrl}/followers`;
  const announceId = `${actorUrl}/posts/${crypto.randomUUID()}/activity`;
  const now = new Date().toISOString();

  return {
    "@context": AP_CONTEXT,
    id: announceId,
    type: "Announce",
    actor: actorUrl,
    object: objectUrl,
    to: [AP_PUBLIC],
    cc: [followersUrl],
    published: now,
  };
}

// ---------------------------------------------------------------------------
// Outbox storage
// ---------------------------------------------------------------------------

/** Record an activity in the outbox. */
export function appendToOutbox(teamSlug: string, activity: Activity): void {
  let items = outboxes.get(teamSlug);
  if (!items) {
    items = [];
    outboxes.set(teamSlug, items);
  }

  items.push(activity);

  // Cap at MAX_OUTBOX_SIZE — drop oldest entries
  if (items.length > MAX_OUTBOX_SIZE) {
    items.splice(0, items.length - MAX_OUTBOX_SIZE);
  }
}

// ---------------------------------------------------------------------------
// Outbox collection endpoint
// ---------------------------------------------------------------------------

/**
 * Handle GET /ap/actors/{teamName}/outbox — serve as OrderedCollection.
 *
 * Without `?page`: returns an OrderedCollection summary with totalItems
 * and first/last page links.
 *
 * With `?page=N`: returns an OrderedCollectionPage with the activities
 * for that page, most recent first, plus next/prev navigation links.
 */
export function handleOutboxRequest(
  teamSlug: string,
  url: URL,
  config: ActivityPubConfig,
): Response {
  const base = apBaseUrl(config);
  const collectionId = `${base}/ap/actors/${teamSlug}/outbox`;

  const items = outboxes.get(teamSlug) ?? [];
  // Serve most recent first
  const reversed = [...items].reverse();
  const totalItems = reversed.length;

  const pageParam = url.searchParams.get("page");

  if (pageParam === null) {
    // Return the collection summary
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    const collection: OrderedCollection = {
      "@context": AP_CONTEXT,
      id: collectionId,
      type: "OrderedCollection",
      totalItems,
      first: `${collectionId}?page=1`,
      last: `${collectionId}?page=${totalPages}`,
    };

    return new Response(JSON.stringify(collection), {
      status: 200,
      headers: { "Content-Type": AP_CONTENT_TYPE },
    });
  }

  // Return a specific page
  const page = parseInt(pageParam, 10);
  if (isNaN(page) || page < 1) {
    return new Response("Invalid page parameter", { status: 400 });
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

  if (page > totalPages) {
    return new Response("Page not found", { status: 404 });
  }

  const startIdx = (page - 1) * PAGE_SIZE;
  const endIdx = Math.min(startIdx + PAGE_SIZE, totalItems);
  const pageItems = reversed.slice(startIdx, endIdx);

  const collectionPage: OrderedCollectionPage = {
    "@context": AP_CONTEXT,
    id: `${collectionId}?page=${page}`,
    type: "OrderedCollectionPage",
    partOf: collectionId,
    totalItems,
    orderedItems: pageItems,
  };

  if (page < totalPages) {
    collectionPage.next = `${collectionId}?page=${page + 1}`;
  }
  if (page > 1) {
    collectionPage.prev = `${collectionId}?page=${page - 1}`;
  }

  return new Response(JSON.stringify(collectionPage), {
    status: 200,
    headers: { "Content-Type": AP_CONTENT_TYPE },
  });
}

/** Clear the in-memory outbox. Used in tests. */
export function resetOutbox(): void {
  outboxes.clear();
}
