/**
 * Pod Registry -- maps authenticated users to their per-user orchestrator pods.
 *
 * Each user gets a dedicated Deployment + ClusterIP Service running
 * `porter serve --headless --single-user`. The registry tracks pod
 * lifecycle and deprovisions idle pods after a configurable timeout.
 *
 * Uses the in-cluster Kubernetes REST API via the mounted service
 * account token — no `oc` or `kubectl` CLI required.
 */

/** Metadata about a provisioned user pod. */
export interface PodEntry {
  userId: string;
  podName: string;
  serviceName: string;
  podUrl: string;
  lastSeen: number;
  ready: boolean;
}

/**
 * Sanitize a user ID for use in Kubernetes resource names.
 * K8s names must be lowercase alphanumeric with dashes, max 63 chars.
 */
function sanitizeUserId(userId: string): string {
  return userId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
}

/**
 * Read the in-cluster service account token and CA cert.
 */
let _clusterConfig: { apiServer: string; token: string; tlsClient: Deno.HttpClient } | null = null;

function inClusterConfig(): { apiServer: string; token: string; tlsClient: Deno.HttpClient } {
  if (_clusterConfig) return _clusterConfig;

  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

  const token = Deno.readTextFileSync(tokenPath).trim();

  const host = Deno.env.get("KUBERNETES_SERVICE_HOST") ?? "kubernetes.default.svc";
  const port = Deno.env.get("KUBERNETES_SERVICE_PORT") ?? "443";

  let caCert: string | undefined;
  try {
    caCert = Deno.readTextFileSync(caPath);
  } catch { /* optional */ }

  const tlsClient = Deno.createHttpClient({
    caCerts: caCert ? [caCert] : [],
  });

  _clusterConfig = { apiServer: `https://${host}:${port}`, token, tlsClient };
  return _clusterConfig;
}

/**
 * Make an authenticated request to the Kubernetes API.
 */
async function k8sRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { apiServer, token, tlsClient } = inClusterConfig();

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(`${apiServer}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    client: tlsClient,
  });

  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
}

export class PodRegistry {
  private entries = new Map<string, PodEntry>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private image: string;
  private imagePullSecret: string | undefined;

  constructor(
    private namespace: string,
    private idleTimeoutMs: number,
    image?: string,
  ) {
    this.image = image ?? Deno.env.get("PORTER_USER_POD_IMAGE") ??
      `image-registry.openshift-image-registry.svc:5000/${namespace}/porter:latest`;
    this.imagePullSecret = Deno.env.get("PORTER_IMAGE_PULL_SECRET");
  }

  get(userId: string): PodEntry | undefined {
    return this.entries.get(userId);
  }

  touch(userId: string): void {
    const entry = this.entries.get(userId);
    if (entry) entry.lastSeen = Date.now();
  }

  evict(userId: string): void {
    this.entries.delete(userId);
  }

  async provision(userId: string): Promise<PodEntry> {
    const existing = this.entries.get(userId);
    if (existing) return existing;

    const sanitized = sanitizeUserId(userId);
    const podName = `porter-user-${sanitized}`;
    const serviceName = `porter-user-${sanitized}-svc`;
    const podUrl = `http://${serviceName}.${this.namespace}.svc.cluster.local:3000`;

    const entry: PodEntry = {
      userId,
      podName,
      serviceName,
      podUrl,
      lastSeen: Date.now(),
      ready: false,
    };

    // Create Deployment (skip if already exists — 409 means a previous pod is still around)
    const deploySpec = this.buildDeploymentSpec(entry);
    const deployPath = `/apis/apps/v1/namespaces/${this.namespace}/deployments`;
    const result = await k8sRequest("POST", deployPath, deploySpec);
    if (!result.ok && result.status !== 409) {
      const msg = (result.data as Record<string, unknown>)?.message ?? JSON.stringify(result.data);
      throw new Error(`Failed to create deployment ${podName}: ${msg}`);
    }

    // Create Service (skip if already exists)
    const svcSpec = this.buildServiceSpec(entry);
    const svcPath = `/api/v1/namespaces/${this.namespace}/services`;
    const svcResult = await k8sRequest("POST", svcPath, svcSpec);
    if (!svcResult.ok && svcResult.status !== 409) {
      const msg = (svcResult.data as Record<string, unknown>)?.message ?? JSON.stringify(svcResult.data);
      throw new Error(`Failed to create service ${serviceName}: ${msg}`);
    }

    // Create NetworkPolicy for the user pod (allow ingress from router)
    await this.ensureNetworkPolicy(entry);

    this.entries.set(userId, entry);
    console.log(`[router] Provisioned pod for user ${userId}: ${podName}`);
    return entry;
  }

  async deprovision(userId: string): Promise<void> {
    const entry = this.entries.get(userId);
    if (!entry) return;

    await k8sRequest(
      "DELETE",
      `/apis/apps/v1/namespaces/${this.namespace}/deployments/${entry.podName}`,
    );
    await k8sRequest(
      "DELETE",
      `/api/v1/namespaces/${this.namespace}/services/${entry.serviceName}`,
    );

    this.entries.delete(userId);
    console.log(`[router] Deprovisioned pod for user ${userId}: ${entry.podName}`);
  }

  async checkReady(userId: string): Promise<boolean> {
    const entry = this.entries.get(userId);
    if (!entry) return false;

    const sanitized = sanitizeUserId(userId);
    const result = await k8sRequest(
      "GET",
      `/api/v1/namespaces/${this.namespace}/pods?labelSelector=porter.io/user=${sanitized}`,
    );

    if (!result.ok) return false;

    const pods = (result.data as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined;
    if (!pods?.length) return false;

    const conditions = ((pods[0].status as Record<string, unknown>)?.conditions as Record<string, unknown>[]) ?? [];
    const readyCond = conditions.find(c => c.type === "Ready");
    const ready = readyCond?.status === "True";
    entry.ready = ready;
    return ready;
  }

  startIdleSweep(): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(async () => {
      const now = Date.now();
      const expired: string[] = [];
      for (const [userId, entry] of this.entries) {
        if (now - entry.lastSeen > this.idleTimeoutMs) {
          expired.push(userId);
        }
      }
      for (const userId of expired) {
        console.log(`[router] User ${userId} idle for >${this.idleTimeoutMs / 60000}m, deprovisioning...`);
        try { await this.deprovision(userId); } catch (err) {
          console.error(`[router] Failed to deprovision pod for ${userId}: ${(err as Error).message}`);
        }
      }
    }, 60_000);
  }

  stopIdleSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  listEntries(): PodEntry[] {
    return [...this.entries.values()];
  }

  private async ensureNetworkPolicy(entry: PodEntry): Promise<void> {
    const sanitized = sanitizeUserId(entry.userId);
    const npName = `allow-porter-user-${sanitized}-ingress`;
    const spec = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: npName,
        namespace: this.namespace,
        labels: { app: "porter", "porter.io/user": sanitized },
      },
      spec: {
        podSelector: {
          matchLabels: { app: "porter", "porter.io/user": sanitized },
        },
        ingress: [{
          from: [
            { podSelector: { matchLabels: { app: "porter", component: "router" } } },
            { namespaceSelector: { matchLabels: { "network.openshift.io/policy-group": "ingress" } } },
          ],
          ports: [{ port: 3000, protocol: "TCP" }],
        }],
        policyTypes: ["Ingress"],
      },
    };

    const result = await k8sRequest(
      "POST",
      `/apis/networking.k8s.io/v1/namespaces/${this.namespace}/networkpolicies`,
      spec,
    );
    if (!result.ok && result.status !== 409) {
      console.error(`[router] Warning: failed to create NetworkPolicy for ${entry.podName}`);
    }
  }

  private buildDeploymentSpec(entry: PodEntry): Record<string, unknown> {
    const sanitized = sanitizeUserId(entry.userId);
    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: entry.podName,
        namespace: this.namespace,
        labels: {
          app: "porter",
          "app.kubernetes.io/part-of": "porter",
          "app.kubernetes.io/component": "user-orchestrator",
          component: "user-orchestrator",
          "porter.io/user": sanitized,
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: "porter",
            component: "user-orchestrator",
            "porter.io/user": sanitized,
          },
        },
        template: {
          metadata: {
            labels: {
              app: "porter",
              "app.kubernetes.io/part-of": "porter",
              "app.kubernetes.io/component": "user-orchestrator",
              component: "user-orchestrator",
              "porter.io/user": sanitized,
            },
          },
          spec: {
            containers: [{
              name: "orchestrator",
              image: this.image,
              imagePullPolicy: "Always",
              command: [
                "deno", "run", "--allow-all", "cli.ts",
                "serve", "--port", "3000", "--headless", "--single-user",
              ],
              ports: [{ containerPort: 3000 }],
              env: [
                { name: "TERM", value: "dumb" },
                { name: "PORTER_SINGLE_USER", value: "true" },
                { name: "HOME", value: "/app" },
                ...(Deno.env.get("PORTER_LWS_BASE_URL") ? [{ name: "PORTER_LWS_BASE_URL", value: Deno.env.get("PORTER_LWS_BASE_URL") }] : []),
                // Credential persistence: session key + S3/MinIO config
                ...(Deno.env.get("PORTER_SESSION_KEY") ? [{ name: "PORTER_SESSION_KEY", value: Deno.env.get("PORTER_SESSION_KEY") }] : []),
                ...(Deno.env.get("S3_ENDPOINT") ? [{ name: "S3_ENDPOINT", value: Deno.env.get("S3_ENDPOINT") }] : []),
                ...(Deno.env.get("S3_BUCKET") ? [{ name: "S3_BUCKET", value: Deno.env.get("S3_BUCKET") }] : []),
                ...(Deno.env.get("S3_ACCESS_KEY") ? [{ name: "S3_ACCESS_KEY", value: Deno.env.get("S3_ACCESS_KEY") }] : []),
                ...(Deno.env.get("S3_SECRET_KEY") ? [{ name: "S3_SECRET_KEY", value: Deno.env.get("S3_SECRET_KEY") }] : []),
                ...(Deno.env.get("S3_REGION") ? [{ name: "S3_REGION", value: Deno.env.get("S3_REGION") }] : []),
                ...(Deno.env.get("QDRANT_URL") ? [{ name: "QDRANT_URL", value: Deno.env.get("QDRANT_URL") }] : []),
              ],
              volumeMounts: [
                { name: "porter-home", mountPath: "/app/.porter" },
                { name: "workspace", mountPath: "/workspace" },
                { name: "redhat-ca", mountPath: "/etc/porter-certs", readOnly: true },
              ],
              resources: {
                requests: { cpu: "500m", memory: "512Mi" },
                limits: { cpu: "2", memory: "1Gi" },
              },
              livenessProbe: {
                httpGet: { path: "/healthz", port: 3000 },
                initialDelaySeconds: 3,
                periodSeconds: 30,
              },
              readinessProbe: {
                httpGet: { path: "/healthz", port: 3000 },
                initialDelaySeconds: 2,
                periodSeconds: 3,
              },
            }],
            ...(this.imagePullSecret ? { imagePullSecrets: [{ name: this.imagePullSecret }] } : {}),
            volumes: [
              { name: "workspace", emptyDir: {} },
              { name: "porter-home", emptyDir: {} },
              { name: "redhat-ca", configMap: { name: "redhat-ca-bundle", optional: true } },
            ],
          },
        },
      },
    };
  }

  private buildServiceSpec(entry: PodEntry): Record<string, unknown> {
    const sanitized = sanitizeUserId(entry.userId);
    return {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: entry.serviceName,
        namespace: this.namespace,
        labels: {
          app: "porter",
          component: "user-orchestrator",
          "porter.io/user": sanitized,
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: "porter",
          component: "user-orchestrator",
          "porter.io/user": sanitized,
        },
        ports: [{ port: 3000, targetPort: 3000 }],
      },
    };
  }
}
