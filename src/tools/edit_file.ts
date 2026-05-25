import { isPathEscapeError, validatePath } from "../sandbox/mod.ts";
import type { ToolEntry } from "./mod.ts";

let _workingDir: string | null = null;

export function setWorkingDir(dir: string | null): void {
  _workingDir = dir;
}

const entry: ToolEntry = {
  definition: {
    name: "edit_file",
    description:
      "Perform an exact string replacement in a file. The old_string must appear exactly once in the file (unless replace_all is true).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file to edit.",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace.",
        },
        new_string: {
          type: "string",
          description: "The replacement string.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences. Default: false.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },

  async execute(params) {
    let path = params.path as string | undefined;
    const oldStr = params.old_string as string | undefined;
    const newStr = params.new_string as string | undefined;
    if (!path || path === "undefined") {
      return { content: "Error: 'path' parameter is required.", is_error: true };
    }
    if (!oldStr) {
      return { content: "Error: 'old_string' parameter is required.", is_error: true };
    }
    if (newStr === undefined || newStr === null) {
      return { content: "Error: 'new_string' parameter is required.", is_error: true };
    }
    const replaceAll = (params.replace_all as boolean) ?? false;

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

      if (!text.includes(oldStr)) {
        return {
          content: `Error: old_string not found in ${path}`,
          is_error: true,
        };
      }

      if (!replaceAll) {
        const firstIdx = text.indexOf(oldStr);
        const lastIdx = text.lastIndexOf(oldStr);
        if (firstIdx !== lastIdx) {
          return {
            content:
              `Error: old_string appears multiple times in ${path}. Use replace_all or provide more context.`,
            is_error: true,
          };
        }
      }

      const updated = replaceAll
        ? text.replaceAll(oldStr, newStr)
        : text.replace(oldStr, newStr);

      await Deno.writeTextFile(path, updated);
      return { content: `Edited ${path}` };
    } catch (err) {
      return {
        content: `Error editing ${path}: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
