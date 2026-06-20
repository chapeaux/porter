/**
 * DM-to-session bridge for ActivityPub federation.
 *
 * Translates incoming fediverse DMs into Porter session operations:
 * parsing commands and hashtag routing, creating/stopping sessions,
 * forwarding chat messages to the bus, and aggregating agent output.
 */

import type { APObject, APTag } from "./types.ts";
import type { ActivityPubConfig } from "./config.ts";
import type { ConversationMap, FederationStore } from "./store.ts";
import type { ActivityPubBackend, SessionHandle } from "./backend.ts";
import { buildWelcomeMessage } from "./actor.ts";
import type { SavedTeam } from "../auth/user_store.ts";

// ---------------------------------------------------------------------------
// Parsed message types
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  type: "command" | "chat";
  command?: "/start" | "/stop" | "/status" | "/teams" | "/list";
  /** Target agent name (from #agentname hashtag). */
  targetAgent?: string;
  /** Target role (from #role hashtag, when it matches a role not an agent name). */
  targetRole?: string;
  /** The actual message content (with hashtag stripped if used for routing). */
  content: string;
}

// ---------------------------------------------------------------------------
// Bridge context and response
// ---------------------------------------------------------------------------

export interface BridgeContext {
  teamSlug: string;
  config: ActivityPubConfig;
  store: FederationStore;
  backend: ActivityPubBackend;
  team: SavedTeam;
}

export interface BridgeResponse {
  /** Text to reply with (will be sent as a DM back to the user). */
  replyText: string | null;
  /** Whether this was handled (false if no active session and not a command). */
  handled: boolean;
}

// ---------------------------------------------------------------------------
// Valid commands
// ---------------------------------------------------------------------------

const COMMANDS = new Set(["/start", "/stop", "/status", "/teams", "/list"]);

// ---------------------------------------------------------------------------
// Known roles for hashtag routing
// ---------------------------------------------------------------------------

const KNOWN_ROLES = new Set(["admin", "worker", "reviewer"]);

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

/**
 * Parse incoming DM content for commands and hashtag routing.
 *
 * - If text starts with `/`, parse as a command.
 * - For hashtag routing: check AP `tags` array for `type: "Hashtag"` entries,
 *   then fall back to regex on the text.
 * - Match hashtags against agent names first (case-insensitive exact match),
 *   then against roles.
 * - If a hashtag matches, strip it from the message content and set
 *   targetAgent or targetRole.
 */
export function parseMessage(
  text: string,
  tags: APTag[] | undefined,
  agents: Array<{ name: string; role: string }>,
): ParsedMessage {
  const trimmed = text.trim();

  // --- Command detection ---
  if (trimmed.startsWith("/")) {
    const firstWord = trimmed.split(/\s/)[0].toLowerCase();
    if (COMMANDS.has(firstWord)) {
      return {
        type: "command",
        command: firstWord as ParsedMessage["command"],
        content: trimmed.slice(firstWord.length).trim(),
      };
    }
  }

  // --- Hashtag extraction ---
  // Collect hashtag names from the AP tags array first
  const hashtagNames: string[] = [];
  if (tags) {
    for (const tag of tags) {
      if (tag.type === "Hashtag" && tag.name) {
        // AP tags have names like "#foo" — strip the leading #
        const name = tag.name.startsWith("#")
          ? tag.name.slice(1)
          : tag.name;
        if (name) hashtagNames.push(name);
      }
    }
  }

  // Fall back to regex on the text if no AP tags found
  if (hashtagNames.length === 0) {
    const matches = trimmed.matchAll(/#(\w+)/g);
    for (const m of matches) {
      hashtagNames.push(m[1]);
    }
  }

  // --- Match hashtags against agents, then roles ---
  const agentNameSet = new Map(
    agents.map((a) => [a.name.toLowerCase(), a.name]),
  );

  for (const ht of hashtagNames) {
    const lower = ht.toLowerCase();

    // Check agent names first
    if (agentNameSet.has(lower)) {
      return {
        type: "chat",
        targetAgent: agentNameSet.get(lower)!,
        content: stripHashtag(trimmed, ht),
      };
    }

    // Check roles
    if (KNOWN_ROLES.has(lower)) {
      return {
        type: "chat",
        targetRole: lower,
        content: stripHashtag(trimmed, ht),
      };
    }
  }

  // No matching hashtag — pass through as broadcast
  return {
    type: "chat",
    content: trimmed,
  };
}

/** Remove the first occurrence of `#tag` from the text and clean up whitespace. */
function stripHashtag(text: string, tag: string): string {
  // Match the hashtag with optional surrounding whitespace
  return text
    .replace(new RegExp(`#${escapeRegex(tag)}\\b`, "i"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// resolveChannels
// ---------------------------------------------------------------------------

/**
 * Determine the bus channel(s) to publish to based on the parsed message.
 */
export function resolveChannels(
  parsed: ParsedMessage,
  agents: Array<{ name: string; role: string }>,
): string[] {
  if (parsed.targetAgent) {
    return [`task:${parsed.targetAgent}`];
  }

  if (parsed.targetRole) {
    return agents
      .filter((a) => a.role.toLowerCase() === parsed.targetRole)
      .map((a) => `task:${a.name}`);
  }

  // Broadcast
  return ["task"];
}

// ---------------------------------------------------------------------------
// handleDirectMessage
// ---------------------------------------------------------------------------

/**
 * Handle an incoming ActivityPub DM.
 *
 * Parses the note for commands and routing, then either executes a
 * session lifecycle command or forwards the message to the bus.
 */
export async function handleDirectMessage(
  note: APObject,
  fromActorId: string,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  // 1. Strip HTML tags from note content for parsing
  const rawContent = note.content ?? "";
  const plainText = rawContent.replace(/<[^>]*>/g, "").trim();

  if (!plainText) {
    return { replyText: null, handled: false };
  }

  // 2. Get agent roster
  const agents = (ctx.team.config.agents ?? []).map((a) => ({
    name: a.name,
    role: a.role,
  }));

  // 3. Parse the message
  const parsed = parseMessage(plainText, note.tag, agents);

  // 4. Derive conversation ID — use actor ID as stable key so all messages
  // from the same user map to the same session (note.id differs per message)
  const conversationId =
    note.conversation ?? fromActorId;

  // 5. Build fedi identity
  const acct = extractAcct(fromActorId);

  // 6. Handle commands vs chat
  if (parsed.type === "command") {
    return handleCommand(parsed, conversationId, acct, fromActorId, ctx);
  }

  return handleChat(parsed, conversationId, acct, ctx);
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

async function handleCommand(
  parsed: ParsedMessage,
  conversationId: string,
  acct: string,
  fromActorId: string,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  switch (parsed.command) {
    case "/teams":
    case "/list": {
      const teams = await ctx.backend.listFederatedTeams();
      if (teams.length === 0) {
        return {
          replyText: "No federated teams available.",
          handled: true,
        };
      }
      const lines = teams.map((t) => `- ${t.teamSlug}`);
      return {
        replyText: `Available teams:\n${lines.join("\n")}`,
        handled: true,
      };
    }

    case "/start": {
      // Check for existing session
      const existing = await findConversation(
        ctx.store,
        ctx.teamSlug,
        conversationId,
      );
      if (existing) {
        return {
          replyText: "A session is already active for this conversation. Use /stop to end it first.",
          handled: true,
        };
      }

      // Resolve team owner
      const ownerId = await ctx.backend.resolveTeamOwner(ctx.teamSlug);
      if (!ownerId) {
        return {
          replyText: `Team "${ctx.teamSlug}" has no owner configured.`,
          handled: true,
        };
      }

      // Create session (or reuse existing if 409)
      let sessionName: string;
      try {
        const handle = await ctx.backend.createSession(ownerId, ctx.teamSlug);
        sessionName = handle.sessionName;
      } catch {
        sessionName = `ap-${ctx.teamSlug}-reattach`;
      }

      // Save conversation mapping
      const now = new Date().toISOString();
      await ctx.store.saveConversation(ctx.teamSlug, {
        apConversationId: conversationId,
        remoteActorId: fromActorId,
        sessionName,
        createdAt: now,
        lastActivityAt: now,
      });

      const welcome = buildWelcomeMessage(ctx.team);
      return { replyText: welcome, handled: true };
    }

    case "/stop": {
      const conv = await findConversation(
        ctx.store,
        ctx.teamSlug,
        conversationId,
      );
      if (!conv) {
        return {
          replyText: "No active session for this conversation.",
          handled: true,
        };
      }

      const handle = conversationToHandle(conv, ctx.teamSlug);
      await ctx.backend.stopSession(handle);
      await ctx.store.removeConversation(ctx.teamSlug, conversationId);

      return {
        replyText: `Session "${conv.sessionName}" stopped.`,
        handled: true,
      };
    }

    case "/status": {
      const conv = await findConversation(
        ctx.store,
        ctx.teamSlug,
        conversationId,
      );
      if (!conv) {
        return {
          replyText: "No active session for this conversation.",
          handled: true,
        };
      }

      const handle = conversationToHandle(conv, ctx.teamSlug);
      const status = await ctx.backend.getSessionStatus(handle);

      if (!status) {
        return {
          replyText: `Session "${conv.sessionName}" — unable to retrieve status.`,
          handled: true,
        };
      }

      const lines: string[] = [
        `Session: ${status.sessionName}`,
        `Running: ${status.running ? "yes" : "no"}`,
        `Agents: ${status.agentCount}`,
      ];

      if (status.uptime !== undefined) {
        const mins = Math.floor(status.uptime / 60_000);
        lines.push(`Uptime: ${mins}m`);
      }

      if (status.metrics) {
        lines.push(
          `Tokens: ${status.metrics.inputTokens} in / ${status.metrics.outputTokens} out`,
          `Tool calls: ${status.metrics.toolCalls}`,
          `API calls: ${status.metrics.apiCalls}`,
        );
      }

      return { replyText: lines.join("\n"), handled: true };
    }

    default:
      return { replyText: null, handled: false };
  }
}

// ---------------------------------------------------------------------------
// Chat handling
// ---------------------------------------------------------------------------

async function handleChat(
  parsed: ParsedMessage,
  conversationId: string,
  acct: string,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  // Look up active session
  const conv = await findConversation(
    ctx.store,
    ctx.teamSlug,
    conversationId,
  );

  if (!conv) {
    return {
      replyText:
        "No active session. Send /start to begin a session, or /teams to see available teams.",
      handled: false,
    };
  }

  // Resolve bus channels
  const agents = (ctx.team.config.agents ?? []).map((a) => ({
    name: a.name,
    role: a.role,
  }));
  const channels = resolveChannels(parsed, agents);

  // Build the session handle
  const handle = conversationToHandle(conv, ctx.teamSlug);
  const from = `fedi:${acct}`;

  // Send to each resolved channel
  for (const channel of channels) {
    await ctx.backend.sendMessage(handle, channel, parsed.content, from);
  }

  // Update lastActivityAt
  await ctx.store.saveConversation(ctx.teamSlug, {
    ...conv,
    lastActivityAt: new Date().toISOString(),
  });

  // No synchronous reply — agent output is delivered asynchronously
  return { replyText: null, handled: true };
}

// ---------------------------------------------------------------------------
// aggregateResponse
// ---------------------------------------------------------------------------

/** Default max length for Mastodon posts. */
const MASTODON_MAX_LENGTH = 500;

/**
 * Aggregate text from agent output events into a single reply.
 *
 * Combines multiple text events, truncates to maxLength, and formats
 * for Mastodon-compatible HTML.
 */
export function aggregateResponse(
  texts: string[],
  maxLength: number = MASTODON_MAX_LENGTH,
): string {
  let combined = texts.join("\n");

  if (combined.length > maxLength) {
    combined = combined.slice(0, maxLength - 1) + "…";
  }

  // Wrap in <p> tags for HTML formatting, converting newlines to <br>
  const htmlContent = combined
    .split("\n")
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");

  return htmlContent;
}

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract an acct-style identifier from an actor URL.
 *
 * e.g. "https://mastodon.social/users/alice" -> "alice@mastodon.social"
 */
function extractAcct(actorUrl: string): string {
  try {
    const url = new URL(actorUrl);
    // Common Mastodon pattern: /users/{username}
    const parts = url.pathname.split("/").filter(Boolean);
    const username = parts[parts.length - 1] ?? "unknown";
    return `${username}@${url.hostname}`;
  } catch {
    return actorUrl;
  }
}

/** Find a conversation mapping by AP conversation ID. */
async function findConversation(
  store: FederationStore,
  teamSlug: string,
  apConversationId: string,
): Promise<ConversationMap | undefined> {
  const convs = await store.getConversations(teamSlug);
  return convs.find((c) => c.apConversationId === apConversationId);
}

/** Build a minimal SessionHandle from a ConversationMap. */
function conversationToHandle(
  conv: ConversationMap,
  teamSlug: string,
): SessionHandle {
  return {
    sessionName: conv.sessionName,
    ownerId: conv.remoteActorId,
    teamSlug,
  };
}
