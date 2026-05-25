import { dirname } from "@std/path";
import { isPathEscapeError, validatePath } from "../sandbox/mod.ts";
import type { ToolEntry } from "./mod.ts";

let _workingDir: string | null = null;

export function setWorkingDir(dir: string | null): void {
  _workingDir = dir;
}

const entry: ToolEntry = {
  definition: {
    name: "write_file",
    description:
      "Write content to a file, creating it if it doesn't exist. Creates parent directories as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to write.",
        },
        content: {
          type: "string",
          description: "The content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },

  async execute(params) {
    let path = params.path as string | undefined;
    const content = params.content as string | undefined;
    if (!path || path === "undefined") {
      return { content: "Error: 'path' parameter is required.", is_error: true };
    }
    if (content === undefined || content === null) {
      return { content: "Error: 'content' parameter is required.", is_error: true };
    }

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
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, content);
      return { content: `Wrote ${content.split("\n").length} lines to ${path}` };
    } catch (err) {
      return {
        content: `Error writing ${path}: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
