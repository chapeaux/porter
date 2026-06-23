import { loadConfig } from "../core/config.ts";
import { parseFlag } from "./flags.ts";
import { getPattern } from "../orchestration/pattern_registry.ts";
import type { PatternDefinition } from "../orchestration/pattern_registry.ts";
import type { CollaborationPattern } from "../core/config.ts";

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

async function confirm(label: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  write(`${label} ${hint}: `);

  const buf = new Uint8Array(64);
  const n = await Deno.stdin.read(buf);
  const input = n ? decoder.decode(buf.subarray(0, n)).trim().toLowerCase() : "";

  if (!input) return defaultYes;
  return input === "y" || input === "yes";
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

async function multiSelect(
  label: string,
  options: string[],
  defaults: boolean[],
): Promise<boolean[]> {
  const selected = [...defaults];
  console.log(label);
  for (let i = 0; i < options.length; i++) {
    const marker = selected[i] ? "[x]" : "[ ]";
    console.log(`  ${i + 1}) ${marker} ${options[i]}`);
  }
  console.log("  Enter numbers to toggle (e.g. 1 3 5), 'all', 'none', or press Enter to accept.");
  const raw = await prompt("Toggle", "");

  if (raw === "all") {
    return options.map(() => true);
  }
  if (raw === "none") {
    return options.map(() => false);
  }
  if (raw) {
    for (const token of raw.split(/[\s,]+/)) {
      const idx = parseInt(token) - 1;
      if (idx >= 0 && idx < options.length) {
        selected[idx] = !selected[idx];
      }
    }
  }
  return selected;
}

const ALL_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "glob",
  "grep",
  "list_dir",
  "send_message",
  "read_messages",
] as const;

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file: "Read files with line numbers",
  write_file: "Create or overwrite files",
  edit_file: "Exact string replacement in files",
  bash: "Execute shell commands",
  glob: "Find files by pattern",
  grep: "Search file contents with regex",
  list_dir: "List directory contents",
  send_message: "Send messages to bus channels",
  read_messages: "Read messages from bus channels",
};

const ROLE_TOOL_DEFAULTS: Record<string, boolean[]> = {
  admin: [
    true,   // read_file
    false,  // write_file
    false,  // edit_file
    false,  // bash
    true,   // glob
    true,   // grep
    true,   // list_dir
    true,   // send_message
    true,   // read_messages
  ],
  worker: [
    true,   // read_file
    true,   // write_file
    true,   // edit_file
    true,   // bash
    true,   // glob
    true,   // grep
    true,   // list_dir
    true,   // send_message
    true,   // read_messages
  ],
  reviewer: [
    true,   // read_file
    false,  // write_file
    false,  // edit_file
    true,   // bash
    true,   // glob
    true,   // grep
    true,   // list_dir
    true,   // send_message
    true,   // read_messages
  ],
};

const ROLE_SUBSCRIBE_DEFAULTS: Record<string, string[]> = {
  admin: ["log"],
  worker: ["task", "control"],
  reviewer: ["review"],
};

const ROLE_PROMPT_DEFAULTS: Record<string, string> = {
  admin:
    "You are a planner agent. Break down tasks, assign work to other agents via the 'task' channel, and review their output on the 'log' channel.",
  worker:
    "You are a worker agent. Read tasks from the 'task' channel, implement them, and report results to the 'log' channel.",
  reviewer:
    "You are a reviewer agent. Read review requests from the 'review' channel, review code changes, run tests, and report results to the 'log' channel.",
};

const MODELS = [
  "ibm-granite/granite-3.3-8b-instruct",
  "claude-sonnet-4-6@20250514",
  "claude-haiku-4-5@20251001",
  "Qwen/Qwen3-14B",
  "openai/gpt-oss-20b",
  "gemini-2.0-flash",
];

interface AgentDraft {
  name: string;
  role: string;
  model?: string;
  system_prompt: string;
  tools: string[];
  subscribe: string[];
}

async function createAgent(num: number, defaultModel: string, pattern?: PatternDefinition): Promise<AgentDraft> {
  console.log(`--- Agent #${num} ---`);

  let defaultName: string;
  if (pattern) {
    const suggestedRole = pattern.roles[Math.min(num - 1, pattern.roles.length - 1)];
    defaultName = suggestedRole ? `${suggestedRole.id}-${num}` : `agent-${num}`;
  } else {
    defaultName = num === 1 ? "planner" : `worker-${num - 1}`;
  }
  const name = await prompt("Agent name", defaultName);

  // Determine roles from pattern or use legacy defaults
  const roles = pattern
    ? pattern.roles.map((r) => r.id)
    : ["admin", "worker", "reviewer"];
  const roleLabels = pattern
    ? pattern.roles.map((r) => `${r.id} — ${r.name}: ${r.description}`)
    : roles;

  let defaultRoleIdx: number;
  if (pattern) {
    // For each agent, suggest the role that still needs filling based on min requirements
    // First agent gets the first role, subsequent agents get worker/specialist types
    defaultRoleIdx = num === 1 ? 0 : Math.min(num - 1, roles.length - 1);
  } else {
    defaultRoleIdx = num === 1 ? 0 : 1;
  }
  const roleIdx = await choose("Role:", roleLabels, defaultRoleIdx);
  const role = roles[roleIdx];

  let agentModel: string | undefined;
  if (await confirm("Use a different model for this agent?", false)) {
    const mIdx = await choose("Model:", MODELS, MODELS.indexOf(defaultModel));
    agentModel = MODELS[mIdx];
    if (agentModel === defaultModel) agentModel = undefined;
  }

  // Get pattern role definition if available
  const patternRole = pattern?.roles.find((r) => r.id === role);

  const toolDefaults = patternRole
    ? ALL_TOOLS.map((t) => [...patternRole.default_tools, ...patternRole.auto_tools].includes(t))
    : (ROLE_TOOL_DEFAULTS[role] ?? ALL_TOOLS.map(() => true));
  const toolLabels = ALL_TOOLS.map(
    (t) => `${t} -- ${TOOL_DESCRIPTIONS[t]}`,
  );

  console.log("");
  const toolSelections = await multiSelect(
    "Tools (defaults based on role):",
    [...toolLabels],
    toolDefaults,
  );
  const tools = ALL_TOOLS.filter((_, i) => toolSelections[i]);

  const defaultChannels = patternRole
    ? patternRole.subscribe
    : (ROLE_SUBSCRIBE_DEFAULTS[role] ?? []);
  const channelInput = await prompt(
    "Subscribe to channels (comma-separated)",
    defaultChannels.join(", "),
  );
  const subscribe = channelInput
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultPrompt = patternRole
    ? patternRole.system_prompt_suffix
    : (ROLE_PROMPT_DEFAULTS[role] ?? `You are the ${name} agent.`);
  console.log("");
  console.log("System prompt (press Enter to accept default, or type a custom one):");
  console.log(`  Default: "${defaultPrompt}"`);
  const customPrompt = await prompt("System prompt", defaultPrompt);

  return {
    name,
    role,
    model: agentModel,
    system_prompt: customPrompt,
    tools: [...tools],
    subscribe,
  };
}

export async function cmdInit(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";

  try {
    await Deno.stat(configPath);
    console.error(`[porter] ${configPath} already exists. Delete it first or use --config to specify a different path.`);
    Deno.exit(1);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  console.log("");
  console.log("     _______________");
  console.log("    /               \\");
  console.log("   /                 \\");
  console.log("  |___________________|");
  console.log("  |___________________|");
  console.log("");
  console.log("  Pullman Porter -- session setup");
  console.log("");

  const cwd = Deno.cwd();
  const dirName = cwd.split("/").pop() ?? "porter";
  const defaultSession = dirName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

  const session = await prompt("Session name", defaultSession);
  const workingDir = await prompt("Working directory", cwd);

  const modelIdx = await choose("Default model:", MODELS, 0);
  const model = MODELS[modelIdx];

  // --- Pattern selection ---
  const PATTERN_IDS: CollaborationPattern[] = ["sequential", "mixture", "deliberation", "distillation"];
  const patternOptions = PATTERN_IDS.map((id) => {
    const p = getPattern(id);
    return p ? `${p.name} — ${p.description}` : id;
  });
  const patternIdx = await choose("Collaboration pattern:", patternOptions, 0);
  const patternId = PATTERN_IDS[patternIdx];
  const pattern = getPattern(patternId);

  let maxDeliberationRounds: number | undefined;
  if (patternId === "deliberation") {
    const roundsStr = await prompt("Max deliberation rounds", "3");
    maxDeliberationRounds = parseInt(roundsStr) || 3;
  }

  console.log("");
  console.log("--- Agent setup ---");
  if (pattern) {
    const roleGuide = pattern.roles
      .map((r) => `  ${r.name} (${r.id}): ${r.description} [${r.min === r.max ? String(r.min) : `${r.min}-${r.max}`}]`)
      .join("\n");
    console.log(`Pattern "${pattern.name}" suggests these roles:`);
    console.log(roleGuide);
  } else {
    console.log("You'll define agents one at a time. Each gets a name, role, tools, and system prompt.");
  }
  console.log("");

  const agents: AgentDraft[] = [];
  let addMore = true;

  while (addMore) {
    const agent = await createAgent(agents.length + 1, model, pattern ?? undefined);
    agents.push(agent);

    console.log("");
    addMore = await confirm("Add another agent?", agents.length < 2);
  }

  const config: Record<string, unknown> = {
    session,
    api_key_env: "ANTHROPIC_API_KEY",
    model,
    pattern: patternId,
    ...(maxDeliberationRounds !== undefined ? { max_deliberation_rounds: maxDeliberationRounds } : {}),
    working_dir: workingDir,
    agents: agents.map((a) => {
      const entry: Record<string, unknown> = {
        name: a.name,
        role: a.role,
        system_prompt: a.system_prompt,
        tools: a.tools,
        subscribe: a.subscribe,
      };
      if (a.model && a.model !== model) {
        entry.model = a.model;
      }
      return entry;
    }),
  };

  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log("");
  console.log(`[porter] Created ${configPath}`);
  console.log("");
  console.log(`  Session:     ${session}`);
  console.log(`  Model:       ${model}`);
  console.log(`  Pattern:     ${pattern?.name ?? patternId}`);
  if (maxDeliberationRounds !== undefined) {
    console.log(`  Max rounds:  ${maxDeliberationRounds}`);
  }
  console.log(`  Working dir: ${workingDir}`);
  console.log(`  Agents:`);
  for (const a of agents) {
    const modelNote = a.model && a.model !== model ? ` (${a.model})` : "";
    console.log(`    - ${a.name} (${a.role})${modelNote}: ${a.tools.length} tools, channels: [${a.subscribe.join(", ")}]`);
  }
  console.log("");
  console.log("Run 'porter start' to launch the session.");
}

export async function cmdAddAgent(args: string[]): Promise<void> {
  const configPath = parseFlag(args, "--config") ?? "porter.json";

  let raw: Record<string, unknown>;
  try {
    const text = await Deno.readTextFile(configPath);
    raw = JSON.parse(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(`[porter] ${configPath} not found. Run 'porter init' first.`);
    } else {
      console.error(`[porter] Error reading ${configPath}: ${(err as Error).message}`);
    }
    Deno.exit(1);
  }

  const agents = (raw.agents ?? []) as Record<string, unknown>[];
  const defaultModel = (raw.model as string) ?? "ibm-granite/granite-3.3-8b-instruct";

  console.log("");
  console.log(`[porter] Current agents in ${configPath}:`);
  for (const a of agents) {
    console.log(`  - ${a.name} (${a.role})`);
  }
  console.log("");

  const agent = await createAgent(agents.length + 1, defaultModel);

  if (agents.some((a) => a.name === agent.name)) {
    console.error(`[porter] An agent named '${agent.name}' already exists.`);
    Deno.exit(1);
  }

  const entry: Record<string, unknown> = {
    name: agent.name,
    role: agent.role,
    system_prompt: agent.system_prompt,
    tools: agent.tools,
    subscribe: agent.subscribe,
  };
  if (agent.model && agent.model !== defaultModel) {
    entry.model = agent.model;
  }

  agents.push(entry);
  raw.agents = agents;

  await Deno.writeTextFile(configPath, JSON.stringify(raw, null, 2) + "\n");

  console.log("");
  console.log(`[porter] Added agent '${agent.name}' (${agent.role}) to ${configPath}`);
  console.log(`  Tools: ${agent.tools.join(", ")}`);
  console.log(`  Channels: [${agent.subscribe.join(", ")}]`);
}
