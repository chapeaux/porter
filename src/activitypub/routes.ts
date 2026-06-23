/**
 * ActivityPub HTTP route handler.
 *
 * Single entry point for all AP-related routes, consumed by both
 * src/ui/server.ts (standalone) and src/router/server.ts (multi-user).
 *
 * Returns a Response if the request matches an AP route, or null
 * to pass through to the next handler.
 */

import type { ActivityPubConfig } from "./config.ts";
import { apBaseUrl } from "./config.ts";
import type { FederationStore } from "./store.ts";
import type { ActivityPubBackend } from "./backend.ts";
import { AP_CONTENT_TYPE } from "./types.ts";
import { handleWebFinger } from "./webfinger.ts";
import { handleActorRequest } from "./actor.ts";
import {
  resolveOwner,
  listFederated,
  listAllPublished,
  publishTeam,
  unpublishTeam,
} from "./registry.ts";
import { handleInbox, type InboxCallbacks } from "./inbox.ts";
import { handleFollowersRequest } from "./followers.ts";
import { handleOutboxRequest } from "./outbox.ts";
import { handleMediaRequest } from "./media.ts";
import { processFollowRequest, approveFollow, rejectFollow } from "./approval.ts";
import { deliverActivity } from "./delivery.ts";
import { handleDirectMessage, type BridgeContext } from "./session_bridge.ts";
import { getOrCreateKeyPair } from "./keys.ts";
import { buildWelcomeMessage } from "./actor.ts";
import { createNote, appendToOutbox } from "./outbox.ts";
import type { FollowActivity, Actor, APObject } from "./types.ts";
import { UserStore, type SavedTeam } from "../auth/user_store.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ApRouteOptions {
  /** AP configuration. */
  config: ActivityPubConfig;
  /** Persistent storage for followers, conversations, etc. */
  store: FederationStore;
  /** Backend for session operations. */
  backend: ActivityPubBackend;
  /** User store for looking up teams. */
  userStore: UserStore;
  /** Resolve the current user ID from the request (for REST API auth). */
  resolveUserId?: (req: Request) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** AP JSON-LD response (application/activity+json). */
function apJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": AP_CONTENT_TYPE },
  });
}

/**
 * Resolve the authenticated user ID from the request, returning a
 * Response on failure (401) or null on success with the userId.
 */
async function requireUserId(
  req: Request,
  resolveUserId?: (req: Request) => Promise<string>,
): Promise<{ userId: string } | Response> {
  if (!resolveUserId) {
    return json({ error: "Authentication not configured" }, 401);
  }
  try {
    const userId = await resolveUserId(req);
    if (!userId || userId === "default") {
      return json({ error: "Authentication required" }, 401);
    }
    return { userId };
  } catch {
    return json({ error: "Authentication required" }, 401);
  }
}

/**
 * Resolve a team's SavedTeam by looking it up via UserStore, falling
 * back to the backend if not found (for router-mode where the team
 * config may live on the pod).
 */
async function resolveTeam(
  ownerId: string,
  teamSlug: string,
  options: ApRouteOptions,
): Promise<SavedTeam | null> {
  const team = await options.userStore.getTeam(ownerId, teamSlug);
  if (team) return team;

  // Fallback: the backend may have its own team lookup (router mode)
  return await options.backend.getTeam(ownerId, teamSlug);
}

// ---------------------------------------------------------------------------
// Main route handler
// ---------------------------------------------------------------------------

/**
 * Handle ActivityPub-related HTTP routes.
 *
 * Returns a Response if the request matches an AP route, or null
 * to pass through to the next handler.
 */
export async function handleActivityPubRoutes(
  req: Request,
  url: URL,
  pathname: string,
  options: ApRouteOptions,
): Promise<Response | null> {
  const { config, store, backend } = options;
  const method = req.method;

  // -------------------------------------------------------------------------
  // 1. WebFinger
  // -------------------------------------------------------------------------

  if (pathname === "/.well-known/webfinger" && method === "GET") {
    return await handleWebFinger(url, config);
  }

  // -------------------------------------------------------------------------
  // 2-5. AP actor routes: /ap/actors/{name}[/subpath]
  // -------------------------------------------------------------------------

  const apActorMatch = pathname.match(/^\/ap\/actors\/([^/]+)(\/.*)?$/);
  if (apActorMatch) {
    const teamSlug = apActorMatch[1];
    const subpath = apActorMatch[2] ?? "";

    // Resolve the team owner from the federation registry
    const ownerId = await resolveOwner(teamSlug);
    if (!ownerId) {
      return json({ error: "Team not found" }, 404);
    }

    // 2. GET /ap/actors/{name} — actor document
    if (subpath === "" && method === "GET") {
      const team = await resolveTeam(ownerId, teamSlug, options) ?? {
        name: teamSlug,
        config: { session: teamSlug, model: "", api_key_env: "", agents: [], working_dir: "." } as import("../core/config.ts").PorterConfig,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return await handleActorRequest(
        teamSlug,
        team,
        config,
        req.headers.get("accept") ?? "",
      );
    }

    // 3. POST /ap/actors/{name}/inbox — receive activities
    if (subpath === "/inbox" && method === "POST") {
      const team = await resolveTeam(ownerId, teamSlug, options) ?? {
        name: teamSlug,
        config: { session: teamSlug, model: "", api_key_env: "", agents: [], working_dir: "." } as import("../core/config.ts").PorterConfig,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const base = apBaseUrl(config);

      const callbacks: InboxCallbacks = {
        async onFollow(slug, followActivity, remoteActor) {
          const result = await processFollowRequest(
            slug, followActivity, remoteActor, config, store,
          );
          if (result.responseActivity) {
            const keyPair = await getOrCreateKeyPair(slug, base);
            await deliverActivity(
              result.responseActivity,
              [remoteActor.id],
              keyPair.privateKey,
              keyPair.keyId,
            );
            if (result.action === "accepted") {
              const welcome = buildWelcomeMessage(team);
              const welcomeNote = createNote(slug, config, {
                content: `<p>${welcome.replace(/\n/g, "<br>")}</p>`,
                visibility: "followers_only",
                to: [remoteActor.id],
              });
              appendToOutbox(slug, welcomeNote);
              await deliverActivity(welcomeNote, [remoteActor.id], keyPair.privateKey, keyPair.keyId);
            }
          }
        },
        async onDirectMessage(slug, note, fromActorId) {
          const bridgeCtx: BridgeContext = {
            teamSlug: slug,
            config,
            store,
            backend,
            team,
          };
          const result = await handleDirectMessage(note, fromActorId, bridgeCtx);
          if (result.replyText) {
            const { createDirectReply, appendToOutbox } = await import("./outbox.ts");
            const replyActivity = createDirectReply(slug, config, {
              content: `<p>${result.replyText.replace(/\n/g, "<br>")}</p>`,
              inReplyTo: (note.id ?? note.url) as string,
              toActorUrl: fromActorId,
            });
            appendToOutbox(slug, replyActivity);
            const keyPair = await getOrCreateKeyPair(slug, base);
            await deliverActivity(
              replyActivity,
              [fromActorId],
              keyPair.privateKey,
              keyPair.keyId,
            );
          }
        },
      };

      return await handleInbox(teamSlug, req, config, store, callbacks);
    }

    // 4. GET /ap/actors/{name}/outbox — outbox collection
    if (subpath === "/outbox" && method === "GET") {
      return handleOutboxRequest(teamSlug, url, config);
    }

    // 5. GET /ap/actors/{name}/followers — followers collection
    if (subpath === "/followers" && method === "GET") {
      return await handleFollowersRequest(teamSlug, url, config, store);
    }

    // No matching subpath under /ap/actors/{name}
    return json({ error: "Not found" }, 404);
  }

  // -------------------------------------------------------------------------
  // 6. Media: GET /ap/media/{id}
  // -------------------------------------------------------------------------

  if (pathname.startsWith("/ap/media/") && method === "GET") {
    const mediaId = pathname.slice("/ap/media/".length);
    if (mediaId) {
      return await handleMediaRequest(mediaId);
    }
    return json({ error: "Not found" }, 404);
  }

  // -------------------------------------------------------------------------
  // 7. REST API routes (require authenticated user)
  // -------------------------------------------------------------------------

  // GET /api/activitypub/config — read AP config
  if (pathname === "/api/activitypub/config" && method === "GET") {
    try {
      const home = Deno.env.get("HOME") ?? Deno.cwd();
      const text = await Deno.readTextFile(`${home}/.porter/activitypub/config.json`);
      return json(JSON.parse(text));
    } catch {
      return json({
        enabled: config.enabled ?? false,
        domain: config.domain ?? "",
        approval_mode: config.approval_mode ?? "allowlist",
        allowlist: config.allowlist ?? [],
        public_summaries: config.public_summaries ?? false,
        max_sessions_per_follower: config.max_sessions_per_follower ?? 1,
      });
    }
  }

  // PUT /api/activitypub/config — write AP config
  if (pathname === "/api/activitypub/config" && method === "PUT") {
    const auth = await requireUserId(req, options.resolveUserId);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const home = Deno.env.get("HOME") ?? Deno.cwd();
    const dir = `${home}/.porter/activitypub`;
    const { dirname } = await import("@std/path");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/config.json`, JSON.stringify(body, null, 2));
    return json({ ok: true });
  }

  // GET /api/activitypub/teams — list federated teams (scoped to current user)
  if (pathname === "/api/activitypub/teams" && method === "GET") {
    const auth = await requireUserId(req, options.resolveUserId);
    if (auth instanceof Response) return auth;

    const showAll = url.searchParams.get("all") === "true";
    const allTeams = showAll ? await listAllPublished() : await listFederated();
    const teams = allTeams.filter(t => t.ownerId === auth.userId);
    return json({ teams, domain: config.domain });
  }

  // POST /api/activitypub/publish — publish a team for federation
  if (pathname === "/api/activitypub/publish" && method === "POST") {
    const auth = await requireUserId(req, options.resolveUserId);
    if (auth instanceof Response) return auth;

    let body: { teamSlug?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.teamSlug) {
      return json({ error: "Missing teamSlug" }, 400);
    }

    await publishTeam(body.teamSlug, auth.userId);
    return json({ ok: true });
  }

  // POST /api/activitypub/unpublish — unpublish a team
  if (pathname === "/api/activitypub/unpublish" && method === "POST") {
    const auth = await requireUserId(req, options.resolveUserId);
    if (auth instanceof Response) return auth;

    let body: { teamSlug?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.teamSlug) {
      return json({ error: "Missing teamSlug" }, 400);
    }

    await unpublishTeam(body.teamSlug);
    return json({ ok: true });
  }

  // Routes under /api/activitypub/{teamName}/...
  const apiTeamMatch = pathname.match(
    /^\/api\/activitypub\/([^/]+)\/followers(\/(.+))?$/,
  );

  if (apiTeamMatch) {
    const teamName = apiTeamMatch[1];
    const followerSubpath = apiTeamMatch[3]; // encodedActorId or encodedActorId/action

    // GET /api/activitypub/{teamName}/followers — list followers
    if (!followerSubpath && method === "GET") {
      const auth = await requireUserId(req, options.resolveUserId);
      if (auth instanceof Response) return auth;

      const followers = await store.getFollowers(teamName);
      const pending = await store.getPendingFollows(teamName);
      return json({ followers, pending });
    }

    // Routes with a specific follower actor ID
    if (followerSubpath) {
      // Parse: {encodedActorId}/approve, {encodedActorId}/reject, or just {encodedActorId}
      const followerActionMatch = followerSubpath.match(
        /^([^/]+)\/(approve|reject)$/,
      );

      if (followerActionMatch) {
        const _encodedActorId = followerActionMatch[1];
        const action = followerActionMatch[2];

        // POST /api/activitypub/{teamName}/followers/{encodedActorId}/approve
        if (action === "approve" && method === "POST") {
          const auth = await requireUserId(req, options.resolveUserId);
          if (auth instanceof Response) return auth;

          const actorId = decodeURIComponent(followerActionMatch[1]);
          const acceptActivity = await approveFollow(teamName, actorId, config, store);
          if (!acceptActivity) {
            return json({ error: "Pending follow not found" }, 404);
          }
          const base = apBaseUrl(config);
          const keyPair = await getOrCreateKeyPair(teamName, base);
          await deliverActivity(acceptActivity, [actorId], keyPair.privateKey, keyPair.keyId);
          const ownerId = await resolveOwner(teamName);
          const approvedTeam = ownerId ? await resolveTeam(ownerId, teamName, options) : null;
          if (approvedTeam) {
            const welcome = buildWelcomeMessage(approvedTeam);
            const welcomeNote = createNote(teamName, config, {
              content: `<p>${welcome.replace(/\n/g, "<br>")}</p>`,
              visibility: "followers_only",
              to: [actorId],
            });
            appendToOutbox(teamName, welcomeNote);
            await deliverActivity(welcomeNote, [actorId], keyPair.privateKey, keyPair.keyId);
          }
          return json({ ok: true });
        }

        // POST /api/activitypub/{teamName}/followers/{encodedActorId}/reject
        if (action === "reject" && method === "POST") {
          const auth = await requireUserId(req, options.resolveUserId);
          if (auth instanceof Response) return auth;

          const actorId = decodeURIComponent(followerActionMatch[1]);
          const rejectAct = await rejectFollow(teamName, actorId, config, store);
          if (!rejectAct) {
            return json({ error: "Pending follow not found" }, 404);
          }
          const base = apBaseUrl(config);
          const keyPair = await getOrCreateKeyPair(teamName, base);
          await deliverActivity(rejectAct, [actorId], keyPair.privateKey, keyPair.keyId);
          return json({ ok: true });
        }
      }

      // DELETE /api/activitypub/{teamName}/followers/{encodedActorId}
      // The followerSubpath here is just the encodedActorId (no trailing action)
      if (!followerActionMatch && method === "DELETE") {
        const auth = await requireUserId(req, options.resolveUserId);
        if (auth instanceof Response) return auth;

        const actorId = decodeURIComponent(followerSubpath);
        await store.removeFollower(teamName, actorId);
        return json({ ok: true });
      }
    }
  }

  // No matching AP route — pass through
  return null;
}
