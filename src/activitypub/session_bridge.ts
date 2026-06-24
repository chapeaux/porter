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
import { getPattern } from "../orchestration/pattern_registry.ts";

// ---------------------------------------------------------------------------
// Parsed message types
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  type: "command" | "chat" | "subscription" | "info";
  command?: string;
  /** Channel name for subscription commands (normalized). */
  subscriptionChannel?: string;
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
// Channel name normalization for subscriptions
// ---------------------------------------------------------------------------

const CHANNEL_MAP: Record<string, string> = {
  log: "log",
  logs: "log",
  activity: "activity",
  all: "activity",
  task: "task",
  tasks: "task",
  errors: "activity:errors",
  review: "review",
};

/** Reserved hashtag commands that must be matched before agent/role routing. */
const RESERVED_HASHTAGS = new Set([
  "follow",
  "unfollow",
  "subscriptions",
  "help",
  "who",
  "roster",
]);

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

  // --- Reserved hashtag commands (priority: before agent/role matching) ---
  for (const ht of hashtagNames) {
    const lower = ht.toLowerCase();

    if (lower === "follow") {
      // Look for the channel hashtag: #follow #channelname
      const channelHt = hashtagNames.find(
        (h) => h.toLowerCase() !== "follow" && h.toLowerCase() !== "unfollow",
      );
      const channelKey = channelHt?.toLowerCase() ?? "";
      const normalized = CHANNEL_MAP[channelKey] ?? channelKey;
      return {
        type: "subscription",
        command: "#follow",
        subscriptionChannel: normalized,
        content: trimmed,
      };
    }

    if (lower === "unfollow") {
      const channelHt = hashtagNames.find(
        (h) => h.toLowerCase() !== "follow" && h.toLowerCase() !== "unfollow",
      );
      const channelKey = channelHt?.toLowerCase() ?? "";
      const normalized = CHANNEL_MAP[channelKey] ?? channelKey;
      return {
        type: "subscription",
        command: "#unfollow",
        subscriptionChannel: normalized,
        content: trimmed,
      };
    }

    if (lower === "subscriptions") {
      return {
        type: "subscription",
        command: "#subscriptions",
        content: trimmed,
      };
    }

    if (lower === "help") {
      return {
        type: "info",
        command: "#help",
        content: trimmed,
      };
    }

    if (lower === "who" || lower === "roster") {
      return {
        type: "info",
        command: "#who",
        content: trimmed,
      };
    }
  }

  // --- Match hashtags against agents, then roles ---
  const agentNameSet = new Map(
    agents.map((a) => [a.name.toLowerCase(), a.name]),
  );

  for (const ht of hashtagNames) {
    const lower = ht.toLowerCase();

    // Skip reserved hashtags (already handled above)
    if (RESERVED_HASHTAGS.has(lower)) continue;

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

  // 6. Handle by message type
  if (parsed.type === "command") {
    return handleCommand(parsed, conversationId, acct, fromActorId, ctx);
  }

  if (parsed.type === "subscription") {
    return handleSubscription(parsed, conversationId, ctx);
  }

  if (parsed.type === "info") {
    return handleInfo(parsed, conversationId, agents, ctx);
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
      // Check for existing session — verify it's actually still running
      const existing = await findConversation(
        ctx.store,
        ctx.teamSlug,
        conversationId,
      );
      if (existing) {
        try {
          const handle = await conversationToHandle(existing, ctx.teamSlug, ctx);
          const status = await ctx.backend.getSessionStatus(handle);
          if (status?.running) {
            return {
              replyText: "A session is already active for this conversation. Use /stop to end it first.",
              handled: true,
            };
          }
        } catch { /* session gone */ }
        // Stale mapping — clean up and proceed
        await ctx.store.removeConversation(ctx.teamSlug, conversationId);
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
        console.error(`[bridge] Session created: ${sessionName}`);
      } catch (err) {
        console.error(`[bridge] createSession failed: ${(err as Error).message} — assuming existing session`);
        sessionName = ctx.teamSlug;
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

      const handle = await conversationToHandle(conv, ctx.teamSlug, ctx);
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

      const handle = await conversationToHandle(conv, ctx.teamSlug, ctx);
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
// Subscription handling
// ---------------------------------------------------------------------------

async function handleSubscription(
  parsed: ParsedMessage,
  conversationId: string,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const conv = await findConversation(
    ctx.store,
    ctx.teamSlug,
    conversationId,
  );

  if (!conv) {
    return {
      replyText:
        "No active session. Send /start to begin a session first.",
      handled: true,
    };
  }

  const subs = conv.subscriptions ?? [];

  switch (parsed.command) {
    case "#follow": {
      const channel = parsed.subscriptionChannel ?? "";
      if (!channel) {
        return {
          replyText:
            "Usage: #follow #channelname\nAvailable channels: logs, activity, errors, tasks, review",
          handled: true,
        };
      }
      if (subs.includes(channel)) {
        return {
          replyText: `Already subscribed to "${channel}".`,
          handled: true,
        };
      }
      const updated = [...subs, channel];
      await ctx.store.saveConversation(ctx.teamSlug, {
        ...conv,
        subscriptions: updated,
        lastActivityAt: new Date().toISOString(),
      });
      return {
        replyText: `Subscribed to "${channel}". You will now receive updates from this channel.`,
        handled: true,
      };
    }

    case "#unfollow": {
      const channel = parsed.subscriptionChannel ?? "";
      if (!channel) {
        return {
          replyText: "Usage: #unfollow #channelname",
          handled: true,
        };
      }
      if (!subs.includes(channel)) {
        return {
          replyText: `Not subscribed to "${channel}".`,
          handled: true,
        };
      }
      const updated = subs.filter((s) => s !== channel);
      await ctx.store.saveConversation(ctx.teamSlug, {
        ...conv,
        subscriptions: updated,
        lastActivityAt: new Date().toISOString(),
      });
      return {
        replyText: `Unsubscribed from "${channel}".`,
        handled: true,
      };
    }

    case "#subscriptions": {
      if (subs.length === 0) {
        return {
          replyText:
            "No active subscriptions. Use #follow #channelname to subscribe.",
          handled: true,
        };
      }
      const list = subs.map((s) => `  - ${s}`).join("\n");
      return {
        replyText: `Current subscriptions:\n${list}`,
        handled: true,
      };
    }

    default:
      return { replyText: null, handled: false };
  }
}

// ---------------------------------------------------------------------------
// Info handling
// ---------------------------------------------------------------------------

async function handleInfo(
  parsed: ParsedMessage,
  conversationId: string,
  agents: Array<{ name: string; role: string }>,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  switch (parsed.command) {
    case "#help": {
      return {
        replyText: buildHelpMessage(agents),
        handled: true,
      };
    }

    case "#who": {
      const conv = await findConversation(
        ctx.store,
        ctx.teamSlug,
        conversationId,
      );

      if (!conv) {
        // No active session — just show the configured roster
        if (agents.length === 0) {
          return { replyText: "No agents configured.", handled: true };
        }
        const patternId = ctx.team.config.pattern;
        const pattern = patternId ? getPattern(patternId) : null;
        const header = pattern
          ? `Team: ${ctx.team.name} (${pattern.name} pattern)`
          : `Team: ${ctx.team.name}`;
        const lines = agents.map((a) => {
          const patternRole = pattern?.roles.find((r) => r.id === a.role);
          const roleName = patternRole ? patternRole.name : a.role;
          return `  ${a.name} — ${roleName}`;
        });
        return {
          replyText: `${header}\nAgents:\n${lines.join("\n")}`,
          handled: true,
        };
      }

      // Try to get live session status
      const handle = await conversationToHandle(conv, ctx.teamSlug, ctx);
      const status = await ctx.backend.getSessionStatus(handle);

      if (!status) {
        const patternId = ctx.team.config.pattern;
        const pattern = patternId ? getPattern(patternId) : null;
        const header = pattern
          ? `Team: ${ctx.team.name} (${pattern.name} pattern)`
          : `Team: ${ctx.team.name}`;
        const lines = agents.map((a) => {
          const patternRole = pattern?.roles.find((r) => r.id === a.role);
          const roleName = patternRole ? patternRole.name : a.role;
          return `  ${a.name} — ${roleName}`;
        });
        return {
          replyText: `${header}\nAgents:\n${lines.join("\n")}\nSession status: unknown`,
          handled: true,
        };
      }

      const patternId = ctx.team.config.pattern;
      const pattern = patternId ? getPattern(patternId) : null;
      const runningLabel = status.running ? "running" : "stopped";
      const header = pattern
        ? `Team: ${ctx.team.name} (${pattern.name} pattern, ${runningLabel})`
        : `Team: ${ctx.team.name} (${runningLabel}, ${status.agentCount} agents)`;
      const lines = agents.map((a) => {
        const patternRole = pattern?.roles.find((r) => r.id === a.role);
        const roleName = patternRole ? patternRole.name : a.role;
        return `  ${a.name} — ${roleName}`;
      });
      return {
        replyText: `${header}\nAgents:\n${lines.join("\n")}`,
        handled: true,
      };
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
  const handle = await conversationToHandle(conv, ctx.teamSlug, ctx);
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
// Relay logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a message on the given channel should be relayed
 * to a fediverse user based on their subscriptions and recent activity.
 */
export function shouldRelay(
  channel: string,
  content: string,
  subscriptions: string[],
  recentApReply: boolean,
): boolean {
  // If this is the activity channel and the user just sent a reply,
  // suppress relay to avoid echo
  if (channel === "activity" && recentApReply) {
    return false;
  }

  // If subscribed to activity:errors and channel is activity,
  // only relay error/retry content
  if (
    subscriptions.includes("activity:errors") &&
    channel === "activity"
  ) {
    const lower = content.toLowerCase();
    return lower.includes("error") || lower.includes("retrying");
  }

  // Direct channel match against subscriptions
  if (subscriptions.includes(channel)) {
    return true;
  }

  // Default safety net: relay activity text events when no subscriptions
  // and no recent AP reply
  if (subscriptions.length === 0 && !recentApReply && channel === "activity") {
    return true;
  }

  return false;
}

/**
 * Format a relay message for delivery to a fediverse user.
 *
 * Format: `[channel] from: content`
 * For task channel with routing arrows: `[task] planner -> coder: implement fix`
 */
export function formatRelayMessage(
  channel: string,
  from: string,
  content: string,
): string {
  return `[${channel}] ${from}: ${content}`;
}

// ---------------------------------------------------------------------------
// AP system prompt suffix
// ---------------------------------------------------------------------------

/**
 * Build a system prompt suffix for agents operating in an AP-bridged session.
 */
export function buildApSystemPromptSuffix(): string {
  return `\n\nYou are communicating with a fediverse user via ActivityPub DMs.\nUse the ap_reply tool to respond directly to the user with your findings and results.\nUse ap_post to share notable findings with the team's followers.\nThe user does not see your internal tool calls or inter-agent messages unless they explicitly subscribe to those channels.`;
}

// ---------------------------------------------------------------------------
// Help message
// ---------------------------------------------------------------------------

/**
 * Build the full hashtag/command reference text.
 */
export function buildHelpMessage(
  agents: Array<{ name: string; role: string }>,
): string {
  const agentLines = agents.map((a) => `  #${a.name} (${a.role})`).join("\n");
  const agentSection = agents.length > 0
    ? `\nAgents:\n${agentLines}\n`
    : "";

  return [
    "Commands:",
    "  /start, /stop, /status, /teams",
    "",
    "Addressing:",
    "  #agentname message → routes to that agent",
    "  #role message → routes to all agents with that role",
    "  No hashtag → broadcast to team",
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
    agentSection,
  ].join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Relay message aggregation (flood batching)
// ---------------------------------------------------------------------------

/**
 * Aggregate multiple relay messages into a single batched text,
 * grouped by channel and truncated to maxLength.
 */
export function aggregateRelayMessages(
  messages: Array<{ channel: string; from: string; content: string }>,
  maxLength: number = 500,
): string {
  if (messages.length === 0) return "";

  // Group messages by channel
  const groups = new Map<string, Array<{ from: string; content: string }>>();
  for (const msg of messages) {
    let group = groups.get(msg.channel);
    if (!group) {
      group = [];
      groups.set(msg.channel, group);
    }
    group.push({ from: msg.from, content: msg.content });
  }

  const parts: string[] = [];
  let totalShown = 0;
  const totalMessages = messages.length;

  for (const [channel, items] of groups) {
    for (const item of items) {
      if (totalShown >= 5) break;
      parts.push(formatRelayMessage(channel, item.from, item.content));
      totalShown++;
    }
    if (totalShown >= 5) break;
  }

  let result = parts.join("\n");

  if (totalMessages > 5) {
    result += `\n(and ${totalMessages - 5} more...)`;
  }

  if (result.length > maxLength) {
    result = result.slice(0, maxLength - 1) + "…";
  }

  return result;
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
async function conversationToHandle(
  conv: ConversationMap,
  teamSlug: string,
  ctx: BridgeContext,
): Promise<SessionHandle> {
  const ownerId = await ctx.backend.resolveTeamOwner(teamSlug);
  let podUrl: string | undefined;
  if (ownerId) {
    try {
      const pod = await (ctx.backend as any).ensurePod(ownerId);
      podUrl = pod.podUrl;
    } catch { /* best effort */ }
  }
  return {
    sessionName: conv.sessionName,
    ownerId: conv.remoteActorId,
    teamSlug,
    podUrl,
  };
}
