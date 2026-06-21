/**
 * Federation state storage.
 *
 * FederationStore abstracts persistent storage of AP state (followers,
 * conversations, pending follows) with two implementations:
 * - LocalFederationStore: JSON files under ~/.porter/activitypub/
 * - SolidFederationStore: resources on a Solid Pod (future)
 */

import { dirname } from "@std/path";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface FollowerRecord {
  actorId: string;
  acct: string;
  inbox: string;
  sharedInbox?: string;
  followedAt: string;
  approved: boolean;
}

export interface ConversationMap {
  apConversationId: string;
  remoteActorId: string;
  sessionName: string;
  createdAt: string;
  lastActivityAt: string;
  subscriptions?: string[];
}

export interface PendingFollow {
  actorId: string;
  acct: string;
  inbox: string;
  sharedInbox?: string;
  receivedAt: string;
  followActivityId: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface FederationStore {
  getFollowers(teamSlug: string): Promise<FollowerRecord[]>;
  addFollower(teamSlug: string, follower: FollowerRecord): Promise<void>;
  removeFollower(teamSlug: string, actorId: string): Promise<void>;
  updateFollower(
    teamSlug: string,
    actorId: string,
    update: Partial<FollowerRecord>,
  ): Promise<void>;

  getPendingFollows(teamSlug: string): Promise<PendingFollow[]>;
  addPendingFollow(teamSlug: string, pending: PendingFollow): Promise<void>;
  removePendingFollow(teamSlug: string, actorId: string): Promise<void>;

  getConversations(teamSlug: string): Promise<ConversationMap[]>;
  saveConversation(teamSlug: string, conv: ConversationMap): Promise<void>;
  removeConversation(
    teamSlug: string,
    apConversationId: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local file-system implementation
// ---------------------------------------------------------------------------

function storeDir(teamSlug: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/activitypub/${teamSlug}`;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
}

export class LocalFederationStore implements FederationStore {
  private followersPath(teamSlug: string): string {
    return `${storeDir(teamSlug)}/followers.json`;
  }

  private pendingPath(teamSlug: string): string {
    return `${storeDir(teamSlug)}/pending_follows.json`;
  }

  private conversationsPath(teamSlug: string): string {
    return `${storeDir(teamSlug)}/conversations.json`;
  }

  async getFollowers(teamSlug: string): Promise<FollowerRecord[]> {
    return readJson<FollowerRecord[]>(this.followersPath(teamSlug), []);
  }

  async addFollower(
    teamSlug: string,
    follower: FollowerRecord,
  ): Promise<void> {
    const followers = await this.getFollowers(teamSlug);
    const existing = followers.findIndex((f) => f.actorId === follower.actorId);
    if (existing >= 0) {
      followers[existing] = follower;
    } else {
      followers.push(follower);
    }
    await writeJson(this.followersPath(teamSlug), followers);
  }

  async removeFollower(teamSlug: string, actorId: string): Promise<void> {
    const followers = await this.getFollowers(teamSlug);
    const filtered = followers.filter((f) => f.actorId !== actorId);
    await writeJson(this.followersPath(teamSlug), filtered);
  }

  async updateFollower(
    teamSlug: string,
    actorId: string,
    update: Partial<FollowerRecord>,
  ): Promise<void> {
    const followers = await this.getFollowers(teamSlug);
    const idx = followers.findIndex((f) => f.actorId === actorId);
    if (idx >= 0) {
      followers[idx] = { ...followers[idx], ...update };
      await writeJson(this.followersPath(teamSlug), followers);
    }
  }

  async getPendingFollows(teamSlug: string): Promise<PendingFollow[]> {
    return readJson<PendingFollow[]>(this.pendingPath(teamSlug), []);
  }

  async addPendingFollow(
    teamSlug: string,
    pending: PendingFollow,
  ): Promise<void> {
    const list = await this.getPendingFollows(teamSlug);
    const existing = list.findIndex((p) => p.actorId === pending.actorId);
    if (existing >= 0) {
      list[existing] = pending;
    } else {
      list.push(pending);
    }
    await writeJson(this.pendingPath(teamSlug), list);
  }

  async removePendingFollow(
    teamSlug: string,
    actorId: string,
  ): Promise<void> {
    const list = await this.getPendingFollows(teamSlug);
    const filtered = list.filter((p) => p.actorId !== actorId);
    await writeJson(this.pendingPath(teamSlug), filtered);
  }

  async getConversations(teamSlug: string): Promise<ConversationMap[]> {
    return readJson<ConversationMap[]>(
      this.conversationsPath(teamSlug),
      [],
    );
  }

  async saveConversation(
    teamSlug: string,
    conv: ConversationMap,
  ): Promise<void> {
    const convs = await this.getConversations(teamSlug);
    const existing = convs.findIndex(
      (c) => c.apConversationId === conv.apConversationId,
    );
    if (existing >= 0) {
      convs[existing] = conv;
    } else {
      convs.push(conv);
    }
    await writeJson(this.conversationsPath(teamSlug), convs);
  }

  async removeConversation(
    teamSlug: string,
    apConversationId: string,
  ): Promise<void> {
    const convs = await this.getConversations(teamSlug);
    const filtered = convs.filter(
      (c) => c.apConversationId !== apConversationId,
    );
    await writeJson(this.conversationsPath(teamSlug), filtered);
  }
}
