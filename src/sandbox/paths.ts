import { normalize, resolve } from "@std/path";

export class PathEscapeError extends Error {
  constructor(originalPath: string, resolvedPath: string, workingDir: string) {
    super(
      `Path '${originalPath}' resolves to '${resolvedPath}' which is outside the workspace '${workingDir}'`,
    );
    this.name = "PathEscapeError";
  }
}

export function isPathEscapeError(err: unknown): err is PathEscapeError {
  return err instanceof PathEscapeError;
}

/**
 * Resolve a path that may not exist yet by finding the nearest existing
 * ancestor, resolving its real path (following symlinks), and appending
 * the remaining segments.
 */
async function resolveNewPath(absPath: string, _workingDir: string): Promise<string> {
  const parts = absPath.split("/");
  for (let i = parts.length; i > 0; i--) {
    const ancestor = parts.slice(0, i).join("/") || "/";
    try {
      const realAncestor = await Deno.realPath(ancestor);
      const remainder = parts.slice(i).join("/");
      return normalize(remainder ? `${realAncestor}/${remainder}` : realAncestor);
    } catch {
      continue;
    }
  }
  return normalize(absPath);
}

/**
 * Validate that `path` resolves to a location within `workingDir`.
 *
 * Handles relative paths, `..` traversal, symlinks, and paths to files
 * that don't exist yet (for write operations).
 *
 * @returns The fully-resolved, normalized absolute path.
 * @throws {PathEscapeError} if the path escapes the workspace.
 */
export async function validatePath(
  path: string,
  workingDir: string,
): Promise<string> {
  // Reject null bytes
  if (path.includes("\0")) {
    throw new PathEscapeError(path, path, workingDir);
  }

  // Reject empty / whitespace-only paths
  if (!path || !path.trim()) {
    throw new PathEscapeError(path, path, workingDir);
  }

  // Resolve relative paths against the working directory
  const absPath = path.startsWith("/") ? path : resolve(workingDir, path);

  // Normalize to collapse `.`, `..`, double slashes
  const normalizedPath = normalize(absPath);

  // Attempt symlink-aware resolution
  let resolvedPath: string;
  try {
    resolvedPath = await Deno.realPath(normalizedPath);
  } catch {
    // File doesn't exist yet — walk up to find nearest real ancestor
    resolvedPath = await resolveNewPath(normalizedPath, workingDir);
  }

  // Normalize the workspace directory the same way
  const normalizedWorkingDir = normalize(await Deno.realPath(workingDir));

  // Final containment check
  if (
    resolvedPath !== normalizedWorkingDir &&
    !resolvedPath.startsWith(normalizedWorkingDir + "/")
  ) {
    throw new PathEscapeError(path, resolvedPath, workingDir);
  }

  return resolvedPath;
}
