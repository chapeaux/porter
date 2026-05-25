/**
 * Display layer -- streams agent events to tmux panes.
 *
 * Tmux panes serve as viewports: agents run in the orchestrator process,
 * and their output is projected into panes for human observation.
 */

import type { Transport } from "./transport.ts";
import type { AgentEvent } from "../runtime/agent.ts";

/** ANSI color codes for terminal output. */
const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
} as const;

/** Maps agent names to their assigned pane IDs. */
export class DisplayManager {
  private paneMap = new Map<string, string>();
  private logFile: Deno.FsFile | null = null;

  constructor(private transport: Transport) {}

  /** Assign a pane ID to an agent. */
  registerPane(agentName: string, paneId: string): void {
    this.paneMap.set(agentName, paneId);
  }

  /** Get the pane ID for an agent, if registered. */
  getPaneId(agentName: string): string | undefined {
    return this.paneMap.get(agentName);
  }

  /** Enable file logging. */
  async enableLog(path: string): Promise<void> {
    this.logFile = await Deno.open(path, {
      write: true,
      create: true,
      append: true,
    });
  }

  /** Close log file. */
  async close(): Promise<void> {
    this.logFile?.close();
    this.logFile = null;
    await Promise.resolve();
  }

  /**
   * Create an output handler for a specific agent.
   * Returns a function that can be passed to runAgent as onOutput.
   */
  handler(agentName: string): (name: string, event: AgentEvent) => void {
    return (_name: string, event: AgentEvent) => {
      this.handleEvent(agentName, event);
    };
  }

  /** Handle an agent event by writing to the pane and log. */
  private handleEvent(agentName: string, event: AgentEvent): void {
    const paneId = this.paneMap.get(agentName);
    if (!paneId) return;

    let display: string;
    let log: string;

    switch (event.type) {
      case "text":
        display = event.content;
        log = `[${agentName}] ${event.content}`;
        break;

      case "tool_call":
        display = `${COLORS.cyan}${COLORS.bold}> ${event.name}${COLORS.reset}${COLORS.dim}(${summarizeParams(event.params)})${COLORS.reset}`;
        log = `[${agentName}] TOOL: ${event.name}(${JSON.stringify(event.params)})`;
        break;

      case "tool_result":
        display = event.result.is_error
          ? `${COLORS.red}  ERROR: ${truncate(event.result.content, 200)}${COLORS.reset}`
          : `${COLORS.green}  OK${COLORS.reset} ${COLORS.dim}${truncate(event.result.content, 200)}${COLORS.reset}`;
        log = `[${agentName}] RESULT(${event.name}): ${event.result.content}`;
        break;

      case "retrying":
        display = `${COLORS.yellow}${COLORS.bold}RETRYING (${event.attempt}/${8})${COLORS.reset}${COLORS.dim} ${event.message} -- waiting ${Math.round(event.delay / 1000)}s${COLORS.reset}`;
        log = `[${agentName}] RETRYING (${event.attempt}): ${event.message} delay=${event.delay}ms`;
        break;

      case "error":
        display = `${COLORS.red}${COLORS.bold}ERROR: ${event.message}${COLORS.reset}`;
        log = `[${agentName}] ERROR: ${event.message}`;
        break;

      case "usage":
        return;

      case "done":
        display = `${COLORS.magenta}${COLORS.bold}--- agent finished ---${COLORS.reset}`;
        log = `[${agentName}] DONE`;
        break;
    }

    // Write to pane (fire and forget)
    this.writeToPane(paneId, display);

    // Write to log file
    if (this.logFile) {
      const timestamp = new Date().toISOString();
      const encoder = new TextEncoder();
      this.logFile.writeSync(encoder.encode(`${timestamp} ${log}\n`));
    }
  }

  /** Write a line of text to a tmux pane. */
  private writeToPane(paneId: string, text: string): void {
    // Use display-message to write to the pane without affecting running processes.
    // We echo the text to the pane's tty for clean display.
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");

    // Fire and forget -- don't block the agent loop on tmux I/O
    this.transport
      .sendKeys(paneId, `echo "${escaped}"`)
      .catch(() => {/* pane may be gone */});
  }
}

/** Summarize tool params for compact display. */
function summarizeParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "string" && val.length > 60) {
      parts.push(`${key}: "${val.slice(0, 57)}..."`);
    } else {
      parts.push(`${key}: ${JSON.stringify(val)}`);
    }
  }
  return parts.join(", ");
}

/** Truncate a string for display. */
function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, " ");
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}
