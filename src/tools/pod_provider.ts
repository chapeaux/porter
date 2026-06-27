/**
 * Pod-backed filesystem tool implementations.
 *
 * Routes read/write/list/glob/grep operations to a Solid Pod workspace
 * container via HTTP, using the LDP (Linked Data Platform) protocol.
 *
 * The Pod workspace root is: {podRoot}/porter/sessions/{sessionName}/workspace/
 */

import type { ToolResult } from "./mod.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map file extensions to MIME types for PUT requests. */
export function contentTypeForPath(path: string): string {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
  switch (ext) {
    case ".ts":
      return "application/typescript";
    case ".js":
      return "application/javascript";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

/** Build the full workspace URL for a relative path. */
function workspaceUrl(podRoot: string, session: string, path?: string): string {
  // Normalise podRoot: strip trailing slash
  const root = podRoot.replace(/\/+$/, "");
  const base = `${root}/porter/sessions/${encodeURIComponent(session)}/workspace`;
  if (!path || path === "" || path === "." || path === "/") {
    return `${base}/`;
  }
  // Strip leading slash/dot-slash from path
  const clean = path.replace(/^\.?\//, "");
  return `${base}/${clean}`;
}

/**
 * Ensure a Pod container exists, creating it if necessary.
 *
 * Issues HEAD against the container URL; if 404, PUTs an empty Turtle
 * body with the LDP BasicContainer Link header to create it.
 */
export async function ensurePodContainer(
  containerUrl: string,
  authFetch: typeof fetch,
): Promise<void> {
  // Container URLs must end with /
  const url = containerUrl.endsWith("/") ? containerUrl : `${containerUrl}/`;

  const head = await authFetch(url, { method: "HEAD" });
  if (head.ok) return;

  // Drain the response body (in case of Node/Deno fetch)
  try { await head.text(); } catch { /* ignore */ }

  if (head.status === 404) {
    const res = await authFetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/turtle",
        "Link": '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: "",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Failed to create container ${url}: ${res.status} ${res.statusText} ${body}`,
      );
    }
  }
}

/**
 * Ensure all ancestor containers exist for a resource path.
 *
 * Given a full resource URL like
 *   https://pod.example/porter/sessions/s1/workspace/src/lib/utils.ts
 * this creates containers for /porter/, /porter/sessions/, etc. up to
 * the parent of the resource.
 */
async function ensureParentContainers(
  resourceUrl: string,
  workspaceBase: string,
  authFetch: typeof fetch,
): Promise<void> {
  // Extract the path relative to workspace root
  if (!resourceUrl.startsWith(workspaceBase)) return;
  const relative = resourceUrl.slice(workspaceBase.length);
  const segments = relative.split("/").filter(Boolean);
  // Remove the filename (last segment) — we only need to create containers
  segments.pop();

  let current = workspaceBase.endsWith("/") ? workspaceBase : `${workspaceBase}/`;
  for (const seg of segments) {
    current = `${current}${seg}/`;
    await ensurePodContainer(current, authFetch);
  }
}

/**
 * Parse an LDP container listing in Turtle format and extract contained
 * resource names.
 *
 * Expects triples of the form:
 *   <> ldp:contains <file1.ts>, <file2.ts>, <subdir/> .
 *
 * Returns the list of relative names (e.g. ["file1.ts", "file2.ts", "subdir/"]).
 */
function parseLdpContains(turtle: string, containerUrl: string): string[] {
  const results: string[] = [];

  // Find all URIs referenced by ldp:contains.
  // The Turtle may have the full predicate or prefixed form.
  // Strategy: find all <...> URIs that appear after ldp:contains (or contains),
  // up to the terminating period.
  //
  // We use a simple regex approach: find all URI references (<...>) in the
  // ldp:contains statement.
  const containsPattern =
    /(?:ldp:contains|<http:\/\/www\.w3\.org\/ns\/ldp#contains>)\s+([\s\S]*?)(?:\.\s*$|\.\s*\n)/m;
  const match = turtle.match(containsPattern);
  if (match) {
    const uriList = match[1];
    const uriPattern = /<([^>]+)>/g;
    let uriMatch: RegExpExecArray | null;
    while ((uriMatch = uriPattern.exec(uriList)) !== null) {
      const uri = uriMatch[1];
      // Extract the name relative to the container
      if (uri.startsWith("http://") || uri.startsWith("https://")) {
        // Absolute URI — extract name after container URL
        const base = containerUrl.endsWith("/") ? containerUrl : `${containerUrl}/`;
        if (uri.startsWith(base)) {
          results.push(decodeURIComponent(uri.slice(base.length)));
        } else {
          // Fallback: just grab the last path segment
          const parts = uri.split("/");
          const last = parts[parts.length - 1] || parts[parts.length - 2] + "/";
          results.push(decodeURIComponent(last));
        }
      } else {
        // Relative URI
        results.push(decodeURIComponent(uri));
      }
    }
  }

  return results;
}

/**
 * Recursively list all resources in a container, returning paths relative
 * to the given base URL.
 */
async function listRecursive(
  containerUrl: string,
  authFetch: typeof fetch,
  prefix: string = "",
): Promise<string[]> {
  const url = containerUrl.endsWith("/") ? containerUrl : `${containerUrl}/`;
  const res = await authFetch(url, {
    headers: { "Accept": "text/turtle" },
  });
  if (!res.ok) return [];

  const turtle = await res.text();
  const names = parseLdpContains(turtle, url);
  const results: string[] = [];

  for (const name of names) {
    const fullPath = prefix ? `${prefix}${name}` : name;
    if (name.endsWith("/")) {
      // Recurse into sub-container
      const childUrl = `${url}${name}`;
      const children = await listRecursive(childUrl, authFetch, fullPath);
      results.push(...children);
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Simple glob matcher supporting:
 *   *  — matches any characters except /
 *   ** — matches any path segments (including nested /)
 *   ?  — matches a single character except /
 */
function globMatch(pattern: string, path: string): boolean {
  // Convert glob to regex
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match any path segments
        // Optionally followed by /
        i += 2;
        if (pattern[i] === "/") {
          i++;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        // * — match any chars except /
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === ".") {
      regex += "\\.";
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp(`^${regex}$`).test(path);
}

// ---------------------------------------------------------------------------
// Pod tool functions
// ---------------------------------------------------------------------------

/**
 * Read a file from the Pod workspace.
 *
 * GET {podRoot}/porter/sessions/{session}/workspace/{path}
 */
export async function podReadFile(
  params: { path: string },
  podRoot: string,
  session: string,
  authFetch: typeof fetch,
): Promise<ToolResult> {
  const url = workspaceUrl(podRoot, session, params.path);
  try {
    const res = await authFetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 404) {
        return { content: "File not found", is_error: true };
      }
      return {
        content: `Error reading ${params.path}: ${res.status} ${res.statusText} ${body}`,
        is_error: true,
      };
    }
    const text = await res.text();
    return { content: text };
  } catch (err) {
    return {
      content: `Error reading ${params.path}: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

/**
 * Write a file to the Pod workspace, creating parent containers as needed.
 *
 * PUT {podRoot}/porter/sessions/{session}/workspace/{path}
 */
export async function podWriteFile(
  params: { path: string; content: string },
  podRoot: string,
  session: string,
  authFetch: typeof fetch,
): Promise<ToolResult> {
  const wsBase = workspaceUrl(podRoot, session);
  const url = workspaceUrl(podRoot, session, params.path);

  try {
    // Ensure parent containers exist
    await ensureParentContainers(url, wsBase, authFetch);

    const contentType = contentTypeForPath(params.path);
    const res = await authFetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: params.content,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        content: `Error writing ${params.path}: ${res.status} ${res.statusText} ${body}`,
        is_error: true,
      };
    }

    // Drain success response body
    try { await res.text(); } catch { /* ignore */ }

    const lineCount = params.content.split("\n").length;
    return { content: `Wrote ${lineCount} lines to ${params.path}` };
  } catch (err) {
    return {
      content: `Error writing ${params.path}: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

/**
 * Edit a file on the Pod by performing an exact string replacement.
 *
 * GETs the file, replaces old_string with new_string, PUTs the result back.
 */
export async function podEditFile(
  params: { path: string; old_string: string; new_string: string },
  podRoot: string,
  session: string,
  authFetch: typeof fetch,
): Promise<ToolResult> {
  const url = workspaceUrl(podRoot, session, params.path);

  try {
    // Read the current content
    const getRes = await authFetch(url);
    if (!getRes.ok) {
      if (getRes.status === 404) {
        return { content: `Error: ${params.path} not found`, is_error: true };
      }
      const body = await getRes.text().catch(() => "");
      return {
        content: `Error reading ${params.path}: ${getRes.status} ${getRes.statusText} ${body}`,
        is_error: true,
      };
    }
    const text = await getRes.text();

    // Verify old_string exists
    if (!text.includes(params.old_string)) {
      return {
        content: `Error: old_string not found in ${params.path}`,
        is_error: true,
      };
    }

    // Verify old_string is unique
    const firstIdx = text.indexOf(params.old_string);
    const lastIdx = text.lastIndexOf(params.old_string);
    if (firstIdx !== lastIdx) {
      return {
        content:
          `Error: old_string appears multiple times in ${params.path}. Provide more context to make it unique.`,
        is_error: true,
      };
    }

    // Replace and write back
    const updated = text.replace(params.old_string, params.new_string);
    const contentType = contentTypeForPath(params.path);
    const putRes = await authFetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: updated,
    });

    if (!putRes.ok) {
      const body = await putRes.text().catch(() => "");
      return {
        content: `Error writing ${params.path}: ${putRes.status} ${putRes.statusText} ${body}`,
        is_error: true,
      };
    }

    // Drain success response body
    try { await putRes.text(); } catch { /* ignore */ }

    return { content: `Edited ${params.path}` };
  } catch (err) {
    return {
      content: `Error editing ${params.path}: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

/**
 * List the contents of a Pod container (directory).
 *
 * GETs the container URL with Accept: text/turtle, parses ldp:contains.
 */
export async function podListDir(
  params: { path: string },
  podRoot: string,
  session: string,
  authFetch: typeof fetch,
): Promise<ToolResult> {
  const url = workspaceUrl(podRoot, session, params.path);
  // Ensure trailing slash for container
  const containerUrl = url.endsWith("/") ? url : `${url}/`;

  try {
    const res = await authFetch(containerUrl, {
      headers: { "Accept": "text/turtle" },
    });

    if (!res.ok) {
      if (res.status === 404) {
        return {
          content: `Error: directory ${params.path} not found`,
          is_error: true,
        };
      }
      const body = await res.text().catch(() => "");
      return {
        content: `Error listing ${params.path}: ${res.status} ${res.statusText} ${body}`,
        is_error: true,
      };
    }

    const turtle = await res.text();
    const names = parseLdpContains(turtle, containerUrl);

    if (names.length === 0) {
      return { content: "(empty directory)" };
    }

    names.sort();
    return { content: names.join("\n") };
  } catch (err) {
    return {
      content: `Error listing ${params.path}: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

/**
 * Find files matching a glob pattern in the Pod workspace.
 *
 * Recursively lists containers and matches filenames against the pattern.
 */
export async function podGlob(
  params: { pattern: string; path?: string },
  podRoot: string,
  session: string,
  authFetch: typeof fetch,
): Promise<ToolResult> {
  const searchRoot = params.path
    ? workspaceUrl(podRoot, session, params.path)
    : workspaceUrl(podRoot, session);

  // Ensure trailing slash for container
  const containerUrl = searchRoot.endsWith("/")
    ? searchRoot
    : `${searchRoot}/`;

  try {
    const allPaths = await listRecursive(containerUrl, authFetch);
    const matches = allPaths.filter((p) => globMatch(params.pattern, p));

    if (matches.length === 0) {
      return { content: "No files found." };
    }

    return { content: matches.join("\n") };
  } catch (err) {
    return {
      content: `Error globbing: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

/**
 * Search file contents in the Pod workspace for a regex pattern.
 *
 * Recursively lists containers, GETs each file, and matches lines
 * against the pattern. Returns results in grep -n format.
 * Limited to 50 results to avoid overwhelming the model.
 */
export async function podGrep(
  params: { pattern: string; path?: string },
  podRoot: string,
  session: string,
  authFetch: typeof fetch,
): Promise<ToolResult> {
  const searchRoot = params.path
    ? workspaceUrl(podRoot, session, params.path)
    : workspaceUrl(podRoot, session);

  const containerUrl = searchRoot.endsWith("/")
    ? searchRoot
    : `${searchRoot}/`;

  const MAX_RESULTS = 50;

  try {
    const regex = new RegExp(params.pattern);
    const allPaths = await listRecursive(containerUrl, authFetch);
    const results: string[] = [];

    for (const filePath of allPaths) {
      if (results.length >= MAX_RESULTS) break;

      // Skip directories (they end with /)
      if (filePath.endsWith("/")) continue;

      const fileUrl = `${containerUrl}${filePath}`;
      try {
        const res = await authFetch(fileUrl);
        if (!res.ok) continue;
        const text = await res.text();
        const lines = text.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_RESULTS) break;
          if (regex.test(lines[i])) {
            results.push(`${filePath}:${i + 1}: ${lines[i]}`);
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    if (results.length === 0) {
      return { content: "No matches found." };
    }

    return { content: results.join("\n") };
  } catch (err) {
    return {
      content: `Error searching: ${(err as Error).message}`,
      is_error: true,
    };
  }
}
