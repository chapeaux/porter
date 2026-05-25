import { isPathEscapeError, validatePath } from "../sandbox/mod.ts";
import type { ToolEntry } from "./mod.ts";

let _workingDir: string | null = null;

export function setWorkingDir(dir: string | null): void {
  _workingDir = dir;
}

const entry: ToolEntry = {
  definition: {
    name: "list_dir",
    description:
      "List the contents of a directory with file type indicators.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the directory to list.",
        },
      },
      required: ["path"],
    },
  },

  async execute(params) {
    let path = params.path as string;

    if (_workingDir) {
      try {
        path = await validatePath(path, _workingDir);
      } catch (err) {
        if (isPathEscapeError(err)) {
          return { content: (err as Error).message, is_error: true };
        }
        throw err;
      }
    }

    try {
      const entries: string[] = [];
      for await (const entry of Deno.readDir(path)) {
        const suffix = entry.isDirectory ? "/" : entry.isSymlink ? "@" : "";
        entries.push(`${entry.name}${suffix}`);
      }

      entries.sort();

      if (entries.length === 0) {
        return { content: "(empty directory)" };
      }

      return { content: entries.join("\n") };
    } catch (err) {
      return {
        content: `Error listing ${path}: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
