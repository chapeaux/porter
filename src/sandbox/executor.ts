/**
 * Container sandbox executor for running agent commands in isolation.
 *
 * Runs bash/git commands inside a podman or docker container with only
 * the workspace directory mounted, preventing access to the host filesystem.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContainerRuntime = "podman" | "docker";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
}

export interface SandboxExecutor {
  start(): Promise<void>;
  exec(
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<ExecResult>;
  stop(): Promise<void>;
  readonly running: boolean;
  readonly runtime: ContainerRuntime;
}

export interface SandboxConfig {
  enabled: boolean;
  image?: string;
  runtime?: ContainerRuntime;
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/**
 * Detect which container runtime is available on the host.
 * Prefers podman over docker. Throws if neither is found.
 */
export async function detectRuntime(): Promise<ContainerRuntime> {
  for (const rt of ["podman", "docker"] as const) {
    try {
      const cmd = new Deno.Command(rt, {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      if (result.success) return rt;
    } catch {
      // Command not found — try the next one
    }
  }
  throw new Error(
    "Sandbox requires podman or docker, but neither was found",
  );
}

// ---------------------------------------------------------------------------
// Shared exec implementation
// ---------------------------------------------------------------------------

/**
 * Execute a command inside a running container. Shared by both
 * ContainerSandbox and ContainerSandboxHandle so the logic isn't duplicated.
 */
async function containerExec(
  runtime: ContainerRuntime,
  containerName: string,
  workingDir: string,
  command: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<ExecResult> {
  const execArgs: string[] = ["exec"];

  // Working directory translation: host path -> container path
  if (options?.cwd) {
    let containerCwd = options.cwd;
    if (containerCwd.startsWith(workingDir)) {
      containerCwd = "/workspace" + containerCwd.slice(workingDir.length);
    } else if (!containerCwd.startsWith("/")) {
      containerCwd = `/workspace/${containerCwd}`;
    }
    execArgs.push("-w", containerCwd);
  }

  // Environment variables — ONLY explicitly passed vars, no host env leakage
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      execArgs.push("-e", `${key}=${value}`);
    }
  }

  execArgs.push(containerName, ...command);

  const cmd = new Deno.Command(runtime, {
    args: execArgs,
    stdout: "piped",
    stderr: "piped",
  });

  const process = cmd.spawn();

  // Timeout handling
  let timedOut = false;
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    try {
      process.kill("SIGTERM");
    } catch {
      // Process already exited
    }
  }, timeoutMs);

  const result = await process.output();
  clearTimeout(timeoutId);

  const decoder = new TextDecoder();
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);

  return {
    stdout,
    stderr: timedOut
      ? `${stderr}\nCommand timed out after ${timeoutMs}ms`
      : stderr,
    code: result.code,
    success: result.success,
  };
}

// ---------------------------------------------------------------------------
// ContainerSandbox — full lifecycle owner
// ---------------------------------------------------------------------------

/**
 * Owns the full lifecycle of a sandbox container (start, exec, stop).
 * Used by the orchestrator to create and manage the container.
 */
export class ContainerSandbox implements SandboxExecutor {
  private _running = false;
  private _runtime!: ContainerRuntime;
  private readonly _containerName: string;
  private readonly _image: string;
  private readonly _runtimeTools: string[];

  constructor(
    private readonly _config: SandboxConfig,
    private readonly _workingDir: string,
    sessionName: string,
    runtimeTools?: string[],
  ) {
    const safeName = sessionName.replace(/[^a-z0-9-]/gi, "-");
    const uniqueSuffix = Date.now().toString(36);
    this._containerName = `porter-sandbox-${safeName}-${uniqueSuffix}`;
    this._image = _config.image ??
      "registry.access.redhat.com/ubi9/ubi:latest";
    this._runtimeTools = runtimeTools ?? [];
  }

  get running(): boolean {
    return this._running;
  }

  get runtime(): ContainerRuntime {
    return this._runtime;
  }

  get containerName(): string {
    return this._containerName;
  }

  async start(): Promise<void> {
    const rt = this._config.runtime ?? await detectRuntime();
    this._runtime = rt;

    // SELinux label flag: :Z for podman to relabel the mount privately
    const mountFlag = rt === "podman" ? ":Z" : "";
    const args = [
      "run",
      "-d",
      "--name",
      this._containerName,
      "-v",
      `${this._workingDir}:/workspace${mountFlag}`,
      "-w",
      "/workspace",
      this._image,
      "sleep",
      "infinity",
    ];

    const cmd = new Deno.Command(rt, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to start sandbox container: ${stderr}`);
    }

    this._running = true;

    // Install baseline tools (git is required) + any configured runtime tools
    const packages = new Set(["git"]);
    for (const tool of this._runtimeTools) {
      if (typeof tool === "string") packages.add(tool);
    }
    const installCmd = new Deno.Command(rt, {
      args: ["exec", this._containerName, "dnf", "install", "-y", "--setopt=install_weak_deps=False", ...packages],
      stdout: "piped",
      stderr: "piped",
    });
    const installResult = await installCmd.output();
    if (!installResult.success) {
      const stderr = new TextDecoder().decode(installResult.stderr);
      console.error(`[sandbox] Warning: tool installation failed: ${stderr.slice(0, 200)}`);
    }
  }

  async exec(
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<ExecResult> {
    if (!this._running) {
      throw new Error("Sandbox container is not running");
    }
    return containerExec(
      this._runtime,
      this._containerName,
      this._workingDir,
      command,
      options,
    );
  }

  async stop(): Promise<void> {
    const cmd = new Deno.Command(this._runtime, {
      args: ["rm", "-f", this._containerName],
      stdout: "piped",
      stderr: "piped",
    });
    await cmd.output();
    this._running = false;
  }
}

// ---------------------------------------------------------------------------
// ContainerSandboxHandle — shared container reference (no lifecycle)
// ---------------------------------------------------------------------------

/**
 * A non-owning handle to an already-running sandbox container. Used by
 * isolate workers that share the orchestrator's container. Does not
 * implement start() or stop() — lifecycle is owned by the orchestrator.
 */
export class ContainerSandboxHandle implements SandboxExecutor {
  constructor(
    private readonly _runtime: ContainerRuntime,
    private readonly _containerName: string,
    private readonly _workingDir: string,
  ) {}

  get running(): boolean {
    return true;
  }

  get runtime(): ContainerRuntime {
    return this._runtime;
  }

  async start(): Promise<void> {
    throw new Error(
      "ContainerSandboxHandle does not own the container lifecycle",
    );
  }

  async stop(): Promise<void> {
    throw new Error(
      "ContainerSandboxHandle does not own the container lifecycle",
    );
  }

  async exec(
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<ExecResult> {
    return containerExec(
      this._runtime,
      this._containerName,
      this._workingDir,
      command,
      options,
    );
  }
}
