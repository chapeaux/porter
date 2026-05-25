import { loadConfig } from "../core/config.ts";
import { BusClient } from "../runtime/bus.ts";
import { parseFlag } from "./flags.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function write(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

async function prompt(label: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  write(`${label}${suffix}: `);

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  const input = n ? decoder.decode(buf.subarray(0, n)).trim() : "";
  return input || defaultVal || "";
}

async function choose(label: string, options: string[], defaultIdx = 0): Promise<number> {
  console.log(label);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? "*" : " ";
    console.log(`  ${marker} ${i + 1}) ${options[i]}`);
  }
  const raw = await prompt("Choice", String(defaultIdx + 1));
  const idx = parseInt(raw) - 1;
  if (idx >= 0 && idx < options.length) return idx;
  return defaultIdx;
}

export async function cmdSend(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";
  const busPort = parseInt(parseFlag(args, "--bus-port") ?? "8787");
  let channel = parseFlag(args, "--channel");
  const targetAgent = parseFlag(args, "--to");

  const flagsWithValues = new Set(["--channel", "--config", "--bus-port", "--to"]);
  const messageParts: string[] = [];
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (flagsWithValues.has(args[i])) {
      skipNext = true;
      continue;
    }
    messageParts.push(args[i]);
  }

  let message = messageParts.join(" ").trim();

  if (!message) {
    message = await prompt("Message");
    if (!message) {
      console.error("[porter] No message provided.");
      Deno.exit(1);
    }
  }

  if (targetAgent) {
    channel = `task:${targetAgent}`;
  }

  if (!channel) {
    let config;
    try {
      config = await loadConfig(configPath);
    } catch {
      config = null;
    }

    const options: string[] = [];
    const agentNames: string[] = [];

    if (config) {
      for (const agent of config.agents) {
        agentNames.push(agent.name);
      }
    }

    let defaultIdx = 0;
    if (agentNames.length > 0) {
      for (const name of agentNames) {
        options.push(`@${name}`);
      }
      const adminIdx = config?.agents.findIndex(
        (a) => a.role === "admin" || /lead|planner/i.test(a.name)
      ) ?? -1;
      if (adminIdx >= 0) defaultIdx = adminIdx;

      options.push("--- broadcast channels ---");
      const channelSet = new Set<string>();
      for (const agent of config!.agents) {
        for (const ch of agent.subscribe ?? []) {
          channelSet.add(ch);
        }
      }
      for (const ch of [...channelSet].sort()) {
        options.push(ch);
      }
    } else {
      options.push("task", "log", "control");
    }

    const idx = await choose("Send to:", options, defaultIdx);
    const picked = options[idx];

    if (picked.startsWith("@")) {
      channel = `task:${picked.slice(1)}`;
    } else if (picked.startsWith("---")) {
      channel = "task";
    } else {
      channel = picked;
    }
  }

  const url = `ws://127.0.0.1:${busPort}`;
  const client = new BusClient("porter-cli", []);

  try {
    await client.connect(url);
  } catch {
    console.error(`[porter] Could not connect to bus at ${url}`);
    console.error("[porter] Is a session running? Start one with: porter start");
    Deno.exit(1);
  }

  await client.publish(channel, message, "porter-cli");

  await new Promise((r) => setTimeout(r, 100));
  client.close();

  console.log(`[porter] Sent to '${channel}': ${message}`);
}
