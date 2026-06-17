/**
 * Follow request approval logic.
 *
 * Processes incoming Follow activities according to the configured
 * approval mode (open / allowlist / manual) and provides helpers
 * for manual approve/reject actions.
 */

import type { ActivityPubConfig } from "./config.ts";
import { apBaseUrl } from "./config.ts";
import type {
  FederationStore,
  FollowerRecord,
  PendingFollow,
} from "./store.ts";
import type {
  AcceptActivity,
  Actor,
  FollowActivity,
  RejectActivity,
} from "./types.ts";
import { AP_CONTEXT } from "./types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of processing a follow request. */
export interface ApprovalResult {
  action: "accepted" | "rejected" | "pending";
  /** Activity to deliver back to the requester (Accept or Reject). Null if pending. */
  responseActivity: AcceptActivity | RejectActivity | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive an `@user@domain` acct string from a remote actor. */
function deriveAcct(remoteActor: Actor): string {
  const domain = new URL(remoteActor.id).hostname;
  return `@${remoteActor.preferredUsername}@${domain}`;
}

/** Build the local actor URI for a team. */
function actorUri(config: ActivityPubConfig, teamSlug: string): string {
  return `${apBaseUrl(config)}/ap/actors/${teamSlug}`;
}

/** Generate a unique activity URI. */
function activityUri(config: ActivityPubConfig, teamSlug: string): string {
  const uuid = crypto.randomUUID();
  return `${apBaseUrl(config)}/ap/actors/${teamSlug}/activities/${uuid}`;
}

/** Build an Accept activity for a Follow. */
function buildAccept(
  config: ActivityPubConfig,
  teamSlug: string,
  followActivityOrId: FollowActivity | string,
  remoteActorId: string,
): AcceptActivity {
  return {
    "@context": AP_CONTEXT,
    id: activityUri(config, teamSlug),
    type: "Accept",
    actor: actorUri(config, teamSlug),
    object: followActivityOrId,
    to: [remoteActorId],
  };
}

/** Build a Reject activity for a Follow. */
function buildReject(
  config: ActivityPubConfig,
  teamSlug: string,
  followActivityOrId: FollowActivity | string,
  remoteActorId: string,
): RejectActivity {
  return {
    "@context": AP_CONTEXT,
    id: activityUri(config, teamSlug),
    type: "Reject",
    actor: actorUri(config, teamSlug),
    object: followActivityOrId,
    to: [remoteActorId],
  };
}

/** Build a FollowerRecord from a remote actor, marked as approved. */
function buildFollowerRecord(
  remoteActor: Actor,
  acct: string,
): FollowerRecord {
  return {
    actorId: remoteActor.id,
    acct,
    inbox: remoteActor.inbox,
    sharedInbox: remoteActor.endpoints?.sharedInbox,
    followedAt: new Date().toISOString(),
    approved: true,
  };
}

/**
 * Check whether an actor matches the allowlist.
 *
 * Entries can be:
 * - A bare domain (e.g. `"mastodon.social"`) — matches any user on that domain.
 * - A full acct (e.g. `"@luke@mastodon.social"`) — matches that specific user.
 */
function matchesAllowlist(acct: string, allowlist: string[]): boolean {
  const domain = new URL(`https://${acct.split("@").pop()}`).hostname;

  for (const entry of allowlist) {
    // Full acct match (normalise leading @)
    const normalised = entry.startsWith("@") ? entry : `@${entry}`;
    if (normalised.toLowerCase() === acct.toLowerCase()) {
      return true;
    }

    // Domain-only match
    if (
      !entry.includes("@") &&
      entry.toLowerCase() === domain.toLowerCase()
    ) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Process a follow request according to the configured approval mode.
 *
 * - **open**: Auto-accept all follows.
 * - **allowlist**: Accept if the actor's domain or full acct is in
 *   `config.allowlist`; reject otherwise.
 * - **manual**: Queue for human approval, return pending.
 */
export async function processFollowRequest(
  teamSlug: string,
  followActivity: FollowActivity,
  remoteActor: Actor,
  config: ActivityPubConfig,
  store: FederationStore,
): Promise<ApprovalResult> {
  const acct = deriveAcct(remoteActor);

  switch (config.approval_mode) {
    // ---- open ----
    case "open": {
      const follower = buildFollowerRecord(remoteActor, acct);
      await store.addFollower(teamSlug, follower);
      return {
        action: "accepted",
        responseActivity: buildAccept(
          config,
          teamSlug,
          followActivity,
          remoteActor.id,
        ),
      };
    }

    // ---- allowlist ----
    case "allowlist": {
      const allowed = matchesAllowlist(acct, config.allowlist ?? []);
      if (allowed) {
        const follower = buildFollowerRecord(remoteActor, acct);
        await store.addFollower(teamSlug, follower);
        return {
          action: "accepted",
          responseActivity: buildAccept(
            config,
            teamSlug,
            followActivity,
            remoteActor.id,
          ),
        };
      }
      return {
        action: "rejected",
        responseActivity: buildReject(
          config,
          teamSlug,
          followActivity,
          remoteActor.id,
        ),
      };
    }

    // ---- manual ----
    case "manual": {
      const pending: PendingFollow = {
        actorId: remoteActor.id,
        acct,
        inbox: remoteActor.inbox,
        sharedInbox: remoteActor.endpoints?.sharedInbox,
        receivedAt: new Date().toISOString(),
        followActivityId: followActivity.id,
      };
      await store.addPendingFollow(teamSlug, pending);
      return { action: "pending", responseActivity: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Manual approval helpers
// ---------------------------------------------------------------------------

/**
 * Manually approve a pending follow.
 *
 * Moves the pending record to the followers list and returns the
 * Accept activity to deliver to the remote actor. Returns `null`
 * if no matching pending follow is found.
 */
export async function approveFollow(
  teamSlug: string,
  actorId: string,
  config: ActivityPubConfig,
  store: FederationStore,
): Promise<AcceptActivity | null> {
  const pending = await store.getPendingFollows(teamSlug);
  const record = pending.find((p) => p.actorId === actorId);
  if (!record) return null;

  // Move from pending to followers
  await store.removePendingFollow(teamSlug, actorId);

  const follower: FollowerRecord = {
    actorId: record.actorId,
    acct: record.acct,
    inbox: record.inbox,
    sharedInbox: record.sharedInbox,
    followedAt: new Date().toISOString(),
    approved: true,
  };
  await store.addFollower(teamSlug, follower);

  return buildAccept(config, teamSlug, record.followActivityId, actorId);
}

/**
 * Manually reject a pending follow.
 *
 * Removes the pending record and returns the Reject activity to
 * deliver to the remote actor. Returns `null` if no matching
 * pending follow is found.
 */
export async function rejectFollow(
  teamSlug: string,
  actorId: string,
  config: ActivityPubConfig,
  store: FederationStore,
): Promise<RejectActivity | null> {
  const pending = await store.getPendingFollows(teamSlug);
  const record = pending.find((p) => p.actorId === actorId);
  if (!record) return null;

  await store.removePendingFollow(teamSlug, actorId);

  return buildReject(config, teamSlug, record.followActivityId, actorId);
}

/**
 * Check if an actor is an approved follower of a team.
 */
export async function isApprovedFollower(
  teamSlug: string,
  actorId: string,
  store: FederationStore,
): Promise<boolean> {
  const followers = await store.getFollowers(teamSlug);
  const record = followers.find((f) => f.actorId === actorId);
  return record?.approved === true;
}
