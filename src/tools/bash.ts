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
    name: "bash",
    description:
      "Execute a bash command and return its stdout and stderr. Commands run in the configured working directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute.",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Default: 120000 (2 minutes).",
        },
        cwd: {
          type: "string",
          description: "Working directory for the command. Defaults to the agent's working directory.",
        },
      },
      required: ["command"],
    },
  },

  async execute(params) {
    const command = params.command as string | undefined;
    if (!command || command === "undefined") {
      return { content: "Error: 'command' parameter is required and must be a non-empty string.", is_error: true };
    }
    const timeoutMs = (params.timeout_ms as number) ?? 120_000;
    const cwd = params.cwd as string | undefined;

    // Route through container sandbox when active
    if (_sandbox?.running) {
      const result = await _sandbox.exec(
        ["bash", "-c", command],
        {
          cwd,
          env: { ..._sessionEnv, GIT_TERMINAL_PROMPT: "0" },
          timeoutMs,
        },
      );
      let content = "";
      if (result.stdout) content += result.stdout;
      if (result.stderr) content += (content ? "\n" : "") + `STDERR:\n${result.stderr}`;
      if (!content) content = "(no output)";
      if (!result.success) {
        content += `\nExit code: ${result.code}`;
        return { content, is_error: true };
      }
      return { content };
    }

    try {
      const baseEnv = { ...Deno.env.toObject(), ..._sessionEnv };
      baseEnv.GIT_TERMINAL_PROMPT = "0";
      const cmd = new Deno.Command("bash", {
        args: ["-c", command],
        cwd,
        env: baseEnv,
        stdout: "piped",
        stderr: "piped",
      });

      const process = cmd.spawn();

      const timeoutId = setTimeout(() => {
        try {
          process.kill("SIGTERM");
        } catch { /* already exited */ }
      }, timeoutMs);

      const result = await process.output();
      clearTimeout(timeoutId);

      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);

      let content = "";
      if (stdout) content += stdout;
      if (stderr) content += (content ? "\n" : "") + `STDERR:\n${stderr}`;
      if (!content) content = "(no output)";

      if (!result.success) {
        content += `\nExit code: ${result.code}`;
        return { content, is_error: true };
      }

      return { content };
    } catch (err) {
      return {
        content: `Error executing command: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
