/**
 * ActivityPub followers collection.
 *
 * Serves the followers collection as a paginated OrderedCollection per
 * the ActivityPub spec. Also provides a helper to resolve approved
 * follower inboxes for fan-out delivery.
 */

import type { ActivityPubConfig } from "./config.ts";
import { apBaseUrl } from "./config.ts";
import type { FederationStore } from "./store.ts";
import type { OrderedCollection, OrderedCollectionPage } from "./types.ts";
import { AP_CONTENT_TYPE, AP_CONTEXT } from "./types.ts";
import { resolveActorInbox } from "./delivery.ts";

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Followers collection endpoint
// ---------------------------------------------------------------------------

/**
 * Handle a GET request for a team actor's followers collection.
 *
 * Without `?page`: returns an OrderedCollection summary with totalItems
 * and first/last page links.
 *
 * With `?page=N`: returns an OrderedCollectionPage with the actor IDs
 * for that page, plus next/prev navigation links.
 *
 * Only approved followers are included.
 */
export async function handleFollowersRequest(
  teamSlug: string,
  url: URL,
  config: ActivityPubConfig,
  store: FederationStore,
): Promise<Response> {
  const base = apBaseUrl(config);
  const collectionId = `${base}/ap/actors/${teamSlug}/followers`;

  // Fetch all approved followers
  const allFollowers = await store.getFollowers(teamSlug);
  const approved = allFollowers.filter((f) => f.approved);
  const totalItems = approved.length;

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
  const pageItems = approved.slice(startIdx, endIdx).map((f) => f.actorId);

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

// ---------------------------------------------------------------------------
// Follower inbox resolution (for delivery fan-out)
// ---------------------------------------------------------------------------

/**
 * Get inbox URLs for all approved followers of a team.
 *
 * Used by the delivery module to fan out posts to every follower.
 * For each follower, tries the locally stored inbox/sharedInbox first;
 * falls back to resolving the actor URL if inbox is missing.
 */
export async function getApprovedFollowerInboxes(
  teamSlug: string,
  store: FederationStore,
): Promise<Array<{ actorId: string; inbox: string; sharedInbox?: string }>> {
  const allFollowers = await store.getFollowers(teamSlug);
  const approved = allFollowers.filter((f) => f.approved);

  const results: Array<{
    actorId: string;
    inbox: string;
    sharedInbox?: string;
  }> = [];

  for (const follower of approved) {
    if (follower.inbox) {
      results.push({
        actorId: follower.actorId,
        inbox: follower.inbox,
        sharedInbox: follower.sharedInbox,
      });
    } else {
      // Resolve from the actor URL
      const resolved = await resolveActorInbox(follower.actorId);
      if (resolved) {
        results.push({
          actorId: follower.actorId,
          inbox: resolved.inbox,
          sharedInbox: resolved.sharedInbox,
        });
      } else {
        console.warn(
          `[followers] Could not resolve inbox for follower ${follower.actorId}`,
        );
      }
    }
  }

  return results;
}
