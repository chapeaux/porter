/**
 * Remote cluster manager for OpenShift / Developer Sandbox.
 *
 * Handles authentication verification, K8s Secret management, pod
 * deployment, and port-forwarding for the WebSocket bus.
 */

import type { RemoteConfig, PorterConfig } from "../core/config.ts";
import { buildToolInitContainers } from "../router/tool_registry.ts";

/** Result of an oc command execution. */
interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Status of a deployed pod. */
export interface PodStatus {
  name: string;
  ready: boolean;
  status: string;
  restarts: number;
  age: string;
}

/** Information about the current cluster connection. */
export interface ClusterInfo {
  user: string;
  server: string;
  namespace: string;
  connected: boolean;
}

/**
 * Run an `oc` command and return the result.
 */
async function oc(args: string[]): Promise<ExecResult> {
  const cmd = new Deno.Command("oc", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

/**
 * Run an `oc` command, throwing on failure.
 */
async function ocOrFail(args: string[]): Promise<string> {
  const result = await oc(args);
  if (!result.success) {
    throw new Error(`oc ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export class ClusterManager {
  private portForwardProcess: Deno.ChildProcess | null = null;

  constructor(
    private remote: RemoteConfig,
    private config: PorterConfig,
  ) {}

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  /** Check if the oc CLI is installed. */
  async hasOcCli(): Promise<boolean> {
    try {
      const result = await oc(["version", "--client"]);
      return result.success;
    } catch {
      return false;
    }
  }

  /** Verify the current oc login session. */
  async verifyAuth(): Promise<ClusterInfo> {
    const userResult = await oc(["whoami"]);
    if (!userResult.success) {
      return {
        user: "",
        server: "",
        namespace: this.remote.namespace,
        connected: false,
      };
    }

    const serverResult = await oc(["whoami", "--show-server"]);

    return {
      user: userResult.stdout,
      server: serverResult.stdout,
      namespace: this.remote.namespace,
      connected: true,
    };
  }

  /** Login with a token. */
  async login(server: string, token: string): Promise<void> {
    await ocOrFail([
      "login",
      server,
      "--token",
      token,
      "--insecure-skip-tls-verify=true",
    ]);
  }

  /** Switch to the configured namespace. */
  async useNamespace(): Promise<void> {
    await ocOrFail(["project", this.remote.namespace]);
  }

  // -----------------------------------------------------------------------
  // Secrets
  // -----------------------------------------------------------------------

  /** Create or update a K8s Secret with the API key. */
  async ensureApiKeySecret(secretName: string, apiKey: string): Promise<void> {
    // Delete existing secret if present
    await oc(["delete", "secret", secretName, "-n", this.remote.namespace, "--ignore-not-found"]);

    // Create new secret
    await ocOrFail([
      "create",
      "secret",
      "generic",
      secretName,
      `--from-literal=ANTHROPIC_API_KEY=${apiKey}`,
      "-n",
      this.remote.namespace,
    ]);
  }

  // -----------------------------------------------------------------------
  // Pod Deployment
  // -----------------------------------------------------------------------

  /** Deploy agent worker pods. */
  async deployWorkers(
    busPort: number,
    agentNames: string[],
  ): Promise<string[]> {
    const secretName = `porter-${this.config.session}-api-key`;
    const apiKey = Deno.env.get(this.config.api_key_env);
    if (!apiKey) {
      throw new Error(`API key not found in env var '${this.config.api_key_env}'`);
    }

    // Ensure the secret exists
    await this.ensureApiKeySecret(secretName, apiKey);

    const podNames: string[] = [];

    for (const agentName of agentNames) {
      const podName = `porter-${this.config.session}-${agentName}`.replace(
        /[^a-z0-9-]/g,
        "-",
      ).toLowerCase();

      // Delete existing pod if present
      await oc(["delete", "pod", podName, "-n", this.remote.namespace, "--ignore-not-found"]);

      // Create the pod
      const podSpec = this.buildPodSpec(podName, secretName, agentName, busPort);
      const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
      await Deno.writeTextFile(tmpFile, JSON.stringify(podSpec));

      try {
        await ocOrFail(["apply", "-f", tmpFile, "-n", this.remote.namespace]);
      } finally {
        await Deno.remove(tmpFile);
      }

      podNames.push(podName);
    }

    return podNames;
  }

  /** Wait for all pods to be ready. */
  async waitForPods(podNames: string[], timeoutSeconds = 120): Promise<void> {
    for (const podName of podNames) {
      await ocOrFail([
        "wait",
        `pod/${podName}`,
        "--for=condition=Ready",
        `--timeout=${timeoutSeconds}s`,
        "-n",
        this.remote.namespace,
      ]);
    }
  }

  /** Get status of all porter pods. */
  async getPodStatuses(): Promise<PodStatus[]> {
    const result = await oc([
      "get",
      "pods",
      "-n",
      this.remote.namespace,
      "-l",
      `app=porter,session=${this.config.session}`,
      "-o",
      "jsonpath={range .items[*]}{.metadata.name}\\t{.status.phase}\\t{.status.containerStatuses[0].ready}\\t{.status.containerStatuses[0].restartCount}\\n{end}",
    ]);

    if (!result.success || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, status, ready, restarts] = line.split("\t");
        return {
          name,
          ready: ready === "true",
          status,
          restarts: parseInt(restarts) || 0,
          age: "",
        };
      });
  }

  /** Delete a specific worker pod. */
  async deletePod(podName: string): Promise<void> {
    await oc(["delete", "pod", podName, "-n", this.remote.namespace, "--grace-period=10"]);
  }

  /** Delete all porter pods and secrets for this session. */
  async teardown(): Promise<void> {
    // Delete pods
    await oc([
      "delete",
      "pods",
      "-n",
      this.remote.namespace,
      "-l",
      `app=porter,session=${this.config.session}`,
    ]);

    // Delete secret
    const secretName = `porter-${this.config.session}-api-key`;
    await oc(["delete", "secret", secretName, "-n", this.remote.namespace, "--ignore-not-found"]);
  }

  // -----------------------------------------------------------------------
  // Port forwarding
  // -----------------------------------------------------------------------

  /**
   * Start port-forwarding from a local port to a pod's port.
   * This is used to expose the WebSocket bus to remote workers.
   *
   * For remote workers to reach the orchestrator, we actually need the
   * reverse: workers connect out to the orchestrator. So port-forward
   * is used when the orchestrator needs to reach into pods.
   */
  async startPortForward(
    podName: string,
    localPort: number,
    remotePort: number,
  ): Promise<void> {
    const cmd = new Deno.Command("oc", {
      args: [
        "port-forward",
        `pod/${podName}`,
        `${localPort}:${remotePort}`,
        "-n",
        this.remote.namespace,
      ],
      stdout: "null",
      stderr: "piped",
    });

    this.portForwardProcess = cmd.spawn();
  }

  /** Stop the active port-forward. */
  stopPortForward(): void {
    if (this.portForwardProcess) {
      try {
        this.portForwardProcess.kill("SIGTERM");
      } catch { /* already stopped */ }
      this.portForwardProcess = null;
    }
  }

  // -----------------------------------------------------------------------
  // Pod spec builder
  // -----------------------------------------------------------------------

  private buildPodSpec(
    podName: string,
    secretName: string,
    agentName: string,
    busPort: number,
  ): Record<string, unknown> {
    // Build runtime tool init containers if configured
    const toolPieces = this.config.runtime_tools?.length
      ? buildToolInitContainers(this.config.runtime_tools)
      : undefined;

    const containerEnv = [
      {
        name: "ANTHROPIC_API_KEY",
        valueFrom: {
          secretKeyRef: {
            name: secretName,
            key: "ANTHROPIC_API_KEY",
          },
        },
      },
      {
        name: "PORTER_AGENT_NAME",
        value: agentName,
      },
      {
        name: "PORTER_BUS_URL",
        value: `ws://porter-bus:${busPort}`,
      },
      {
        name: "PORTER_CONFIG",
        value: JSON.stringify(
          this.config.agents.find((a) => a.name === agentName) ?? {},
        ),
      },
      {
        name: "PORTER_SESSION",
        value: this.config.session,
      },
      {
        name: "PORTER_TEAM_ROSTER",
        value: JSON.stringify(
          this.config.agents.map((a) => ({ name: a.name, role: a.role })),
        ),
      },
      // Merge runtime tool PATH env if present
      ...(toolPieces?.env ?? []),
    ];

    const containerVolumeMounts = [
      // Merge runtime tool volume mounts if present
      ...(toolPieces?.volumeMounts ?? []),
    ];

    const spec: Record<string, unknown> = {
      containers: [
        {
          name: "worker",
          image: this.remote.image,
          command: [
            "deno",
            "run",
            "--allow-all",
            "worker.ts",
          ],
          env: containerEnv,
          ...(containerVolumeMounts.length > 0
            ? { volumeMounts: containerVolumeMounts }
            : {}),
          resources: {
            requests: {
              cpu: "250m",
              memory: "256Mi",
            },
            limits: {
              cpu: "1",
              memory: "512Mi",
            },
          },
        },
      ],
      restartPolicy: "OnFailure",
    };

    // Add init containers and volumes for runtime tools
    if (toolPieces) {
      spec.initContainers = toolPieces.initContainers;
      spec.volumes = toolPieces.volumes;
    }

    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: this.remote.namespace,
        labels: {
          app: "porter",
          session: this.config.session,
          agent: agentName,
        },
      },
      spec,
    };
  }
}
