/**
 * Agent runtime -- the core loop that drives an AI agent via a
 * provider-neutral ModelProvider interface.
 *
 * Each agent is an async function: send messages, handle tool_use,
 * execute tools, return results, repeat until end_turn.
 */

import type {
  ChatMessage,
  ContentBlock,
  ModelProvider,
  ToolDefinition,
  ToolResultBlock,
} from "../providers/mod.ts";
import { ProviderError } from "../providers/mod.ts";
import { parseToolCalls } from "../providers/tool_shim.ts";
import type { AgentConfig } from "../core/config.ts";
import {
  buildRegistry,
  ToolRegistry,
  type ToolEntry,
  type ToolResult,
} from "../tools/mod.ts";
import { getBus } from "./bus.ts";
import { getCoordinator, RateLimitCoordinator } from "./rate_limiter.ts";

/**
 * Filter a tool registry based on agent role.
 * Admin agents only get messaging and memory tools.
 * Worker and reviewer agents get all tools.
 */
export function applyRoleFilter(
  registry: ToolRegistry,
  role: string,
): ToolRegistry {
  const allowedByRole: Record<string, Set<string>> = {
    admin: new Set(["send_message", "read_messages", "memory_write", "memory_query"]),
  };
  const allowed = allowedByRole[role];
  if (!allowed || allowed.size === 0) return registry;

  const filtered = new ToolRegistry();
  for (const name of registry.names()) {
    if (allowed.has(name)) {
      filtered.addTool(name, registry.get(name)!);
    }
  }
  return filtered;
}

/** Token usage stats for an agent. */
export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Callback for streaming agent activity to a display. */
export type AgentOutputHandler = (
  agentName: string,
  event: AgentEvent,
) => void;

/** Events emitted by the agent loop. */
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; params: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: ToolResult }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "retrying"; message: string; attempt: number; delay: number }
  | { type: "error"; message: string }
  | { type: "done" };

/** Running state of an agent. */
export interface AgentState {
  config: AgentConfig;
  history: ChatMessage[];
  usage: AgentUsage;
  running: boolean;
}

/**
 * Create and run an agent loop.
 *
 * The agent sends its initial prompt to the model API, then loops on
 * tool_use responses until the model returns end_turn or stop_sequence.
 */
/** A shared signal for requesting cancellation from outside the loop. */
export interface CancelSignal {
  cancelled: boolean;
}

export async function runAgent(
  provider: ModelProvider,
  config: AgentConfig,
  initialPrompt: string,
  onOutput?: AgentOutputHandler,
  onHeartbeat?: () => void,
  /** Provide a prior state to resume from a snapshot. */
  resumeFrom?: AgentState,
  /** External cancellation signal. */
  cancel?: CancelSignal,
  /** Pre-loaded MCP tools to inject into the registry. */
  mcpTools?: ToolEntry[],
  /** Other agents in the session, so the system prompt can name teammates. */
  teamRoster?: Array<{ name: string; role: string }>,
): Promise<AgentState> {
  const innerRegistry = await buildRegistry(config.tools);

  // Inject MCP tools into the inner registry
  if (mcpTools) {
    for (const tool of mcpTools) {
      innerRegistry.addTool(tool.definition.name, tool);
    }
  }

  // Apply role-based filtering directly to the inner registry
  const registry = applyRoleFilter(innerRegistry, config.role);

  const model = config.model ?? "ibm-granite/granite-3.3-8b-instruct";

  // Derive a clean directory name from the model ID (e.g. "ibm-granite/granite-4.0-h-small" → "granite-4.0-h-small")
  const modelSlug = model.includes("/") ? model.split("/").pop()! : model;

  // Build system prompt with agent identity
  const systemPrompt = [
    config.system_prompt.replaceAll("{model}", modelSlug),
    `Your agent name is "${config.name}" (role: ${config.role}). Your model is: ${model}. Your model directory name is: ${modelSlug}`,
    config.working_dir
      ? `Your working directory is: ${config.working_dir}\nAll file paths should be relative to or within this directory.`
      : null,
    config.subscribe?.length
      ? `You are subscribed to channels: ${config.subscribe.join(", ")}, and your personal channel: task:${config.name}. Use read_messages to check for incoming messages. Messages on task:${config.name} are addressed specifically to you.`
      : `You have a personal channel: task:${config.name}. Use read_messages to check for incoming messages.`,
    `To send a task to a specific agent, use send_message with channel "task:<agent-name>".`,
    teamRoster?.length
      ? `## Your Team\n${teamRoster.filter(a => a.name !== config.name).map(a => `- ${a.name} (${a.role})`).join("\n")}\nMessages from "porter-ui" come from the human user operating the dashboard. They give you instructions — do not delegate tasks back to them.`
      : `Messages from "porter-ui" come from the human user operating the dashboard. They give you instructions — do not delegate tasks back to them.`,
    `## Messaging
Use send_message to send messages to other agents or channels.
Use read_messages to check for incoming messages.
Channels: 'log' (status updates), 'task' (broadcast to workers), 'task:<agent-name>' (direct to a specific agent), 'review', 'control'.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const state: AgentState = resumeFrom
    ? { ...resumeFrom, running: true }
    : {
        config,
        history: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        running: true,
      };

  // Get the bus (orchestrator already subscribed us to channels
  // including our personal task:<name> channel).
  const bus = getBus();

  // Track whether the agent is actively working vs idle.
  // Fresh agents start idle -- no API call until a bus message arrives.
  // Resumed agents start active since they have conversation history.
  let idle: boolean;

  if (resumeFrom) {
    state.history.push({
      role: "user",
      content: "Session restored from snapshot. Continue where you left off.",
    });
    idle = false;
  } else {
    // Don't push any user message yet -- the first message will come
    // from the bus when someone sends this agent work.
    idle = true;
  }

  let consecutiveToolErrors = 0;

  try {
    while (state.running && !cancel?.cancelled) {
      // If idle, block on bus messages instead of calling the API.
      // No API credits are consumed while waiting.
      if (idle) {
        const bus = getBus();
        const pollInterval = 5_000;

        while (!cancel?.cancelled) {
          await new Promise((r) => setTimeout(r, pollInterval));
          onHeartbeat?.();

          // Process tool control messages before checking for work
          await processToolControlMessages(innerRegistry, config.name);

          const pending = await bus.drain(config.name);
          // Filter out control messages already handled
          const workMessages = pending.filter(m => m.channel !== 'control');
          if (workMessages.length > 0) {
            const formatted = workMessages.map(
              (m) => `[${m.channel}] ${m.from}: ${m.content}`,
            );
            const msgBlock = `New messages received:\n${formatted.join("\n")}`;

            // If this is the very first message (no history yet),
            // include the initial prompt for context.
            if (state.history.length === 0) {
              state.history.push({
                role: "user",
                content: `${initialPrompt}\n\n${msgBlock}`,
              });
            } else {
              state.history.push({
                role: "user",
                content: msgBlock,
              });
            }
            idle = false;
            break;
          }
        }
        // If cancelled while polling, exit
        if (cancel?.cancelled) {
          state.running = false;
          onOutput?.(config.name, { type: "done" });
          break;
        }
        continue;
      }

      // --- Active: make an API call (with retry for transient errors) ---

      const keepalive = onHeartbeat
        ? setInterval(onHeartbeat, 30_000)
        : null;

      // Check for tool augmentation control messages before each API call
      await processToolControlMessages(innerRegistry, config.name);

      const currentToolDefs = registry.getDefinitions();

      let response;
      try {
        response = await callWithRetry(
          () =>
            provider.createMessage({
              model,
              max_tokens: config.max_tokens ?? 8192,
              system: systemPrompt,
              tools: currentToolDefs.length > 0 ? currentToolDefs : undefined,
              messages: state.history,
              reasoning: config.reasoning,
            }),
          config.name,
          onOutput,
          onHeartbeat,
          cancel,
        );
      } finally {
        if (keepalive) clearInterval(keepalive);
      }

      // Track and emit usage
      state.usage.input_tokens += response.usage.input_tokens;
      state.usage.output_tokens += response.usage.output_tokens;
      onOutput?.(config.name, {
        type: "usage",
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      });

      // If the response has no native tool_use blocks, check for text-based
      // tool calls (e.g. <tool_call> XML tags) that some models emit even
      // when tool calling is nominally supported.
      // Always parse text for embedded tool calls — weaker models write
      // tool invocations as text even when they nominally support tool calling
      response = parseToolCalls(response);

      // Process response content blocks
      const toolResults: ToolResultBlock[] = [];
      const autoExtractedResults: string[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          onOutput?.(config.name, { type: "text", content: block.text });

          // Auto-extract bus messages written as [task:AgentName] patterns
          const msgPattern = /\[task:([^\]]+)\]\s*\w+:\s*(.+)/g;
          let match;
          while ((match = msgPattern.exec(block.text)) !== null) {
            const channel = `task:${match[1].trim()}`;
            const content = match[2].trim();
            if (content.length > 5) {
              const bus = getBus();
              await bus.publish(channel, content, config.name);
              onOutput?.(config.name, { type: "tool_call", name: "send_message", params: { channel, message: content } });
            }
          }

          // Auto-extract and execute bash/shell code blocks
          // Results are injected as text (not tool_results) to avoid
          // tool_call/tool_result count mismatches with strict APIs
          const bashPattern = /```(?:bash|sh|shell)\s*\n([\s\S]*?)\n\s*```/g;
          let bashMatch;
          while ((bashMatch = bashPattern.exec(block.text)) !== null) {
            const command = bashMatch[1].trim();
            if (command.length > 2) {
              onOutput?.(config.name, { type: "tool_call", name: "bash", params: { command } });
              const result = await executeTool(registry, "bash", {
                command,
              }, config.name, config.working_dir, innerRegistry);
              onOutput?.(config.name, { type: "tool_result", name: "bash", result });
              autoExtractedResults.push(`[auto-executed] $ ${command}\n${result.content}`);
            }
          }
        } else if (block.type === "tool_use") {
          const params = block.input as Record<string, unknown>;
          onOutput?.(config.name, {
            type: "tool_call",
            name: block.name,
            params,
          });

          const result = await executeTool(
            registry,
            block.name,
            params,
            config.name,
            config.working_dir,
            innerRegistry,
          );

          onOutput?.(config.name, {
            type: "tool_result",
            name: block.name,
            result,
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.content,
            is_error: result.is_error,
          });
        }
      }

      // Add assistant response to history
      state.history.push({ role: "assistant", content: response.content });

      // Inject auto-extracted results as text (avoids tool_call/tool_result mismatch)
      if (autoExtractedResults.length > 0) {
        state.history.push({ role: "user", content: autoExtractedResults.join("\n\n") });
      }

      // Check for cancellation
      if (cancel?.cancelled) {
        state.running = false;
        onOutput?.(config.name, { type: "done" });
        break;
      }

      // If there were tool uses, send results and continue
      if (toolResults.length > 0) {
        const hasErrors = toolResults.some(r => r.is_error);
        if (hasErrors) {
          consecutiveToolErrors++;
          if (consecutiveToolErrors >= 3) {
            const available = registry.names().join(", ");
            toolResults.push({
              type: "tool_result",
              tool_use_id: "system-nudge",
              content: `SYSTEM: You have made ${consecutiveToolErrors} consecutive invalid tool calls. STOP and read this carefully. Your available tools are ONLY: ${available}. Use these EXACT names. If you cannot proceed with these tools, respond with text explaining what you need.`,
              is_error: true,
            });
            consecutiveToolErrors = 0;
          }
        } else {
          consecutiveToolErrors = 0;
        }
        state.history.push({ role: "user", content: toolResults });
        continue;
      }

      // No tool use -- model finished its turn. Go idle and wait for
      // bus messages. No more API calls until work arrives.
      if (
        response.stop_reason === "end_turn" ||
        response.stop_reason === "stop_sequence"
      ) {
        idle = true;
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    onOutput?.(config.name, { type: "error", message });
    state.running = false;
  }

  return state;
}

/**
 * Retry an API call with exponential backoff for transient errors.
 * Retryable: 429 (rate limit), 529 (overloaded), and 5xx server errors.
 */
const MAX_RETRIES = 8;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 120_000;

function isRetryable(err: unknown): err is ProviderError {
  if (!(err instanceof ProviderError)) return false;
  return err.status === 429 || err.status === 529 || err.status >= 500;
}

async function callWithRetry<T>(
  fn: () => Promise<T>,
  agentName: string,
  onOutput?: AgentOutputHandler,
  onHeartbeat?: () => void,
  cancel?: CancelSignal,
): Promise<T> {
  const coordinator = getCoordinator();

  for (let attempt = 1; ; attempt++) {
    // Gate: wait for coordinator clearance (respects global cooldown + stagger)
    await coordinator.acquire(agentName, cancel);

    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt > MAX_RETRIES) throw err;
      if (cancel?.cancelled) throw err;

      // Respect Retry-After header if present, otherwise exponential backoff
      let baseDelay: number;
      const retryAfter = (err as ProviderError).headers?.["retry-after"];
      if (retryAfter) {
        const parsed = Number(retryAfter);
        baseDelay = (Number.isNaN(parsed) ? BASE_DELAY_MS : parsed * 1000);
      } else {
        baseDelay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      }

      // Add jitter to decorrelate retry times across agents
      const delay = RateLimitCoordinator.addJitter(baseDelay);

      // On rate limit, set a global cooldown so other agents back off
      // proactively instead of each independently discovering the limit.
      if ((err as ProviderError).status === 429) {
        coordinator.reportRateLimit(agentName, delay);
      }

      const message = `${(err as ProviderError).status} ${(err as Error).message}`;
      onOutput?.(agentName, {
        type: "retrying",
        message,
        attempt,
        delay,
      });
      onHeartbeat?.();

      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Execute a tool by name, with bus context for send/read message tools.
 * Pass `workingDir` to inject the agent's working directory as a default
 * for tools that accept a `cwd` or `path` parameter.
 */
async function executeTool(
  registry: ToolRegistry,
  name: string,
  params: Record<string, unknown>,
  agentName: string,
  workingDir?: string,
  fullRegistry?: ToolRegistry,
  allAgents?: Array<{ name: string; role: string; tools: string[] }>,
): Promise<ToolResult> {
  let tool = registry.get(name);
  if (!tool) {
    const { validateToolCall } = await import("../tools/shapes.ts");
    const validation = validateToolCall(name, params, registry.getDefinitions());
    if (validation.repairedName) {
      tool = registry.get(validation.repairedName);
      if (tool && validation.repairedParams) {
        params = validation.repairedParams;
      }
    }
    if (!tool) {
      // Check if this tool was filtered out by role
      if (fullRegistry) {
        const filteredName = validation.repairedName ?? name;
        const fullTool = fullRegistry.get(name) || fullRegistry.get(filteredName);
        if (fullTool) {
          const agentsWithTool = (allAgents || [])
            .filter(a => a.tools.includes(name) && a.name !== agentName)
            .map(a => a.name);
          const delegateHint = agentsWithTool.length > 0
            ? `\nTo use '${name}', delegate to: ${agentsWithTool.join(", ")}.`
            + `\nExample: send_message({channel: "task:${agentsWithTool[0]}", message: "Please run: ..."})`
            : "";
          return {
            content: `You (${agentName}) cannot use '${name}'. Your available tools are: ${registry.names().join(", ")}.${delegateHint}`,
            is_error: true,
          };
        }
      }
      return {
        content: validation.violations.length > 0
          ? `Tool call validation failed:\n${validation.violations.join("\n")}\n\nUse ONLY these exact tool names.`
          : `Unknown tool: ${name}. Available tools: ${registry.names().join(", ")}`,
        is_error: true,
      };
    }
  }

  // Inject agent context for bus-related tools
  if (name === "send_message") {
    const bus = getBus();
    const channel = params.channel as string;
    const message = params.message as string;
    const as2 = JSON.stringify({
      type: channel.startsWith("task:") ? "Offer" : "Announce",
      actor: agentName,
      summary: message,
    });
    await bus.publish(channel, as2, agentName);
    return { content: `Message sent to channel '${channel}'.` };
  }

  if (name === "read_messages") {
    const bus = getBus();
    const channel = params.channel as string | undefined;
    const messages = await bus.drain(agentName, channel);
    const workMessages = messages.filter(m => m.channel !== "control");
    if (workMessages.length === 0) {
      return { content: "No pending messages." };
    }
    const formatted = workMessages.map((m) => {
      try {
        const parsed = JSON.parse(m.content);
        if (parsed.summary && parsed.actor) {
          return `[${m.channel}] ${parsed.actor}: ${parsed.summary}`;
        }
      } catch { /* not JSON, use raw */ }
      return `[${m.channel}] ${m.from}: ${m.content}`;
    });
    return { content: formatted.join("\n") };
  }

  // Inject working directory as default for tools that support it
  if (workingDir) {
    if ((name === "bash" || name === "git") && !params.cwd) {
      params = { ...params, cwd: workingDir };
    }
    if (["glob", "grep", "list_dir"].includes(name) && !params.path) {
      params = { ...params, path: workingDir };
    }
    if (["write_file", "edit_file", "read_file"].includes(name) && params.path) {
      const p = params.path as string;
      if (!p.startsWith("/")) {
        params = { ...params, path: `${workingDir}/${p}` };
      }
    }
  }

  const result = await tool.execute(params);
  if (result.is_error && fullRegistry) {
    const content = result.content;
    if (content.includes("not found") || content.includes("No such file or directory")) {
      const memTool = fullRegistry.get("memory_write");
      if (memTool) {
        await memTool.execute({ about: `error:${name}:${agentName}`, finding: content.slice(0, 200), severity: "info" }).catch(() => {});
      }
    }
  }
  return result;
}

/**
 * Process tool augmentation control messages from the bus.
 * Checks the "control" channel for add_tool/remove_tool commands.
 */
async function processToolControlMessages(
  registry: ToolRegistry,
  agentName: string,
): Promise<void> {
  const bus = getBus();
  const messages = await bus.drain(agentName, "control");

  for (const msg of messages) {
    try {
      const cmd = JSON.parse(msg.content) as {
        action?: string;
        agent?: string;
        tool?: { name: string; definition?: import("../providers/types.ts").ToolDefinition };
      };

      if (!cmd.action || !cmd.tool?.name) continue;

      // Only process messages targeted to this agent (or broadcast with "*")
      if (cmd.agent !== "*" && cmd.agent !== agentName) continue;

      if (cmd.action === "add_tool" && cmd.tool.definition) {
        const mcpToolName = cmd.tool.name;
        registry.addTool(mcpToolName, {
          definition: cmd.tool.definition,
          execute: async (params) => {
            const w = self as unknown as { addEventListener: (t: string, h: (e: MessageEvent) => void) => void; removeEventListener: (t: string, h: (e: MessageEvent) => void) => void; postMessage: (msg: unknown) => void };
            return new Promise<ToolResult>((resolve) => {
              const id = Date.now() + Math.random();
              const handler = (evt: MessageEvent) => {
                const resp = evt.data;
                if (resp.type === "mcp_tool_result" && resp.id === id) {
                  w.removeEventListener("message", handler);
                  resolve(resp.result);
                }
              };
              w.addEventListener("message", handler);
              w.postMessage({ type: "mcp_tool_call", id, toolName: mcpToolName, params });
            });
          },
        });
      } else if (cmd.action === "remove_tool") {
        registry.removeTool(cmd.tool.name);
      }
    } catch {
      // Skip malformed control messages
    }
  }
}

/**
 * Serialize agent state for snapshotting.
 */
export function serializeState(state: AgentState): string {
  return JSON.stringify({
    config: state.config,
    history: state.history,
    usage: state.usage,
  });
}

/**
 * Restore agent state from a snapshot.
 */
export function deserializeState(json: string): AgentState {
  const data = JSON.parse(json);
  return {
    config: data.config,
    history: data.history,
    usage: data.usage,
    running: false,
  };
}
