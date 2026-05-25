/**
 * Tests for tool routing -- role-based filtering, AS2 wrapping/unwrapping,
 * control message filtering, delegation hints, and error enhancement.
 *
 * Replaces the former action_gateway_test.ts after dissolving the 4-tool gateway.
 */

import {
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import { describe, it } from "jsr:@std/testing/bdd";
import { ToolRegistry, type ToolEntry, type ToolResult } from "../src/tools/mod.ts";
import { applyRoleFilter } from "../src/runtime/agent.ts";
import { getBus, resetBus } from "../src/runtime/bus.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CallRecord {
  tool: string;
  params: Record<string, unknown>;
}

/** Create a mock ToolEntry that records calls and returns a canned response. */
function mockToolEntry(name: string, calls: CallRecord[], response?: string): ToolEntry {
  return {
    definition: {
      name,
      description: `Mock ${name}`,
      input_schema: { type: "object" as const, properties: {} },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      calls.push({ tool: name, params: { ...params } });
      return { content: response ?? `${name} ok` };
    },
  };
}

/** Build a mock registry with all individual tools. */
function buildMockRegistry(calls: CallRecord[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "grep",
    "glob",
    "git",
    "send_message",
    "read_messages",
    "memory_write",
    "memory_query",
  ]) {
    reg.addTool(name, mockToolEntry(name, calls));
  }
  return reg;
}

// ---------------------------------------------------------------------------
// applyRoleFilter
// ---------------------------------------------------------------------------

describe("applyRoleFilter", () => {
  it("admin gets only send_message, read_messages, memory_write, memory_query", () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);
    const filtered = applyRoleFilter(full, "admin");

    const names = filtered.names().sort();
    assertEquals(names, ["memory_query", "memory_write", "read_messages", "send_message"]);
    assertEquals(filtered.size, 4);
  });

  it("worker gets all tools (no filtering)", () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);
    const filtered = applyRoleFilter(full, "worker");

    // worker role is not in the allowedByRole map, so no filtering
    assertEquals(filtered.size, full.size);
    assertEquals(filtered.names().sort(), full.names().sort());
  });

  it("reviewer gets all tools (no filtering)", () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);
    const filtered = applyRoleFilter(full, "reviewer");

    assertEquals(filtered.size, full.size);
    assertEquals(filtered.names().sort(), full.names().sort());
  });

  it("unknown role gets all tools (no filtering)", () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);
    const filtered = applyRoleFilter(full, "unknown-role");

    assertEquals(filtered.size, full.size);
  });
});

// ---------------------------------------------------------------------------
// AS2 wrapping via send_message
// ---------------------------------------------------------------------------

describe("AS2 wrapping in send_message", () => {
  function setupBus(agentName: string, channels: string[]) {
    resetBus();
    const bus = getBus();
    bus.subscribe(agentName, channels);
    return bus;
  }

  it("wraps task: channel messages as AS2 Offer", async () => {
    const bus = setupBus("target-agent", ["task:target-agent"]);

    // Simulate what executeTool does for send_message
    const channel = "task:target-agent";
    const message = "Please run the tests";
    const agentName = "admin-1";
    const as2 = JSON.stringify({
      type: channel.startsWith("task:") ? "Offer" : "Announce",
      actor: agentName,
      summary: message,
    });
    await bus.publish(channel, as2, agentName);

    const msgs = await bus.drain("target-agent");
    assertEquals(msgs.length, 1);
    const parsed = JSON.parse(msgs[0].content);
    assertEquals(parsed.type, "Offer");
    assertEquals(parsed.actor, "admin-1");
    assertEquals(parsed.summary, "Please run the tests");

    resetBus();
  });

  it("wraps non-task channel messages as AS2 Announce", async () => {
    const bus = setupBus("listener", ["log"]);

    const channel = "log";
    const message = "Status update";
    const agentName = "worker-1";
    const as2 = JSON.stringify({
      type: channel.startsWith("task:") ? "Offer" : "Announce",
      actor: agentName,
      summary: message,
    });
    await bus.publish(channel, as2, agentName);

    const msgs = await bus.drain("listener");
    assertEquals(msgs.length, 1);
    const parsed = JSON.parse(msgs[0].content);
    assertEquals(parsed.type, "Announce");
    assertEquals(parsed.actor, "worker-1");
    assertEquals(parsed.summary, "Status update");

    resetBus();
  });
});

// ---------------------------------------------------------------------------
// AS2 unwrapping in read_messages
// ---------------------------------------------------------------------------

describe("AS2 unwrapping in read_messages", () => {
  function setupBus(agentName: string, channels: string[]) {
    resetBus();
    const bus = getBus();
    bus.subscribe(agentName, channels);
    return bus;
  }

  it("unwraps AS2 JSON to plain 'actor: summary' format", async () => {
    const bus = setupBus("worker-1", ["task"]);

    // Publish an AS2 message
    const as2 = JSON.stringify({ type: "Offer", actor: "admin-1", summary: "Do the work" });
    await bus.publish("task", as2, "admin-1");

    const messages = await bus.drain("worker-1");
    const workMessages = messages.filter(m => m.channel !== "control");
    assertEquals(workMessages.length, 1);

    // Simulate the unwrapping logic from executeTool
    const formatted = workMessages.map((m) => {
      try {
        const parsed = JSON.parse(m.content);
        if (parsed.summary && parsed.actor) {
          return `[${m.channel}] ${parsed.actor}: ${parsed.summary}`;
        }
      } catch { /* not JSON, use raw */ }
      return `[${m.channel}] ${m.from}: ${m.content}`;
    });

    assertEquals(formatted.length, 1);
    assertStringIncludes(formatted[0], "admin-1");
    assertStringIncludes(formatted[0], "Do the work");
    // Should use parsed.actor not m.from
    assertEquals(formatted[0], "[task] admin-1: Do the work");

    resetBus();
  });

  it("falls back to raw format for non-JSON messages", async () => {
    const bus = setupBus("worker-1", ["task"]);

    // Publish a plain text message (not JSON)
    await bus.publish("task", "plain text message", "admin-1");

    const messages = await bus.drain("worker-1");
    const workMessages = messages.filter(m => m.channel !== "control");

    const formatted = workMessages.map((m) => {
      try {
        const parsed = JSON.parse(m.content);
        if (parsed.summary && parsed.actor) {
          return `[${m.channel}] ${parsed.actor}: ${parsed.summary}`;
        }
      } catch { /* not JSON, use raw */ }
      return `[${m.channel}] ${m.from}: ${m.content}`;
    });

    assertEquals(formatted[0], "[task] admin-1: plain text message");

    resetBus();
  });
});

// ---------------------------------------------------------------------------
// Control message filtering
// ---------------------------------------------------------------------------

describe("control message filtering in read_messages", () => {
  function setupBus(agentName: string, channels: string[]) {
    resetBus();
    const bus = getBus();
    bus.subscribe(agentName, channels);
    return bus;
  }

  it("excludes control channel messages from read_messages results", async () => {
    const bus = setupBus("worker-1", ["task", "control"]);
    await bus.publish("control", JSON.stringify({ action: "add_tool", tool: { name: "x" } }), "system");
    await bus.publish("task", "do work", "admin-1");

    const messages = await bus.drain("worker-1");
    const workMessages = messages.filter(m => m.channel !== "control");

    assertEquals(workMessages.length, 1);
    assertStringIncludes(workMessages[0].content, "do work");
    // control message should be filtered out
    assertEquals(workMessages.some(m => m.channel === "control"), false);

    resetBus();
  });

  it("returns empty when only control messages exist", async () => {
    const bus = setupBus("worker-1", ["control"]);
    await bus.publish("control", "shutdown", "admin-1");

    const messages = await bus.drain("worker-1");
    const workMessages = messages.filter(m => m.channel !== "control");

    assertEquals(workMessages.length, 0);

    resetBus();
  });
});

// ---------------------------------------------------------------------------
// Delegation hints
// ---------------------------------------------------------------------------

describe("delegation hints for role-filtered tools", () => {
  it("provides delegation hint when admin tries to use a filtered tool", () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);
    const filtered = applyRoleFilter(full, "admin");

    // Admin should not have 'bash'
    assertEquals(filtered.get("bash"), undefined);

    // But the full registry does
    assertEquals(full.get("bash") !== undefined, true);

    // Simulate the delegation hint logic from executeTool
    const name = "bash";
    const agentName = "admin-1";
    const allAgents = [
      { name: "admin-1", role: "admin", tools: ["send_message", "read_messages", "memory_write", "memory_query"] },
      { name: "worker-1", role: "worker", tools: ["bash", "read_file", "write_file", "send_message", "read_messages"] },
      { name: "worker-2", role: "worker", tools: ["bash", "read_file", "write_file", "send_message", "read_messages"] },
    ];

    const fullTool = full.get(name);
    assertEquals(fullTool !== undefined, true);

    const agentsWithTool = allAgents
      .filter(a => a.tools.includes(name) && a.name !== agentName)
      .map(a => a.name);

    assertEquals(agentsWithTool.length, 2);
    assertStringIncludes(agentsWithTool.join(", "), "worker-1");
    assertStringIncludes(agentsWithTool.join(", "), "worker-2");

    const delegateHint = agentsWithTool.length > 0
      ? `\nTo use '${name}', delegate to: ${agentsWithTool.join(", ")}.`
      + `\nExample: send_message({channel: "task:${agentsWithTool[0]}", message: "Please run: ..."})`
      : "";

    const errorContent = `You (${agentName}) cannot use '${name}'. Your available tools are: ${filtered.names().join(", ")}.${delegateHint}`;

    assertStringIncludes(errorContent, "cannot use 'bash'");
    assertStringIncludes(errorContent, "delegate to: worker-1, worker-2");
    assertStringIncludes(errorContent, 'send_message({channel: "task:worker-1"');
  });

  it("returns error without delegation hint when no agents have the tool", () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);
    const filtered = applyRoleFilter(full, "admin");

    const name = "bash";
    const agentName = "admin-1";
    // No other agents at all
    const allAgents: Array<{ name: string; role: string; tools: string[] }> = [];

    const agentsWithTool = allAgents
      .filter(a => a.tools.includes(name) && a.name !== agentName)
      .map(a => a.name);

    const delegateHint = agentsWithTool.length > 0
      ? `\nTo use '${name}', delegate to: ${agentsWithTool.join(", ")}.`
      : "";

    const errorContent = `You (${agentName}) cannot use '${name}'. Your available tools are: ${filtered.names().join(", ")}.${delegateHint}`;

    assertStringIncludes(errorContent, "cannot use 'bash'");
    assertEquals(errorContent.includes("delegate to:"), false);
  });
});

// ---------------------------------------------------------------------------
// Error enhancement
// ---------------------------------------------------------------------------

describe("error enhancement for 'not found' errors", () => {
  it("logs 'not found' errors to memory_write via fullRegistry", async () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);

    // Simulate the error enhancement logic from executeTool
    const result: ToolResult = {
      content: "Error: file not found: /src/missing.ts",
      is_error: true,
    };
    const name = "read_file";
    const agentName = "worker-1";

    if (result.is_error) {
      const content = result.content;
      if (content.includes("not found") || content.includes("No such file or directory")) {
        const memTool = full.get("memory_write");
        if (memTool) {
          await memTool.execute({ about: `error:${name}:${agentName}`, finding: content.slice(0, 200), severity: "info" }).catch(() => {});
        }
      }
    }

    // memory_write should have been called
    const memCalls = calls.filter(c => c.tool === "memory_write");
    assertEquals(memCalls.length, 1);
    assertEquals(memCalls[0].params.about, "error:read_file:worker-1");
    assertStringIncludes(memCalls[0].params.finding as string, "file not found");
  });

  it("does not log non-'not found' errors to memory", async () => {
    const calls: CallRecord[] = [];
    const full = buildMockRegistry(calls);

    const result: ToolResult = {
      content: "Error: permission denied",
      is_error: true,
    };

    if (result.is_error) {
      const content = result.content;
      if (content.includes("not found") || content.includes("No such file or directory")) {
        const memTool = full.get("memory_write");
        if (memTool) {
          await memTool.execute({ about: `error:bash:worker-1`, finding: content.slice(0, 200), severity: "info" }).catch(() => {});
        }
      }
    }

    const memCalls = calls.filter(c => c.tool === "memory_write");
    assertEquals(memCalls.length, 0);
  });
});
