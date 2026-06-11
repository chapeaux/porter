import { expandGlob } from "jsr:@std/fs@^1";
import { isPathEscapeError, validatePath } from "../sandbox/mod.ts";
import type { ToolEntry } from "./mod.ts";

let _workingDir: string | null = null;

export function setWorkingDir(dir: string | null): void {
  _workingDir = dir;
}

const entry: ToolEntry = {
  definition: {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns matching file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.json').",
        },
        path: {
          type: "string",
          description: "Directory to search in. Defaults to working directory.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results. Default: 200.",
        },
      },
      required: ["pattern"],
    },
  },

  async execute(params) {
    const pattern = params.pattern as string;
    let root = (params.path as string) ?? (_workingDir ?? Deno.cwd());
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
      const matches: string[] = [];
      for await (const entry of expandGlob(pattern, { root, extended: true, globstar: true })) {
        if (entry.isFile) {
          matches.push(entry.path);
          if (matches.length >= limit) break;
        }
      }

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
  },
};

export default entry;
