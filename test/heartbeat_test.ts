import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { HeartbeatMonitor } from "../src/runtime/heartbeat.ts";

Deno.test("HeartbeatMonitor - register and beat", () => {
  const dead: string[] = [];
  const monitor = new HeartbeatMonitor(1000, (name) => {
    dead.push(name);
  });

  monitor.register("agent-1");
  monitor.beat("agent-1");

  const ages = monitor.ages();
  assertEquals(ages.size, 1);

  // Age should be very small since we just beat
  const age = ages.get("agent-1")!;
  assertEquals(age < 100, true);

  monitor.stop();
});

Deno.test("HeartbeatMonitor - unregister removes agent", () => {
  const monitor = new HeartbeatMonitor(1000, () => {});

  monitor.register("agent-1");
  monitor.unregister("agent-1");

  const ages = monitor.ages();
  assertEquals(ages.size, 0);

  monitor.stop();
});

Deno.test("HeartbeatMonitor - detects dead agents", async () => {
  const dead: string[] = [];
  const monitor = new HeartbeatMonitor(50, (name) => {
    dead.push(name);
  });

  monitor.register("agent-1");
  monitor.start();

  // Wait for timeout + check interval
  await new Promise((r) => setTimeout(r, 150));

  assertEquals(dead.includes("agent-1"), true);

  monitor.stop();
});

Deno.test("HeartbeatMonitor - beating keeps agent alive", async () => {
  const dead: string[] = [];
  const monitor = new HeartbeatMonitor(100, (name) => {
    dead.push(name);
  });

  monitor.register("agent-1");
  monitor.start();

  // Beat every 30ms -- should stay alive
  const interval = setInterval(() => monitor.beat("agent-1"), 30);

  await new Promise((r) => setTimeout(r, 200));

  clearInterval(interval);
  assertEquals(dead.length, 0);

  monitor.stop();
});
