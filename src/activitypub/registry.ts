/**
 * Federation registry — maps published team slugs to their owning user.
 *
 * Stored at ~/.porter/activitypub/registry.json. Lives outside any
 * single user's directory since the router needs to read it without
 * knowing which user to look up first.
 */

import { dirname } from "@std/path";

export interface FederationEntry {
  ownerId: string;
  publishedAt: string;
  enabled: boolean;
}

export interface FederationRegistry {
  teams: Record<string, FederationEntry>;
}

function registryPath(): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/activitypub/registry.json`;
}

async function loadRegistry(): Promise<FederationRegistry> {
  try {
    const text = await Deno.readTextFile(registryPath());
    return JSON.parse(text) as FederationRegistry;
  } catch {
    return { teams: {} };
  }
}

async function saveRegistry(reg: FederationRegistry): Promise<void> {
  const path = registryPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(reg, null, 2));
}

/** Publish a team for AP federation. */
export async function publishTeam(
  teamSlug: string,
  ownerId: string,
): Promise<void> {
  const reg = await loadRegistry();
  reg.teams[teamSlug] = {
    ownerId,
    publishedAt: new Date().toISOString(),
    enabled: true,
  };
  await saveRegistry(reg);
}

/** Unpublish a team (removes from federation). */
export async function unpublishTeam(teamSlug: string): Promise<void> {
  const reg = await loadRegistry();
  delete reg.teams[teamSlug];
  await saveRegistry(reg);
}

/** Disable a team without removing its entry. */
export async function disableTeam(teamSlug: string): Promise<void> {
  const reg = await loadRegistry();
  if (reg.teams[teamSlug]) {
    reg.teams[teamSlug].enabled = false;
    await saveRegistry(reg);
  }
}

/** Enable a previously disabled team. */
export async function enableTeam(teamSlug: string): Promise<void> {
  const reg = await loadRegistry();
  if (reg.teams[teamSlug]) {
    reg.teams[teamSlug].enabled = true;
    await saveRegistry(reg);
  }
}

/** Resolve which user owns a federated team. Returns null if not published or disabled. */
export async function resolveOwner(
  teamSlug: string,
): Promise<string | null> {
  const reg = await loadRegistry();
  const entry = reg.teams[teamSlug];
  if (!entry || !entry.enabled) return null;
  return entry.ownerId;
}

/** List all published and enabled teams. */
export async function listFederated(): Promise<
  Array<{ teamSlug: string; ownerId: string; publishedAt: string }>
> {
  const reg = await loadRegistry();
  return Object.entries(reg.teams)
    .filter(([_, e]) => e.enabled)
    .map(([slug, e]) => ({
      teamSlug: slug,
      ownerId: e.ownerId,
      publishedAt: e.publishedAt,
    }));
}
