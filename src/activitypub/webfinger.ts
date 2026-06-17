/**
 * WebFinger endpoint handler.
 *
 * Resolves acct: URIs to AP actor URLs by looking up the team in
 * the federation registry.
 */

import type { WebFingerResponse } from "./types.ts";
import type { ActivityPubConfig } from "./config.ts";
import { apBaseUrl } from "./config.ts";
import { resolveOwner, listFederated } from "./registry.ts";

/**
 * Handle a WebFinger request.
 *
 * Returns a Response if the request matches a federated team,
 * or null to pass through to the next handler.
 */
export async function handleWebFinger(
  url: URL,
  config: ActivityPubConfig,
): Promise<Response | null> {
  const resource = url.searchParams.get("resource");
  if (!resource) {
    return new Response(
      JSON.stringify({ error: "Missing 'resource' parameter" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Parse acct:teamname@domain
  const acctMatch = resource.match(/^acct:([^@]+)@(.+)$/);
  if (!acctMatch) {
    return new Response(
      JSON.stringify({ error: "Invalid resource format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const [, teamName, domain] = acctMatch;

  if (domain !== config.domain) {
    return new Response(
      JSON.stringify({ error: "Unknown domain" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const owner = await resolveOwner(teamName);
  if (!owner) {
    return new Response(
      JSON.stringify({ error: "Unknown team" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const base = apBaseUrl(config);
  const response: WebFingerResponse = {
    subject: `acct:${teamName}@${config.domain}`,
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: `${base}/ap/actors/${teamName}`,
      },
    ],
  };

  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/jrd+json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
