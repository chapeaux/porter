/**
 * Tests for the ActivityPub federation module.
 *
 * Covers: HTTP Signatures, key management, WebFinger, actor documents,
 * federation store, registry, follow approval, session bridge, outbox,
 * and followers collection.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";

import {
  getOrCreateKeyPair,
  importPublicKey,
  resetKeyCache,
} from "../src/activitypub/keys.ts";
import {
  signRequest,
  verifySignature,
  verifyDigest,
  resetPublicKeyCache,
} from "../src/activitypub/http_signatures.ts";
import { handleWebFinger } from "../src/activitypub/webfinger.ts";
import { buildActorDocument, buildWelcomeMessage } from "../src/activitypub/actor.ts";
import { LocalFederationStore } from "../src/activitypub/store.ts";
import type { FollowerRecord, PendingFollow, ConversationMap } from "../src/activitypub/store.ts";
import {
  publishTeam,
  unpublishTeam,
  resolveOwner,
  listFederated,
} from "../src/activitypub/registry.ts";
import {
  processFollowRequest,
  approveFollow,
  rejectFollow,
  isApprovedFollower,
} from "../src/activitypub/approval.ts";
import type { ApprovalResult } from "../src/activitypub/approval.ts";
import {
  parseMessage,
  resolveChannels,
  aggregateResponse,
} from "../src/activitypub/session_bridge.ts";
import {
  handleFollowersRequest,
} from "../src/activitypub/followers.ts";
import {
  createNote,
  handleOutboxRequest,
  resetOutbox,
} from "../src/activitypub/outbox.ts";
import type { ActivityPubConfig } from "../src/activitypub/config.ts";
import { AP_CONTEXT, AP_PUBLIC } from "../src/activitypub/types.ts";
import type { Actor, FollowActivity } from "../src/activitypub/types.ts";
import type { SavedTeam } from "../src/auth/user_store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<ActivityPubConfig>): ActivityPubConfig {
  return {
    enabled: true,
    domain: "test.example.com",
    approval_mode: "open",
    ...overrides,
  };
}

function makeTeam(name = "my-team"): SavedTeam {
  return {
    name,
    config: {
      session: "test",
      api_key_env: "ANTHROPIC_API_KEY",
      model: "claude-sonnet-4-20250514",
      agents: [
        { name: "planner", role: "admin", system_prompt: "", tools: [] },
        { name: "coder", role: "worker", system_prompt: "", tools: [] },
        { name: "reviewer", role: "reviewer", system_prompt: "", tools: [] },
      ],
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as SavedTeam;
}

function makeRemoteActor(opts?: { username?: string; domain?: string }): Actor {
  const username = opts?.username ?? "alice";
  const domain = opts?.domain ?? "mastodon.social";
  return {
    "@context": AP_CONTEXT,
    id: `https://${domain}/users/${username}`,
    type: "Person",
    preferredUsername: username,
    name: username,
    inbox: `https://${domain}/users/${username}/inbox`,
    outbox: `https://${domain}/users/${username}/outbox`,
    followers: `https://${domain}/users/${username}/followers`,
    publicKey: {
      id: `https://${domain}/users/${username}#main-key`,
      owner: `https://${domain}/users/${username}`,
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n",
    },
    endpoints: {
      sharedInbox: `https://${domain}/inbox`,
    },
  };
}

function makeFollowActivity(remoteActor: Actor, teamSlug: string): FollowActivity {
  return {
    "@context": AP_CONTEXT,
    id: `${remoteActor.id}/follows/${crypto.randomUUID()}`,
    type: "Follow",
    actor: remoteActor.id,
    object: `https://test.example.com/ap/actors/${teamSlug}`,
  };
}

// ---------------------------------------------------------------------------
// 1. HTTP Signatures
// ---------------------------------------------------------------------------

Deno.test("http-signatures: sign a request and verify it succeeds", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  resetKeyCache();
  resetPublicKeyCache();
  try {
    const keyPair = await getOrCreateKeyPair("sig-test", "https://test.example.com");

    const body = JSON.stringify({ type: "Create", content: "hello" });
    const req = new Request("https://remote.example.com/inbox", {
      method: "POST",
      body,
    });

    const signed = await signRequest(req, keyPair.privateKey, keyPair.keyId);

    // Verify signature header exists
    assertExists(signed.headers.get("signature"));
    assertExists(signed.headers.get("digest"));
    assertExists(signed.headers.get("date"));

    // Verify with the correct public key
    const keyId = await verifySignature(signed, async (_keyId: string) => {
      return keyPair.publicKeyPem;
    });

    assertExists(keyId);
    assertEquals(keyId, keyPair.keyId);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    resetKeyCache();
    resetPublicKeyCache();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("http-signatures: tampered body fails digest verification", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  resetKeyCache();
  resetPublicKeyCache();
  try {
    const keyPair = await getOrCreateKeyPair("sig-tamper", "https://test.example.com");

    const body = JSON.stringify({ type: "Create", content: "hello" });
    const req = new Request("https://remote.example.com/inbox", {
      method: "POST",
      body,
    });

    const signed = await signRequest(req, keyPair.privateKey, keyPair.keyId);

    // Tamper with the body — create a new request with modified body but same headers
    const tamperedBody = JSON.stringify({ type: "Create", content: "TAMPERED" });
    const tampered = new Request(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: tamperedBody,
    });

    const digestOk = await verifyDigest(tampered);
    assertEquals(digestOk, false);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    resetKeyCache();
    resetPublicKeyCache();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("http-signatures: wrong key fails signature verification", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  resetKeyCache();
  resetPublicKeyCache();
  try {
    const keyPair = await getOrCreateKeyPair("sig-wrong-a", "https://test.example.com");
    const otherKeyPair = await getOrCreateKeyPair("sig-wrong-b", "https://test.example.com");

    const body = JSON.stringify({ type: "Create", content: "hello" });
    const req = new Request("https://remote.example.com/inbox", {
      method: "POST",
      body,
    });

    const signed = await signRequest(req, keyPair.privateKey, keyPair.keyId);

    // Verify with the WRONG public key
    const keyId = await verifySignature(signed, async (_keyId: string) => {
      return otherKeyPair.publicKeyPem;
    });

    assertEquals(keyId, null);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    resetKeyCache();
    resetPublicKeyCache();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2. Keys
// ---------------------------------------------------------------------------

Deno.test("keys: generate key pair and verify PEM format", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  resetKeyCache();
  try {
    const keyPair = await getOrCreateKeyPair("pem-test", "https://test.example.com");

    assertExists(keyPair.privateKey);
    assertExists(keyPair.publicKeyPem);
    assertStringIncludes(keyPair.publicKeyPem, "-----BEGIN PUBLIC KEY-----");
    assertStringIncludes(keyPair.publicKeyPem, "-----END PUBLIC KEY-----");
    assertStringIncludes(keyPair.keyId, "https://test.example.com/ap/actors/pem-test#main-key");
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    resetKeyCache();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("keys: re-import public key produces valid CryptoKey", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  resetKeyCache();
  try {
    const keyPair = await getOrCreateKeyPair("reimport-test", "https://test.example.com");

    // Re-import the public key PEM
    const reimported = await importPublicKey(keyPair.publicKeyPem);
    assertExists(reimported);
    assertEquals(reimported.type, "public");
    assertEquals(reimported.algorithm.name, "RSASSA-PKCS1-v1_5");
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    resetKeyCache();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("keys: cached key pair is returned on second call", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  resetKeyCache();
  try {
    const first = await getOrCreateKeyPair("cache-test", "https://test.example.com");
    const second = await getOrCreateKeyPair("cache-test", "https://test.example.com");

    // Same object reference from cache
    assertEquals(first.publicKeyPem, second.publicKeyPem);
    assertEquals(first.keyId, second.keyId);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    resetKeyCache();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 3. WebFinger
// ---------------------------------------------------------------------------

Deno.test("webfinger: known team returns JRD with correct links", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig();

    // Publish the team first so resolveOwner succeeds
    await publishTeam("my-team", "user-1");

    const url = new URL("https://test.example.com/.well-known/webfinger?resource=acct:my-team@test.example.com");
    const resp = await handleWebFinger(url, config);

    assertExists(resp);
    assertEquals(resp!.status, 200);

    const body = await resp!.json();
    assertEquals(body.subject, "acct:my-team@test.example.com");
    assertEquals(body.links.length, 1);
    assertEquals(body.links[0].rel, "self");
    assertEquals(body.links[0].type, "application/activity+json");
    assertStringIncludes(body.links[0].href, "/ap/actors/my-team");

    const ct = resp!.headers.get("content-type");
    assertExists(ct);
    assertStringIncludes(ct, "application/jrd+json");
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("webfinger: unknown team returns 404", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig();

    const url = new URL("https://test.example.com/.well-known/webfinger?resource=acct:unknown-team@test.example.com");
    const resp = await handleWebFinger(url, config);

    assertExists(resp);
    assertEquals(resp!.status, 404);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("webfinger: missing resource param returns 400", async () => {
  const config = makeConfig();
  const url = new URL("https://test.example.com/.well-known/webfinger");
  const resp = await handleWebFinger(url, config);

  assertExists(resp);
  assertEquals(resp!.status, 400);
  const body = await resp!.json();
  assertStringIncludes(body.error, "resource");
});

// ---------------------------------------------------------------------------
// 4. Actor
// ---------------------------------------------------------------------------

Deno.test("actor: buildActorDocument returns valid JSON-LD with correct fields", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  resetKeyCache();
  try {
    const config = makeConfig();
    const team = makeTeam();

    const actor = await buildActorDocument("my-team", team, config);

    // @context
    assertEquals(actor["@context"], AP_CONTEXT);

    // type
    assertEquals(actor.type, "Service");

    // publicKey block
    assertExists(actor.publicKey);
    assertStringIncludes(actor.publicKey.publicKeyPem, "-----BEGIN PUBLIC KEY-----");
    assertStringIncludes(actor.publicKey.id, "#main-key");
    assertEquals(actor.publicKey.owner, actor.id);

    // inbox/outbox/followers URLs
    assertStringIncludes(actor.inbox, "/ap/actors/my-team/inbox");
    assertStringIncludes(actor.outbox, "/ap/actors/my-team/outbox");
    assertStringIncludes(actor.followers, "/ap/actors/my-team/followers");

    // preferredUsername
    assertEquals(actor.preferredUsername, "my-team");
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    resetKeyCache();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("actor: buildWelcomeMessage includes agent names and commands", () => {
  const team = makeTeam();
  const msg = buildWelcomeMessage(team);

  assertStringIncludes(msg, "planner");
  assertStringIncludes(msg, "coder");
  assertStringIncludes(msg, "reviewer");
  assertStringIncludes(msg, "/start");
  assertStringIncludes(msg, "/stop");
  assertStringIncludes(msg, "/status");
  assertStringIncludes(msg, "/teams");
});

// ---------------------------------------------------------------------------
// 5. Store
// ---------------------------------------------------------------------------

Deno.test("store: followers add/get/remove round-trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const store = new LocalFederationStore();
    const teamSlug = "store-test";

    // Initially empty
    const initial = await store.getFollowers(teamSlug);
    assertEquals(initial.length, 0);

    // Add a follower
    const follower: FollowerRecord = {
      actorId: "https://mastodon.social/users/alice",
      acct: "@alice@mastodon.social",
      inbox: "https://mastodon.social/users/alice/inbox",
      followedAt: new Date().toISOString(),
      approved: true,
    };
    await store.addFollower(teamSlug, follower);

    const afterAdd = await store.getFollowers(teamSlug);
    assertEquals(afterAdd.length, 1);
    assertEquals(afterAdd[0].actorId, follower.actorId);

    // Remove the follower
    await store.removeFollower(teamSlug, follower.actorId);
    const afterRemove = await store.getFollowers(teamSlug);
    assertEquals(afterRemove.length, 0);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("store: conversations save/get/remove round-trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const store = new LocalFederationStore();
    const teamSlug = "conv-test";

    // Initially empty
    const initial = await store.getConversations(teamSlug);
    assertEquals(initial.length, 0);

    // Save a conversation
    const conv: ConversationMap = {
      apConversationId: "tag:mastodon.social,2024:conv-123",
      remoteActorId: "https://mastodon.social/users/bob",
      sessionName: "session-1",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    await store.saveConversation(teamSlug, conv);

    const afterSave = await store.getConversations(teamSlug);
    assertEquals(afterSave.length, 1);
    assertEquals(afterSave[0].sessionName, "session-1");

    // Remove the conversation
    await store.removeConversation(teamSlug, conv.apConversationId);
    const afterRemove = await store.getConversations(teamSlug);
    assertEquals(afterRemove.length, 0);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("store: pending follows add/get/remove round-trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const store = new LocalFederationStore();
    const teamSlug = "pending-test";

    // Initially empty
    const initial = await store.getPendingFollows(teamSlug);
    assertEquals(initial.length, 0);

    // Add a pending follow
    const pending: PendingFollow = {
      actorId: "https://mastodon.social/users/charlie",
      acct: "@charlie@mastodon.social",
      inbox: "https://mastodon.social/users/charlie/inbox",
      receivedAt: new Date().toISOString(),
      followActivityId: "https://mastodon.social/users/charlie/follows/1",
    };
    await store.addPendingFollow(teamSlug, pending);

    const afterAdd = await store.getPendingFollows(teamSlug);
    assertEquals(afterAdd.length, 1);
    assertEquals(afterAdd[0].actorId, pending.actorId);

    // Remove the pending follow
    await store.removePendingFollow(teamSlug, pending.actorId);
    const afterRemove = await store.getPendingFollows(teamSlug);
    assertEquals(afterRemove.length, 0);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 6. Registry
// ---------------------------------------------------------------------------

Deno.test("registry: publish/unpublish/resolve/list round-trip", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    // Initially empty
    const initial = await listFederated();
    assertEquals(initial.length, 0);

    // Publish a team
    await publishTeam("reg-team", "owner-1");

    // Resolve owner
    const owner = await resolveOwner("reg-team");
    assertEquals(owner, "owner-1");

    // List shows the team
    const listed = await listFederated();
    assertEquals(listed.length, 1);
    assertEquals(listed[0].teamSlug, "reg-team");
    assertEquals(listed[0].ownerId, "owner-1");

    // Unpublish
    await unpublishTeam("reg-team");

    // Resolve returns null after unpublish
    const afterUnpublish = await resolveOwner("reg-team");
    assertEquals(afterUnpublish, null);

    // List is empty again
    const afterList = await listFederated();
    assertEquals(afterList.length, 0);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 7. Approval
// ---------------------------------------------------------------------------

Deno.test("approval: open mode auto-accepts follow", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig({ approval_mode: "open" });
    const store = new LocalFederationStore();
    const remoteActor = makeRemoteActor();
    const followActivity = makeFollowActivity(remoteActor, "approval-open");

    const result: ApprovalResult = await processFollowRequest(
      "approval-open",
      followActivity,
      remoteActor,
      config,
      store,
    );

    assertEquals(result.action, "accepted");
    assertExists(result.responseActivity);
    assertEquals(result.responseActivity!.type, "Accept");

    // Follower should be in the store
    const followers = await store.getFollowers("approval-open");
    assertEquals(followers.length, 1);
    assert(followers[0].approved);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("approval: allowlist accepts matching domain", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig({
      approval_mode: "allowlist",
      allowlist: ["mastodon.social"],
    });
    const store = new LocalFederationStore();
    const remoteActor = makeRemoteActor({ domain: "mastodon.social" });
    const followActivity = makeFollowActivity(remoteActor, "allow-match");

    const result = await processFollowRequest(
      "allow-match",
      followActivity,
      remoteActor,
      config,
      store,
    );

    assertEquals(result.action, "accepted");
    assertExists(result.responseActivity);
    assertEquals(result.responseActivity!.type, "Accept");
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("approval: allowlist rejects non-matching domain", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig({
      approval_mode: "allowlist",
      allowlist: ["allowed.example.com"],
    });
    const store = new LocalFederationStore();
    const remoteActor = makeRemoteActor({ domain: "blocked.example.com" });
    const followActivity = makeFollowActivity(remoteActor, "allow-reject");

    const result = await processFollowRequest(
      "allow-reject",
      followActivity,
      remoteActor,
      config,
      store,
    );

    assertEquals(result.action, "rejected");
    assertExists(result.responseActivity);
    assertEquals(result.responseActivity!.type, "Reject");

    // No follower should be stored
    const followers = await store.getFollowers("allow-reject");
    assertEquals(followers.length, 0);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("approval: manual mode queues follow as pending", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig({ approval_mode: "manual" });
    const store = new LocalFederationStore();
    const remoteActor = makeRemoteActor();
    const followActivity = makeFollowActivity(remoteActor, "manual-test");

    const result = await processFollowRequest(
      "manual-test",
      followActivity,
      remoteActor,
      config,
      store,
    );

    assertEquals(result.action, "pending");
    assertEquals(result.responseActivity, null);

    // Should be in pending, not followers
    const followers = await store.getFollowers("manual-test");
    assertEquals(followers.length, 0);

    const pending = await store.getPendingFollows("manual-test");
    assertEquals(pending.length, 1);
    assertEquals(pending[0].actorId, remoteActor.id);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("approval: approveFollow moves pending to followers", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig({ approval_mode: "manual" });
    const store = new LocalFederationStore();
    const remoteActor = makeRemoteActor();
    const followActivity = makeFollowActivity(remoteActor, "approve-test");

    // First, queue via manual mode
    await processFollowRequest(
      "approve-test",
      followActivity,
      remoteActor,
      config,
      store,
    );

    // Approve the follow
    const accept = await approveFollow("approve-test", remoteActor.id, config, store);
    assertExists(accept);
    assertEquals(accept!.type, "Accept");

    // Should now be a follower
    const isFollower = await isApprovedFollower("approve-test", remoteActor.id, store);
    assert(isFollower);

    // Pending should be empty
    const pending = await store.getPendingFollows("approve-test");
    assertEquals(pending.length, 0);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("approval: rejectFollow removes pending and returns Reject", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig({ approval_mode: "manual" });
    const store = new LocalFederationStore();
    const remoteActor = makeRemoteActor();
    const followActivity = makeFollowActivity(remoteActor, "reject-test");

    // Queue via manual mode
    await processFollowRequest(
      "reject-test",
      followActivity,
      remoteActor,
      config,
      store,
    );

    // Reject the follow
    const reject = await rejectFollow("reject-test", remoteActor.id, config, store);
    assertExists(reject);
    assertEquals(reject!.type, "Reject");

    // Should not be a follower
    const isFollower = await isApprovedFollower("reject-test", remoteActor.id, store);
    assertEquals(isFollower, false);

    // Pending should be empty
    const pending = await store.getPendingFollows("reject-test");
    assertEquals(pending.length, 0);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 8. Session Bridge
// ---------------------------------------------------------------------------

Deno.test("session-bridge: parseMessage recognizes /start command", () => {
  const agents = [{ name: "planner", role: "admin" }];
  const parsed = parseMessage("/start", undefined, agents);
  assertEquals(parsed.type, "command");
  assertEquals(parsed.command, "/start");
});

Deno.test("session-bridge: parseMessage recognizes /stop command", () => {
  const agents = [{ name: "planner", role: "admin" }];
  const parsed = parseMessage("/stop", undefined, agents);
  assertEquals(parsed.type, "command");
  assertEquals(parsed.command, "/stop");
});

Deno.test("session-bridge: parseMessage recognizes /status command", () => {
  const agents = [{ name: "planner", role: "admin" }];
  const parsed = parseMessage("/status", undefined, agents);
  assertEquals(parsed.type, "command");
  assertEquals(parsed.command, "/status");
});

Deno.test("session-bridge: parseMessage recognizes /teams command", () => {
  const agents = [{ name: "planner", role: "admin" }];
  const parsed = parseMessage("/teams", undefined, agents);
  assertEquals(parsed.type, "command");
  assertEquals(parsed.command, "/teams");
});

Deno.test("session-bridge: hashtag routes to agent name", () => {
  const agents = [
    { name: "planner", role: "admin" },
    { name: "coder", role: "worker" },
  ];
  const parsed = parseMessage("#planner please review this", undefined, agents);
  assertEquals(parsed.type, "chat");
  assertEquals(parsed.targetAgent, "planner");
  assertStringIncludes(parsed.content, "please review this");
  // Hashtag should be stripped from content
  assertEquals(parsed.content.includes("#planner"), false);
});

Deno.test("session-bridge: hashtag routes to role", () => {
  const agents = [
    { name: "planner", role: "admin" },
    { name: "coder", role: "worker" },
  ];
  const parsed = parseMessage("#worker do this task", undefined, agents);
  assertEquals(parsed.type, "chat");
  assertEquals(parsed.targetRole, "worker");
  assertStringIncludes(parsed.content, "do this task");
});

Deno.test("session-bridge: unmatched hashtag passes through as chat", () => {
  const agents = [
    { name: "planner", role: "admin" },
  ];
  const parsed = parseMessage("#unknown hello world", undefined, agents);
  assertEquals(parsed.type, "chat");
  assertEquals(parsed.targetAgent, undefined);
  assertEquals(parsed.targetRole, undefined);
  // The unmatched hashtag should remain in the content
  assertStringIncludes(parsed.content, "#unknown");
});

Deno.test("session-bridge: AP tags array routes to agent", () => {
  const agents = [
    { name: "coder", role: "worker" },
  ];
  const tags = [{ type: "Hashtag" as const, name: "#coder" }];
  const parsed = parseMessage("fix the bug #coder", tags, agents);
  assertEquals(parsed.type, "chat");
  assertEquals(parsed.targetAgent, "coder");
});

Deno.test("session-bridge: resolveChannels maps agent to task:agent channel", () => {
  const agents = [
    { name: "planner", role: "admin" },
    { name: "coder", role: "worker" },
  ];
  const parsed = parseMessage("#planner hello", undefined, agents);
  const channels = resolveChannels(parsed, agents);
  assertEquals(channels, ["task:planner"]);
});

Deno.test("session-bridge: resolveChannels maps role to all matching agents", () => {
  const agents = [
    { name: "coder-a", role: "worker" },
    { name: "coder-b", role: "worker" },
    { name: "planner", role: "admin" },
  ];
  const parsed = parseMessage("#worker do this", undefined, agents);
  const channels = resolveChannels(parsed, agents);
  assertEquals(channels.length, 2);
  assert(channels.includes("task:coder-a"));
  assert(channels.includes("task:coder-b"));
});

Deno.test("session-bridge: resolveChannels broadcasts to task when no target", () => {
  const agents = [{ name: "planner", role: "admin" }];
  const parsed = parseMessage("hello everyone", undefined, agents);
  const channels = resolveChannels(parsed, agents);
  assertEquals(channels, ["task"]);
});

Deno.test("session-bridge: aggregateResponse truncates at 500 chars", () => {
  const longText = "a".repeat(600);
  const result = aggregateResponse([longText]);
  // The raw combined text would be 600 chars, but it should be truncated to 499 + ellipsis
  // and wrapped in <p> tags
  assert(result.length <= 600); // <p> tags add overhead but the text content is truncated
  assertStringIncludes(result, "…"); // Unicode ellipsis
});

Deno.test("session-bridge: aggregateResponse combines multiple texts", () => {
  const result = aggregateResponse(["hello", "world"]);
  assertStringIncludes(result, "hello");
  assertStringIncludes(result, "world");
});

// ---------------------------------------------------------------------------
// 9. Outbox
// ---------------------------------------------------------------------------

Deno.test("outbox: createNote generates valid Create activity with correct addressing", () => {
  const config = makeConfig();
  const activity = createNote("outbox-team", config, {
    content: "<p>Hello fediverse!</p>",
    visibility: "public",
  });

  assertEquals(activity["@context"], AP_CONTEXT);
  assertEquals(activity.type, "Create");
  assertStringIncludes(activity.actor, "/ap/actors/outbox-team");
  assertStringIncludes(activity.id, "/activity");

  // Object is a Note
  const note = activity.object;
  assertEquals(note.type, "Note");
  assertEquals(note.content, "<p>Hello fediverse!</p>");
  assertStringIncludes(note.attributedTo!, "/ap/actors/outbox-team");

  // Public visibility: to includes AS#Public, cc includes followers
  assert(activity.to!.includes(AP_PUBLIC));
  assert(activity.cc!.some((url: string) => url.includes("/followers")));
});

Deno.test("outbox: createNote followers-only has correct addressing", () => {
  const config = makeConfig();
  const activity = createNote("outbox-team-fo", config, {
    content: "<p>Followers only</p>",
    visibility: "followers_only",
  });

  // Followers-only: to includes followers URL, cc is empty
  assert(activity.to!.some((url: string) => url.includes("/followers")));
  assertEquals(activity.cc!.length, 0);
  assertEquals(activity.to!.includes(AP_PUBLIC), false);
});

Deno.test("outbox: handleOutboxRequest returns OrderedCollection", () => {
  resetOutbox();
  const config = makeConfig();
  const url = new URL("https://test.example.com/ap/actors/outbox-handle/outbox");

  const resp = handleOutboxRequest("outbox-handle", url, config);

  assertEquals(resp.status, 200);
  const ct = resp.headers.get("content-type");
  assertExists(ct);
  assertStringIncludes(ct, "application/activity+json");
});

Deno.test("outbox: handleOutboxRequest collection has correct structure", async () => {
  resetOutbox();
  const config = makeConfig();
  const url = new URL("https://test.example.com/ap/actors/outbox-struct/outbox");

  const resp = handleOutboxRequest("outbox-struct", url, config);
  const body = await resp.json();

  assertEquals(body["@context"], AP_CONTEXT);
  assertEquals(body.type, "OrderedCollection");
  assertEquals(body.totalItems, 0);
  assertExists(body.first);
  assertExists(body.last);
});

// ---------------------------------------------------------------------------
// 10. Followers
// ---------------------------------------------------------------------------

Deno.test("followers: handleFollowersRequest returns OrderedCollection", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig();
    const store = new LocalFederationStore();
    const url = new URL("https://test.example.com/ap/actors/fol-test/followers");

    const resp = await handleFollowersRequest("fol-test", url, config, store);

    assertEquals(resp.status, 200);
    const ct = resp.headers.get("content-type");
    assertExists(ct);
    assertStringIncludes(ct, "application/activity+json");

    const body = await resp.json();
    assertEquals(body.type, "OrderedCollection");
    assertEquals(body.totalItems, 0);
    assertExists(body.first);
    assertExists(body.last);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("followers: handleFollowersRequest includes approved followers", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig();
    const store = new LocalFederationStore();

    // Add an approved follower
    await store.addFollower("fol-include", {
      actorId: "https://mastodon.social/users/alice",
      acct: "@alice@mastodon.social",
      inbox: "https://mastodon.social/users/alice/inbox",
      followedAt: new Date().toISOString(),
      approved: true,
    });

    // Add a non-approved follower (should be excluded)
    await store.addFollower("fol-include", {
      actorId: "https://mastodon.social/users/bob",
      acct: "@bob@mastodon.social",
      inbox: "https://mastodon.social/users/bob/inbox",
      followedAt: new Date().toISOString(),
      approved: false,
    });

    const url = new URL("https://test.example.com/ap/actors/fol-include/followers");
    const resp = await handleFollowersRequest("fol-include", url, config, store);
    const body = await resp.json();

    // Only approved follower should be counted
    assertEquals(body.totalItems, 1);
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("followers: handleFollowersRequest page returns actor IDs", async () => {
  const tmpDir = await Deno.makeTempDir();
  const origHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpDir);
  try {
    const config = makeConfig();
    const store = new LocalFederationStore();

    await store.addFollower("fol-page", {
      actorId: "https://mastodon.social/users/alice",
      acct: "@alice@mastodon.social",
      inbox: "https://mastodon.social/users/alice/inbox",
      followedAt: new Date().toISOString(),
      approved: true,
    });

    const url = new URL("https://test.example.com/ap/actors/fol-page/followers?page=1");
    const resp = await handleFollowersRequest("fol-page", url, config, store);
    const body = await resp.json();

    assertEquals(body.type, "OrderedCollectionPage");
    assertEquals(body.orderedItems.length, 1);
    assertEquals(body.orderedItems[0], "https://mastodon.social/users/alice");
  } finally {
    Deno.env.set("HOME", origHome ?? "");
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
