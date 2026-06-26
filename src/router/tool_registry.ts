/**
 * Runtime tool registry -- maps short tool names to OCI images and binary paths.
 * All images are from Red Hat UBI -- signed, security-scanned, RHEL-based.
 */

export interface ToolSpec {
  name: string;
  image: string;
  binPath: string;
}

export const TOOL_REGISTRY: Record<string, { image: string; binPath: string }> = {
  curl:    { image: "registry.access.redhat.com/ubi9/ubi-minimal:latest",  binPath: "/usr/bin/curl" },
  wget:    { image: "registry.access.redhat.com/ubi9/ubi-minimal:latest",  binPath: "/usr/bin/wget" },
  python3: { image: "registry.access.redhat.com/ubi9/python-311:latest",   binPath: "/usr/bin/python3" },
  nodejs:  { image: "registry.access.redhat.com/ubi9/nodejs-20:latest",    binPath: "/usr/bin/node" },
  jq:      { image: "registry.access.redhat.com/ubi9/ubi-minimal:latest",  binPath: "/usr/bin/jq" },
  deno:    { image: "docker.io/denoland/deno:latest",                      binPath: "/usr/bin/deno" },
};

export const ALLOWED_REGISTRIES = [
  "registry.access.redhat.com",
  "registry.redhat.io",
  "quay.io",
  "docker.io",
];

/**
 * Validate and resolve a tool specification.
 * Short names are looked up in TOOL_REGISTRY.
 * Custom entries must come from an allowed registry.
 */
export function validateToolSpec(
  spec: string | { name: string; image: string; binPath: string },
): ToolSpec {
  if (typeof spec === "string") {
    const entry = TOOL_REGISTRY[spec];
    if (!entry) {
      throw new Error(
        `Unknown runtime tool: '${spec}'. Available: ${Object.keys(TOOL_REGISTRY).join(", ")}`,
      );
    }
    return { name: spec, ...entry };
  }
  // Custom entry -- validate required fields
  if (!spec.name || !spec.image || !spec.binPath) {
    throw new Error("Custom tool entry requires 'name', 'image', and 'binPath' fields.");
  }
  // Custom entry -- validate registry
  const imageHost = spec.image.split("/")[0];
  if (!ALLOWED_REGISTRIES.some((r) => imageHost === r || imageHost.endsWith("." + r))) {
    throw new Error(
      `Image registry not allowed: '${imageHost}'. Allowed: ${ALLOWED_REGISTRIES.join(", ")}`,
    );
  }
  return spec;
}

/**
 * Build Kubernetes init container specs and volume configuration for runtime tools.
 * Returns the pieces needed to inject into a pod spec.
 */
export function buildToolInitContainers(
  tools: Array<string | { name: string; image: string; binPath: string }>,
): {
  initContainers: Array<{
    name: string;
    image: string;
    command: string[];
    volumeMounts: Array<{ name: string; mountPath: string }>;
  }>;
  volumes: Array<{ name: string; emptyDir: Record<string, never> }>;
  volumeMounts: Array<{ name: string; mountPath: string }>;
  env: Array<{ name: string; value: string }>;
} {
  const validated = tools.map(validateToolSpec);

  const initContainers = validated.map((tool) => ({
    name: `tool-${tool.name}`,
    image: tool.image,
    command: ["cp", tool.binPath, `/porter/tools/${tool.name}`],
    volumeMounts: [{ name: "porter-tools", mountPath: "/porter/tools" }],
  }));

  return {
    initContainers,
    volumes: [{ name: "porter-tools", emptyDir: {} as Record<string, never> }],
    volumeMounts: [{ name: "porter-tools", mountPath: "/porter/tools" }],
    env: [{ name: "PATH", value: "/porter/tools:${PATH}" }],
  };
}
