/**
 * Tests for ToolRegistry — dynamic add/remove and definition extraction.
 */

import {
  assertEquals,
  assertExists,
} from "jsr:@std/assert";
import { ToolRegistry, type ToolEntry, buildRegistry } from "../src/tools/mod.ts";

function makeToolEntry(name: string): ToolEntry {
  return {
    definition: {
      name,
      description: `Test tool: ${name}`,
      input_schema: { type: "object", properties: { x: { type: "string" } } },
    },
    async execute(_params) {
      return { content: `${name} executed` };
    },
  };
}

Deno.test("ToolRegistry: addTool and get", () => {
  const reg = new ToolRegistry();
  assertEquals(reg.size, 0);

  reg.addTool("test_tool", makeToolEntry("test_tool"));
  assertEquals(reg.size, 1);

  const entry = reg.get("test_tool");
  assertExists(entry);
  assertEquals(entry!.definition.name, "test_tool");
});

Deno.test("ToolRegistry: removeTool", () => {
  const reg = new ToolRegistry();
  reg.addTool("a", makeToolEntry("a"));
  reg.addTool("b", makeToolEntry("b"));
  assertEquals(reg.size, 2);

  const removed = reg.removeTool("a");
  assertEquals(removed, true);
  assertEquals(reg.size, 1);
  assertEquals(reg.get("a"), undefined);

  const notFound = reg.removeTool("nonexistent");
  assertEquals(notFound, false);
});

Deno.test("ToolRegistry: getDefinitions returns current tools", () => {
  const reg = new ToolRegistry();
  reg.addTool("x", makeToolEntry("x"));
  reg.addTool("y", makeToolEntry("y"));

  const defs = reg.getDefinitions();
  assertEquals(defs.length, 2);

  const names = defs.map((d) => d.name).sort();
  assertEquals(names, ["x", "y"]);
});

Deno.test("ToolRegistry: getDefinitions reflects dynamic changes", () => {
  const reg = new ToolRegistry();
  reg.addTool("a", makeToolEntry("a"));

  let defs = reg.getDefinitions();
  assertEquals(defs.length, 1);

  reg.addTool("b", makeToolEntry("b"));
  defs = reg.getDefinitions();
  assertEquals(defs.length, 2);

  reg.removeTool("a");
  defs = reg.getDefinitions();
  assertEquals(defs.length, 1);
  assertEquals(defs[0].name, "b");
});

Deno.test("ToolRegistry: names() lists all tools", () => {
  const reg = new ToolRegistry();
  reg.addTool("alpha", makeToolEntry("alpha"));
  reg.addTool("beta", makeToolEntry("beta"));

  const names = reg.names().sort();
  assertEquals(names, ["alpha", "beta"]);
});

Deno.test("ToolRegistry: addTool overwrites existing", () => {
  const reg = new ToolRegistry();
  reg.addTool("x", makeToolEntry("x"));
  assertEquals(reg.get("x")!.definition.description, "Test tool: x");

  const replacement: ToolEntry = {
    definition: {
      name: "x",
      description: "Replaced",
      input_schema: { type: "object", properties: {} },
    },
    async execute() { return { content: "replaced" }; },
  };
  reg.addTool("x", replacement);
  assertEquals(reg.size, 1);
  assertEquals(reg.get("x")!.definition.description, "Replaced");
});

Deno.test("ToolRegistry: execute works through entry", async () => {
  const reg = new ToolRegistry();
  reg.addTool("echo", {
    definition: {
      name: "echo",
      description: "Echo",
      input_schema: { type: "object", properties: { msg: { type: "string" } } },
    },
    async execute(params) {
      return { content: params.msg as string };
    },
  });

  const result = await reg.get("echo")!.execute({ msg: "hello" });
  assertEquals(result.content, "hello");
});

Deno.test("buildRegistry returns ToolRegistry instance", async () => {
  const reg = await buildRegistry(["read_file", "bash"]);
  assertEquals(reg instanceof ToolRegistry, true);
  assertEquals(reg.size, 2);
  assertExists(reg.get("read_file"));
  assertExists(reg.get("bash"));
});
