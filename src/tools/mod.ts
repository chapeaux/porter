/**
 * Tool registry and shared types.
 *
 * Each tool is a function that takes typed params and returns a ToolResult.
 * The registry maps tool names to their implementation + schema definition.
 */

import type { ToolDefinition } from "../providers/types.ts";
import type { ToolName } from "../core/config.ts";

export type { ToolDefinition } from "../providers/types.ts";

/** Result returned by a tool execution. */
export interface ToolResult {
  /** Text content returned to the model. */
  content: string;
  /** Whether this result represents an error. */
  is_error?: boolean;
}

/** A tool implementation paired with its API schema. */
export interface ToolEntry {
  /** Provider-neutral tool definition (name, description, input_schema). */
  definition: ToolDefinition;
  /** Execute the tool with the given params. */
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

// Lazy-load tool modules to avoid circular deps and keep startup fast.

async function loadTool(name: ToolName): Promise<ToolEntry> {
  switch (name) {
    case "read_file":
      return (await import("./read_file.ts")).default;
    case "write_file":
      return (await import("./write_file.ts")).default;
    case "edit_file":
      return (await import("./edit_file.ts")).default;
    case "bash":
      return (await import("./bash.ts")).default;
    case "glob":
      return (await import("./glob.ts")).default;
    case "grep":
      return (await import("./grep.ts")).default;
    case "list_dir":
      return (await import("./list_dir.ts")).default;
    case "send_message":
      return (await import("./send_message.ts")).default;
    case "read_messages":
      return (await import("./read_messages.ts")).default;
    case "git":
      return (await import("./git.ts")).default;
    case "memory_write":
      return (await import("./memory_write.ts")).default;
    case "memory_query":
      return (await import("./memory_query.ts")).default;
    case "ap_post":
      return (await import("./ap_post.ts")).default;
    case "ap_reply":
      return (await import("./ap_reply.ts")).default;
    case "finding_write":
      return (await import("./finding_write.ts")).default;
    case "findings_query":
      return (await import("./findings_query.ts")).default;
    case "critique_write":
      return (await import("./critique_write.ts")).default;
    case "critiques_query":
      return (await import("./critiques_query.ts")).default;
    case "approve":
      return (await import("./approve.ts")).default;
    case "plan_write":
      return (await import("./plan_write.ts")).default;
    case "plan_query":
      return (await import("./plan_query.ts")).default;
    case "step_update":
      return (await import("./step_update.ts")).default;
    case "semantic_search":
      return (await import("./semantic_search.ts")).default;
  }
}

/**
 * Mutable tool registry supporting runtime add/remove of tools.
 *
 * The agent loop calls getDefinitions() on each API call, so newly
 * added tools are automatically included in the next request.
 */
export class ToolRegistry {
  private registry: Map<string, ToolEntry>;

  constructor(entries?: Map<string, ToolEntry>) {
    this.registry = entries ?? new Map();
  }

  /** Add a tool at runtime. Overwrites if name already exists. */
  addTool(name: string, entry: ToolEntry): void {
    this.registry.set(name, entry);
  }

  /** Remove a tool at runtime. Returns true if it existed. */
  removeTool(name: string): boolean {
    return this.registry.delete(name);
  }

  /** Get all tool definitions for the current set, sorted for stable prefix caching. */
  getDefinitions(): ToolDefinition[] {
    return [...this.registry.values()]
      .map((e) => e.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get a tool entry by name. */
  get(name: string): ToolEntry | undefined {
    return this.registry.get(name);
  }

  /** List all registered tool names. */
  names(): string[] {
    return [...this.registry.keys()];
  }

  /** Number of registered tools. */
  get size(): number {
    return this.registry.size;
  }

  /** Find the closest matching tool by normalized name. */
  findClosest(name: string): ToolEntry | undefined {
    const normalized = name.toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_.]/g, "");

    // Exact match on normalized form
    for (const [k, v] of this.registry) {
      if (k.toLowerCase() === normalized) return v;
    }

    // Substring match — if the input contains exactly one tool name
    const matches = [...this.registry.keys()].filter(k =>
      normalized.includes(k.toLowerCase()) || k.toLowerCase().includes(normalized)
    );
    if (matches.length === 1) return this.registry.get(matches[0]);

    return undefined;
  }
}

/**
 * Build a tool registry for a specific agent, containing only the tools
 * that agent is allowed to use.
 */
export async function buildRegistry(
  toolNames: ToolName[],
): Promise<ToolRegistry> {
  const entries = new Map<string, ToolEntry>();
  for (const name of toolNames) {
    entries.set(name, await loadTool(name));
  }
  return new ToolRegistry(entries);
}

/**
 * Extract tool definitions from a registry.
 * @deprecated Use registry.getDefinitions() directly.
 */
export function getDefinitions(
  registry: ToolRegistry | Map<string, ToolEntry>,
): ToolDefinition[] {
  if (registry instanceof ToolRegistry) {
    return registry.getDefinitions();
  }
  return [...registry.values()].map((e) => e.definition);
}
