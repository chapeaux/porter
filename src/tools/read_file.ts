import { isPathEscapeError, validatePath } from "../sandbox/mod.ts";
import type { ToolEntry } from "./mod.ts";

let _workingDir: string | null = null;

export function setWorkingDir(dir: string | null): void {
  _workingDir = dir;
}

const entry: ToolEntry = {
  definition: {
    name: "read_file",
    description:
      "Read a file and return its contents with line numbers. Supports optional offset and limit for large files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to read.",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (0-based). Default: 0.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to return. Default: 2000.",
        },
      },
      required: ["path"],
    },
  },

  async execute(params) {
    let path = params.path as string;
    const offset = (params.offset as number) ?? 0;
    const limit = (params.limit as number) ?? 2000;

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
      const text = await Deno.readTextFile(path);
      const lines = text.split("\n");
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map(
        (line, i) => `${(offset + i + 1).toString().padStart(6)}\t${line}`,
      );
      return { content: numbered.join("\n") };
    } catch (err) {
      return {
        content: `Error reading ${path}: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
