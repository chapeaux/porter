/**
 * SPARQL-backed AP state store using in-process sparq WASM + MinIO persistence.
 *
 * All AP state (registry, followers, pending follows, conversations, keys, config)
 * is stored as RDF triples in an in-memory sparq graph. On mutation, the graph is
 * serialized to N-Triples and written to MinIO for persistence across restarts.
 */

import { SparqStore, init as initSparq } from "./sparq/index.ts";
import type { ApS3Client } from "./s3.ts";
import type {
  FederationStore,
  FollowerRecord,
  PendingFollow,
  ConversationMap,
} from "./store.ts";
import type { ActivityPubConfig } from "./config.ts";

const P = "https://porter.chapeaux.io/vocab#";
const AS = "https://www.w3.org/ns/activitystreams#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const S3_KEY = "graph.nt";

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function teamUri(slug: string): string {
  return `urn:porter:ap:team/${encodeURIComponent(slug)}`;
}

function followerUri(slug: string, actorId: string): string {
  return `urn:porter:ap:follower/${encodeURIComponent(slug)}/${encodeURIComponent(actorId)}`;
}

function pendingUri(slug: string, actorId: string): string {
  return `urn:porter:ap:pending/${encodeURIComponent(slug)}/${encodeURIComponent(actorId)}`;
}

function convUri(slug: string, convId: string): string {
  return `urn:porter:ap:conv/${encodeURIComponent(slug)}/${encodeURIComponent(convId)}`;
}

export class SparqApStore implements FederationStore {
  private store!: SparqStore;
  private s3: ApS3Client;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(s3: ApS3Client) {
    this.s3 = s3;
  }

  async init(): Promise<void> {
    await initSparq();
    const data = await this.s3.getObject(S3_KEY);
    if (data && data.trim()) {
      this.store = await SparqStore.fromString(data, "ntriples");
    } else {
      this.store = await SparqStore.fromString("", "ntriples");
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 100);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const nt = this.store.queryQuadsString(
      "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
    );
    await this.s3.putObject(S3_KEY, nt);
  }

  async flushSync(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  async publishTeam(slug: string, ownerId: string, podUrl?: string): Promise<void> {
    const uri = teamUri(slug);
    const podTriple = podUrl
      ? `<${uri}> <${P}podUrl> "${esc(podUrl)}" .`
      : "";
    this.store.update(`
      DELETE { <${uri}> ?p ?o }
      WHERE  { <${uri}> ?p ?o };
      INSERT DATA {
        <${uri}> <${RDF}type> <${P}FederatedTeam> .
        <${uri}> <${P}ownerId> "${esc(ownerId)}" .
        <${uri}> <${P}enabled> "true"^^<${XSD}boolean> .
        <${uri}> <${P}publishedAt> "${new Date().toISOString()}" .
        ${podTriple}
      }
    `);
    await this.flush();
  }

  async unpublishTeam(slug: string): Promise<void> {
    const uri = teamUri(slug);
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    await this.flush();
  }

  async enableTeam(slug: string): Promise<void> {
    const uri = teamUri(slug);
    this.store.update(`
      DELETE { <${uri}> <${P}enabled> ?v } WHERE { <${uri}> <${P}enabled> ?v };
      INSERT DATA { <${uri}> <${P}enabled> "true"^^<${XSD}boolean> }
    `);
    await this.flush();
  }

  async disableTeam(slug: string): Promise<void> {
    const uri = teamUri(slug);
    this.store.update(`
      DELETE { <${uri}> <${P}enabled> ?v } WHERE { <${uri}> <${P}enabled> ?v };
      INSERT DATA { <${uri}> <${P}enabled> "false"^^<${XSD}boolean> }
    `);
    await this.flush();
  }

  resolveOwner(slug: string): string | null {
    const uri = teamUri(slug);
    const rows = this.store.queryBindings(`
      SELECT ?owner WHERE {
        <${uri}> <${P}ownerId> ?owner ;
                 <${P}enabled> "true"^^<${XSD}boolean> .
      }
    `);
    return rows[0]?.get("owner")?.value ?? null;
  }

  listFederated(): Array<{ teamSlug: string; ownerId: string; publishedAt: string; podUrl?: string }> {
    const rows = this.store.queryBindings(`
      SELECT ?team ?owner ?pub ?pod WHERE {
        ?team a <${P}FederatedTeam> ;
              <${P}ownerId> ?owner ;
              <${P}enabled> "true"^^<${XSD}boolean> ;
              <${P}publishedAt> ?pub .
        OPTIONAL { ?team <${P}podUrl> ?pod }
      }
    `);
    return rows.map((r: any) => ({
      teamSlug: decodeURIComponent(r.get("team")!.value.replace("urn:porter:ap:team/", "")),
      ownerId: r.get("owner")!.value,
      publishedAt: r.get("pub")!.value,
      ...(r.get("pod")?.value ? { podUrl: r.get("pod")!.value } : {}),
    }));
  }

  listAllPublished(): Array<{ teamSlug: string; ownerId: string; publishedAt: string; enabled: boolean }> {
    const rows = this.store.queryBindings(`
      SELECT ?team ?owner ?pub ?en WHERE {
        ?team a <${P}FederatedTeam> ;
              <${P}ownerId> ?owner ;
              <${P}publishedAt> ?pub ;
              <${P}enabled> ?en .
      }
    `);
    return rows.map((r: any) => ({
      teamSlug: decodeURIComponent(r.get("team")!.value.replace("urn:porter:ap:team/", "")),
      ownerId: r.get("owner")!.value,
      publishedAt: r.get("pub")!.value,
      enabled: r.get("en")!.value === "true",
    }));
  }

  // ---------------------------------------------------------------------------
  // Followers
  // ---------------------------------------------------------------------------

  async getFollowers(slug: string): Promise<FollowerRecord[]> {
    const team = teamUri(slug);
    const rows = this.store.queryBindings(`
      SELECT ?actor ?acct ?inbox ?shared ?at ?approved WHERE {
        ?f a <${P}Follower> ;
           <${P}team> <${team}> ;
           <${AS}actor> ?actor ;
           <${P}acct> ?acct ;
           <${AS}inbox> ?inbox ;
           <${P}approved> ?approved ;
           <${P}followedAt> ?at .
        OPTIONAL { ?f <${P}sharedInbox> ?shared }
      }
    `);
    return rows.map((r: any) => ({
      actorId: r.get("actor")!.value,
      acct: r.get("acct")!.value,
      inbox: r.get("inbox")!.value,
      sharedInbox: r.get("shared")?.value,
      followedAt: r.get("at")!.value,
      approved: r.get("approved")!.value === "true",
    }));
  }

  async addFollower(slug: string, follower: FollowerRecord): Promise<void> {
    const uri = followerUri(slug, follower.actorId);
    const team = teamUri(slug);
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    let triples = `
      <${uri}> <${RDF}type> <${P}Follower> .
      <${uri}> <${P}team> <${team}> .
      <${uri}> <${AS}actor> "${esc(follower.actorId)}" .
      <${uri}> <${P}acct> "${esc(follower.acct)}" .
      <${uri}> <${AS}inbox> "${esc(follower.inbox)}" .
      <${uri}> <${P}approved> "${follower.approved}"^^<${XSD}boolean> .
      <${uri}> <${P}followedAt> "${follower.followedAt}" .
    `;
    if (follower.sharedInbox) {
      triples += `<${uri}> <${P}sharedInbox> "${esc(follower.sharedInbox)}" .\n`;
    }
    this.store.update(`INSERT DATA { ${triples} }`);
    await this.flush();
  }

  async removeFollower(slug: string, actorId: string): Promise<void> {
    const uri = followerUri(slug, actorId);
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    await this.flush();
  }

  async updateFollower(slug: string, actorId: string, update: Partial<FollowerRecord>): Promise<void> {
    const existing = await this.getFollowers(slug);
    const record = existing.find((f) => f.actorId === actorId);
    if (!record) return;
    await this.addFollower(slug, { ...record, ...update });
  }

  // ---------------------------------------------------------------------------
  // Pending follows
  // ---------------------------------------------------------------------------

  async getPendingFollows(slug: string): Promise<PendingFollow[]> {
    const team = teamUri(slug);
    const rows = this.store.queryBindings(`
      SELECT ?actor ?acct ?inbox ?shared ?at ?fid WHERE {
        ?f a <${P}PendingFollow> ;
           <${P}team> <${team}> ;
           <${AS}actor> ?actor ;
           <${P}acct> ?acct ;
           <${AS}inbox> ?inbox ;
           <${P}receivedAt> ?at ;
           <${P}followActivityId> ?fid .
        OPTIONAL { ?f <${P}sharedInbox> ?shared }
      }
    `);
    return rows.map((r: any) => ({
      actorId: r.get("actor")!.value,
      acct: r.get("acct")!.value,
      inbox: r.get("inbox")!.value,
      sharedInbox: r.get("shared")?.value,
      receivedAt: r.get("at")!.value,
      followActivityId: r.get("fid")!.value,
    }));
  }

  async addPendingFollow(slug: string, pending: PendingFollow): Promise<void> {
    const uri = pendingUri(slug, pending.actorId);
    const team = teamUri(slug);
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    let triples = `
      <${uri}> <${RDF}type> <${P}PendingFollow> .
      <${uri}> <${P}team> <${team}> .
      <${uri}> <${AS}actor> "${esc(pending.actorId)}" .
      <${uri}> <${P}acct> "${esc(pending.acct)}" .
      <${uri}> <${AS}inbox> "${esc(pending.inbox)}" .
      <${uri}> <${P}receivedAt> "${pending.receivedAt}" .
      <${uri}> <${P}followActivityId> "${esc(pending.followActivityId)}" .
    `;
    if (pending.sharedInbox) {
      triples += `<${uri}> <${P}sharedInbox> "${esc(pending.sharedInbox)}" .\n`;
    }
    this.store.update(`INSERT DATA { ${triples} }`);
    await this.flush();
  }

  async removePendingFollow(slug: string, actorId: string): Promise<void> {
    const uri = pendingUri(slug, actorId);
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  async getConversations(slug: string): Promise<ConversationMap[]> {
    const team = teamUri(slug);
    const rows = this.store.queryBindings(`
      SELECT ?cid ?remote ?session ?created ?last WHERE {
        ?c a <${P}Conversation> ;
           <${P}team> <${team}> ;
           <${P}apConversationId> ?cid ;
           <${P}remoteActorId> ?remote ;
           <${P}sessionName> ?session ;
           <${P}createdAt> ?created ;
           <${P}lastActivityAt> ?last .
      }
    `);
    return rows.map((r: any) => ({
      apConversationId: r.get("cid")!.value,
      remoteActorId: r.get("remote")!.value,
      sessionName: r.get("session")!.value,
      createdAt: r.get("created")!.value,
      lastActivityAt: r.get("last")!.value,
    }));
  }

  async saveConversation(slug: string, conv: ConversationMap): Promise<void> {
    const uri = convUri(slug, conv.apConversationId);
    const team = teamUri(slug);
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    this.store.update(`INSERT DATA {
      <${uri}> <${RDF}type> <${P}Conversation> .
      <${uri}> <${P}team> <${team}> .
      <${uri}> <${P}apConversationId> "${esc(conv.apConversationId)}" .
      <${uri}> <${P}remoteActorId> "${esc(conv.remoteActorId)}" .
      <${uri}> <${P}sessionName> "${esc(conv.sessionName)}" .
      <${uri}> <${P}createdAt> "${conv.createdAt}" .
      <${uri}> <${P}lastActivityAt> "${conv.lastActivityAt}" .
    }`);
    await this.flush();
  }

  async removeConversation(slug: string, apConversationId: string): Promise<void> {
    const uri = convUri(slug, apConversationId);
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  getKeyPems(slug: string): { publicPem: string; privatePem: string } | null {
    const uri = `urn:porter:ap:keys/${encodeURIComponent(slug)}`;
    const rows = this.store.queryBindings(`
      SELECT ?pub ?priv WHERE {
        <${uri}> <${P}publicKeyPem> ?pub ;
                 <${P}privateKeyPem> ?priv .
      }
    `);
    if (!rows.length) return null;
    return {
      publicPem: rows[0].get("pub")!.value,
      privatePem: rows[0].get("priv")!.value,
    };
  }

  async storeKeyPems(slug: string, publicPem: string, privatePem: string): Promise<void> {
    const uri = `urn:porter:ap:keys/${encodeURIComponent(slug)}`;
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    this.store.update(`INSERT DATA {
      <${uri}> <${RDF}type> <${P}KeyPair> .
      <${uri}> <${P}publicKeyPem> "${esc(publicPem)}" .
      <${uri}> <${P}privateKeyPem> "${esc(privatePem)}" .
    }`);
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  getConfig(): ActivityPubConfig | null {
    const uri = "urn:porter:ap:config";
    const rows = this.store.queryBindings(`
      SELECT ?domain ?mode ?pub ?max WHERE {
        <${uri}> a <${P}ApConfig> ;
                 <${P}domain> ?domain ;
                 <${P}approvalMode> ?mode .
        OPTIONAL { <${uri}> <${P}publicSummaries> ?pub }
        OPTIONAL { <${uri}> <${P}maxSessionsPerFollower> ?max }
      }
    `);
    if (!rows.length) return null;
    const r = rows[0];
    const allowlistRows = this.store.queryBindings(`
      SELECT ?val WHERE { ?e a <${P}AllowlistEntry> ; <${P}value> ?val }
    `);
    return {
      enabled: true,
      domain: r.get("domain")!.value,
      approval_mode: r.get("mode")!.value as "open" | "allowlist" | "manual",
      public_summaries: r.get("pub")?.value === "true",
      max_sessions_per_follower: parseInt(r.get("max")?.value ?? "1", 10),
      allowlist: allowlistRows.map((row: any) => row.get("val")!.value),
    };
  }

  async saveConfig(config: ActivityPubConfig): Promise<void> {
    const uri = "urn:porter:ap:config";
    this.store.update(`DELETE { <${uri}> ?p ?o } WHERE { <${uri}> ?p ?o }`);
    this.store.update(`DELETE { ?e ?p ?o } WHERE { ?e a <${P}AllowlistEntry> ; ?p ?o }`);
    this.store.update(`INSERT DATA {
      <${uri}> <${RDF}type> <${P}ApConfig> .
      <${uri}> <${P}domain> "${esc(config.domain)}" .
      <${uri}> <${P}approvalMode> "${config.approval_mode ?? "manual"}" .
      <${uri}> <${P}publicSummaries> "${config.public_summaries ?? false}"^^<${XSD}boolean> .
      <${uri}> <${P}maxSessionsPerFollower> "${config.max_sessions_per_follower ?? 1}"^^<${XSD}integer> .
    }`);
    for (const entry of config.allowlist ?? []) {
      const eUri = `urn:porter:ap:allowlist/${encodeURIComponent(entry)}`;
      this.store.update(`INSERT DATA {
        <${eUri}> <${RDF}type> <${P}AllowlistEntry> .
        <${eUri}> <${P}value> "${esc(entry)}" .
      }`);
    }
    await this.flush();
  }
}
