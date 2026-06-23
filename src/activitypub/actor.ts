/**
 * ActivityPub actor document generation.
 *
 * Each team gets a Service-type actor with its public key,
 * inbox/outbox URLs, and a summary built from the agent roster.
 */

import type { Actor } from "./types.ts";
import { AP_CONTEXT, AP_CONTENT_TYPE } from "./types.ts";
import type { ActivityPubConfig } from "./config.ts";
import { apBaseUrl } from "./config.ts";
import { getOrCreateKeyPair } from "./keys.ts";
import type { SavedTeam } from "../auth/user_store.ts";
import { getPattern } from "../orchestration/pattern_registry.ts";

/**
 * Build a summary string from the team's agent roster.
 *
 * Example output:
 *   "AI agent team: planner (admin), coder (worker), reviewer (reviewer)"
 */
function buildSummary(team: SavedTeam): string {
  const agents = team.config.agents ?? [];
  if (agents.length === 0) return "Porter AI agent team";

  const patternId = team.config.pattern;
  const pattern = patternId ? getPattern(patternId) : null;
  const roster = agents
    .map((a) => `${a.name} (${a.role})`)
    .join(", ");
  const patternNote = pattern ? ` [${pattern.name}]` : "";
  return `AI agent team${patternNote}: ${roster}`;
}

/**
 * Build the roster section for the welcome message / actor summary.
 * Returns an HTML-formatted roster.
 */
export function buildRosterHtml(team: SavedTeam): string {
  const agents = team.config.agents ?? [];
  if (agents.length === 0) return "<p>No agents configured.</p>";

  const lines = agents.map(
    (a) => `<li><strong>#${a.name}</strong> (${a.role})</li>`,
  );
  return `<ul>${lines.join("")}</ul>`;
}

/**
 * Generate the welcome message sent to a fediverse user on first DM.
 */
export function buildWelcomeMessage(team: SavedTeam): string {
  const agents = team.config.agents ?? [];
  const patternId = team.config.pattern;
  const pattern = patternId ? getPattern(patternId) : null;

  const agentLines = agents
    .map((a) => {
      const patternRole = pattern?.roles.find((r) => r.id === a.role);
      const roleName = patternRole ? patternRole.name : a.role;
      return `  #${a.name} — ${roleName}`;
    })
    .join("\n");

  const patternLine = pattern ? `Pattern: ${pattern.name}` : null;

  return [
    `${team.name} — AI agent team on Porter`,
    "",
    ...(patternLine ? [patternLine, ""] : []),
    "Agents:",
    agentLines,
    "",
    "Commands:",
    "  /start — Begin a new session",
    "  /stop — End the current session",
    "  /status — Check session status",
    "  /teams — List available teams",
    "",
    "Addressing:",
    "  #agentname message — routes to that agent",
    "  #role message — routes to all agents with that role",
    "  No hashtag — broadcast to the whole team",
    "",
    "Subscriptions:",
    "  #follow #logs — agent status updates",
    "  #follow #activity — all agent output",
    "  #follow #errors — error notifications only",
    "  #follow #tasks — inter-agent task assignments",
    "  #unfollow #channel — stop receiving",
    "  #subscriptions — list current",
    "",
    "Info:",
    "  #help — show this reference",
    "  #who — show active agents",
  ].join("\n");
}

/**
 * Generate a JSON-LD actor document for a team.
 */
export async function buildActorDocument(
  teamSlug: string,
  team: SavedTeam,
  config: ActivityPubConfig,
): Promise<Actor> {
  const base = apBaseUrl(config);
  const actorUrl = `${base}/ap/actors/${teamSlug}`;
  const keyPair = await getOrCreateKeyPair(teamSlug, base);

  return {
    "@context": AP_CONTEXT,
    id: actorUrl,
    type: "Service",
    preferredUsername: teamSlug,
    name: team.name,
    summary: buildSummary(team),
    url: actorUrl,
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    followers: `${actorUrl}/followers`,
    manuallyApprovesFollowers: config.approval_mode !== "open",
    publicKey: {
      id: keyPair.keyId,
      owner: actorUrl,
      publicKeyPem: keyPair.publicKeyPem,
    },
    endpoints: {
      sharedInbox: `${base}/ap/inbox`,
    },
  };
}

/**
 * Handle a GET request for an actor document.
 *
 * Content-negotiates: returns JSON-LD for AP clients, or null to
 * let the server handle it as a web page redirect.
 */
export async function handleActorRequest(
  teamSlug: string,
  team: SavedTeam,
  config: ActivityPubConfig,
  acceptHeader: string,
): Promise<Response | null> {
  const wantsAP =
    acceptHeader.includes("application/activity+json") ||
    acceptHeader.includes("application/ld+json");

  if (!wantsAP) {
    // Not an AP client — could redirect to web UI in the future
    // For now, serve the actor document anyway (Mastodon sometimes
    // sends Accept: */* on initial fetches)
  }

  const actor = await buildActorDocument(teamSlug, team, config);

  return new Response(JSON.stringify(actor), {
    headers: {
      "Content-Type": AP_CONTENT_TYPE,
      "Cache-Control": "max-age=300",
    },
  });
}
