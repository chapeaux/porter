import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MessageBus, BusServer, BusClient } from "../src/runtime/bus.ts";

Deno.test("MessageBus - subscribe and publish", async () => {
  const bus = new MessageBus();
  bus.subscribe("agent-1", ["task", "control"]);
  bus.subscribe("agent-2", ["log"]);

  await bus.publish("task", "do something", "admin");
  await bus.publish("log", "finished", "agent-1");

  // agent-1 should have the task message
  const msgs1 = await bus.drain("agent-1");
  assertEquals(msgs1.length, 1);
  assertEquals(msgs1[0].channel, "task");
  assertEquals(msgs1[0].content, "do something");
  assertEquals(msgs1[0].from, "admin");

  // agent-2 should have the log message
  const msgs2 = await bus.drain("agent-2");
  assertEquals(msgs2.length, 1);
  assertEquals(msgs2[0].channel, "log");
  assertEquals(msgs2[0].content, "finished");
});

Deno.test("MessageBus - drain with channel filter", async () => {
  const bus = new MessageBus();
  bus.subscribe("agent-1", ["task", "control"]);

  await bus.publish("task", "task-1", "admin");
  await bus.publish("control", "pause", "admin");
  await bus.publish("task", "task-2", "admin");

  // Drain only task channel
  const tasks = await bus.drain("agent-1", "task");
  assertEquals(tasks.length, 2);

  // Control message should still be there
  const control = await bus.drain("agent-1", "control");
  assertEquals(control.length, 1);
  assertEquals(control[0].content, "pause");
});

Deno.test("MessageBus - drain clears queue", async () => {
  const bus = new MessageBus();
  bus.subscribe("agent-1", ["task"]);

  await bus.publish("task", "msg-1", "admin");
  await bus.drain("agent-1");

  // Second drain should be empty
  const msgs = await bus.drain("agent-1");
  assertEquals(msgs.length, 0);
});

Deno.test("MessageBus - unsubscribe removes subscriber", async () => {
  const bus = new MessageBus();
  bus.subscribe("agent-1", ["task"]);
  bus.unsubscribe("agent-1");

  await bus.publish("task", "msg", "admin");
  const msgs = await bus.drain("agent-1");
  assertEquals(msgs.length, 0);
});

Deno.test("MessageBus - pending count", async () => {
  const bus = new MessageBus();
  bus.subscribe("agent-1", ["task"]);

  assertEquals(bus.pending("agent-1"), 0);

  await bus.publish("task", "msg-1", "admin");
  await bus.publish("task", "msg-2", "admin");

  assertEquals(bus.pending("agent-1"), 2);
});

Deno.test("MessageBus - messages not delivered to non-subscribers", async () => {
  const bus = new MessageBus();
  bus.subscribe("agent-1", ["task"]);
  bus.subscribe("agent-2", ["log"]);

  await bus.publish("task", "msg", "admin");

  const msgs2 = await bus.drain("agent-2");
  assertEquals(msgs2.length, 0);
});

Deno.test("BusServer and BusClient - round trip", async () => {
  const bus = new MessageBus();
  const server = new BusServer(bus);
  const port = 18787 + Math.floor(Math.random() * 1000);

  server.start(port);

  // Give server a moment to start
  await new Promise((r) => setTimeout(r, 100));

  const client = new BusClient("remote-agent", ["task"]);
  await client.connect(`ws://127.0.0.1:${port}`);

  // Let the subscribe message reach the server
  await new Promise((r) => setTimeout(r, 100));

  // Publish from local bus -- should reach remote client
  await bus.publish("task", "hello from local", "admin");

  // Wait for WebSocket message delivery
  await new Promise((r) => setTimeout(r, 200));

  const msgs = await client.drain("task");
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].content, "hello from local");

  // Publish from remote client -- should reach local subscriber
  bus.subscribe("local-agent", ["log"]);
  await client.publish("log", "hello from remote");

  await new Promise((r) => setTimeout(r, 100));

  const localMsgs = await bus.drain("local-agent", "log");
  assertEquals(localMsgs.length, 1);
  assertEquals(localMsgs[0].content, "hello from remote");

  client.close();
  await server.stop();
});
