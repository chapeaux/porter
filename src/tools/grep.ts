import { walk } from "@std/fs";
import { isPathEscapeError, validatePath } from "../sandbox/mod.ts";
import type { ToolEntry } from "./mod.ts";

let _workingDir: string | null = null;

export function setWorkingDir(dir: string | null): void {
  _workingDir = dir;
}

const entry: ToolEntry = {
  definition: {
    name: "grep",
    description:
      "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression pattern to search for.",
        },
        path: {
          type: "string",
          description: "File or directory to search in. Defaults to working directory.",
        },
        glob: {
          type: "string",
          description: "Glob filter for file names (e.g. '*.ts').",
        },
        case_insensitive: {
          type: "boolean",
          description: "Case insensitive search. Default: false.",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching lines. Default: 200.",
        },
      },
      required: ["pattern"],
    },
  },

  async execute(params) {
    const pattern = params.pattern as string;
    let root = (params.path as string) ?? (_workingDir ?? Deno.cwd());
    const globFilter = params.glob as string | undefined;
    const caseInsensitive = (params.case_insensitive as boolean) ?? false;
    const limit = (params.limit as number) ?? 200;

    if (_workingDir) {
      try {
        root = await validatePath(root, _workingDir);
      } catch (err) {
        if (isPathEscapeError(err)) {
          return { content: (err as Error).message, is_error: true };
        }
        throw err;
      }
    }

    try {
      const flags = caseInsensitive ? "i" : "";
      const regex = new RegExp(pattern, flags);
      const results: string[] = [];

      // Check if root is a file or directory
      const stat = await Deno.stat(root);

      if (stat.isFile) {
        await searchFile(root, regex, results, limit);
      } else {
        for await (const entry of walk(root, { includeDirs: false, match: globFilter ? [new RegExp(globToRegex(globFilter))] : undefined })) {
          if (results.length >= limit) break;
          await searchFile(entry.path, regex, results, limit - results.length);
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
  },
};

async function searchFile(
  path: string,
  regex: RegExp,
  results: string[],
  remaining: number,
): Promise<void> {
  try {
    const text = await Deno.readTextFile(path);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && results.length < remaining; i++) {
      if (regex.test(lines[i])) {
        results.push(`${path}:${i + 1}: ${lines[i]}`);
      }
    }
  } catch {
    // Skip files that can't be read (binary, permission denied, etc.)
  }
}

/** Convert a simple glob pattern to a regex string. */
function globToRegex(glob: string): string {
  return glob
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
}

export default entry;
