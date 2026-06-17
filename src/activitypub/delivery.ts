/**
 * ActivityPub activity delivery.
 *
 * Delivers outgoing activities to remote actor inboxes with HTTP
 * Signature authentication. Handles inbox resolution, shared-inbox
 * deduplication, and retry with exponential backoff.
 */

import { signRequest } from "./http_signatures.ts";
import { AP_ACCEPT, AP_CONTENT_TYPE } from "./types.ts";
import type { Activity } from "./types.ts";

// ---------------------------------------------------------------------------
// Inbox resolution cache (1 hour TTL)
// ---------------------------------------------------------------------------

interface CachedInbox {
  inbox: string;
  sharedInbox?: string;
  fetchedAt: number;
}

const inboxCache = new Map<string, CachedInbox>();
const INBOX_CACHE_TTL = 3600_000;

/**
 * Resolve a remote actor's inbox and shared inbox URLs.
 *
 * Fetches the actor document with the AP Accept header and extracts
 * the `inbox` and `endpoints.sharedInbox` fields. Results are cached
 * for 1 hour.
 */
export async function resolveActorInbox(
  actorUrl: string,
): Promise<{ inbox: string; sharedInbox?: string } | null> {
  const cached = inboxCache.get(actorUrl);
  if (cached && Date.now() - cached.fetchedAt < INBOX_CACHE_TTL) {
    return { inbox: cached.inbox, sharedInbox: cached.sharedInbox };
  }

  try {
    const resp = await fetch(actorUrl, {
      headers: { Accept: AP_ACCEPT },
    });
    if (!resp.ok) return null;

    const actor = await resp.json();
    const inbox = actor?.inbox as string | undefined;
    if (!inbox) return null;

    const sharedInbox = actor?.endpoints?.sharedInbox as string | undefined;
    const entry: CachedInbox = {
      inbox,
      sharedInbox,
      fetchedAt: Date.now(),
    };
    inboxCache.set(actorUrl, entry);

    return { inbox, sharedInbox };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function deliverToInbox(
  inboxUrl: string,
  signedRequest: Request,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(signedRequest.clone());

      if (resp.ok || (resp.status >= 200 && resp.status < 300)) {
        return;
      }

      // Retry on 429 (rate limit) or 5xx (server error)
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `[delivery] ${inboxUrl} returned ${resp.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // Non-retryable error
      console.error(
        `[delivery] Failed to deliver to ${inboxUrl}: ${resp.status} ${resp.statusText}`,
      );
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[delivery] Network error delivering to ${inboxUrl}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}):`,
          err,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      console.error(
        `[delivery] Failed to deliver to ${inboxUrl} after ${MAX_RETRIES} retries:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main delivery function
// ---------------------------------------------------------------------------

/**
 * Deliver an activity to a list of remote actor URLs.
 *
 * For each recipient:
 * 1. Resolve their inbox URL (and shared inbox if available)
 * 2. Deduplicate by shared inbox to avoid redundant deliveries
 * 3. Sign and POST the activity with retry on transient failures
 */
export async function deliverActivity(
  activity: Activity,
  recipients: string[],
  privateKey: CryptoKey,
  keyId: string,
): Promise<void> {
  // Resolve all recipient inboxes
  const resolved = await Promise.all(
    recipients.map(async (actorUrl) => {
      const result = await resolveActorInbox(actorUrl);
      if (!result) {
        console.warn(`[delivery] Could not resolve inbox for ${actorUrl}`);
      }
      return result ? { actorUrl, ...result } : null;
    }),
  );

  // Deduplicate by shared inbox. If multiple recipients share a sharedInbox,
  // deliver once there instead of to each individual inbox.
  const targetInboxes = new Map<string, string>(); // inbox URL → "reason" (for logging)
  const sharedInboxSeen = new Set<string>();

  for (const entry of resolved) {
    if (!entry) continue;

    if (entry.sharedInbox) {
      if (!sharedInboxSeen.has(entry.sharedInbox)) {
        sharedInboxSeen.add(entry.sharedInbox);
        targetInboxes.set(entry.sharedInbox, entry.actorUrl);
      }
    } else {
      targetInboxes.set(entry.inbox, entry.actorUrl);
    }
  }

  // Deliver to each unique inbox
  const body = JSON.stringify(activity);
  const deliveries = Array.from(targetInboxes.keys()).map(async (inboxUrl) => {
    const request = new Request(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": AP_CONTENT_TYPE,
      },
      body,
    });

    const signed = await signRequest(request, privateKey, keyId);
    await deliverToInbox(inboxUrl, signed);
  });

  await Promise.all(deliveries);
}

/** Clear the inbox resolution cache. Used in tests. */
export function resetInboxCache(): void {
  inboxCache.clear();
}
