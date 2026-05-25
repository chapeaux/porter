import type { ToolEntry } from "./mod.ts";
import type { SandboxExecutor } from "../sandbox/mod.ts";

let _sandbox: SandboxExecutor | null = null;

export function setSandboxExecutor(executor: SandboxExecutor | null): void {
  _sandbox = executor;
}

let _sessionEnv: Record<string, string> = {};

export function setSessionEnv(env: Record<string, string>): void {
  _sessionEnv = env;
}

const entry: ToolEntry = {
  definition: {
    name: "git",
    description:
      "Run git commands in the working directory. Only allowlisted subcommands are permitted.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description:
            "Git subcommand: status, diff, log, add, commit, checkout, branch, push, pull, fetch, clone, stash, merge, rebase, cherry-pick, tag, rev-parse, remote, show, blame, switch.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments for the git subcommand.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for git operations. Defaults to the agent's working directory.",
        },
      },
      required: ["command"],
    },
  },

  async execute(params) {
    const subcommand = params.command as string;
    const args = (params.args as string[]) ?? [];
    const cwd = params.cwd as string | undefined;

    // Allowlist of safe subcommands
    const allowed = new Set([
      "status", "diff", "log", "show", "blame",
      "add", "commit", "checkout", "branch", "switch",
      "push", "pull", "fetch", "clone", "stash",
      "merge", "rebase", "cherry-pick", "tag",
      "rev-parse", "remote",
    ]);

    if (!allowed.has(subcommand)) {
      return {
        content: `Git subcommand '${subcommand}' is not allowed. Allowed: ${[...allowed].join(", ")}`,
        is_error: true,
      };
    }

    // Route through container sandbox when active
    if (_sandbox?.running) {
      const result = await _sandbox.exec(
        ["git", subcommand, ...args],
        {
          cwd,
          env: { ..._sessionEnv, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      let content = "";
      if (result.stdout) content += result.stdout;
      if (result.stderr) content += (content ? "\n" : "") + result.stderr;
      if (!content) content = "(no output)";
      if (!result.success) {
        return { content: `${content}\nExit code: ${result.code}`, is_error: true };
      }
      return { content };
    }

    try {
      const baseEnv = { ...Deno.env.toObject(), ..._sessionEnv };
      baseEnv.GIT_TERMINAL_PROMPT = "0";

      const cmd = new Deno.Command("git", {
        args: [subcommand, ...args],
        cwd,
        env: baseEnv,
        stdout: "piped",
        stderr: "piped",
      });

      const result = await cmd.output();
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);

      let content = "";
      if (stdout) content += stdout;
      if (stderr) content += (content ? "\n" : "") + stderr;
      if (!content) content = "(no output)";

      if (!result.success) {
        return { content: `${content}\nExit code: ${result.code}`, is_error: true };
      }
      return { content };
    } catch (err) {
      return {
        content: `Error executing git ${subcommand}: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
