import type { ToolEntry } from "./mod.ts";
import { getBus } from "../runtime/bus.ts";

const entry: ToolEntry = {
  definition: {
    name: "read_messages",
    description:
      "Read pending messages from subscribed channels. Returns all unread messages and clears them.",
    input_schema: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string",
          description:
            "Channel name to read from. If omitted, reads from all subscribed channels.",
        },
      },
    },
  },

  async execute(params) {
    const channel = params.channel as string | undefined;

    try {
      const bus = getBus();
      const messages = await bus.drain(channel);

      if (messages.length === 0) {
        return { content: "No pending messages." };
      }

      const formatted = messages.map(
        (m) => `[${m.channel}] ${m.from}: ${m.content}`,
      );
      return { content: formatted.join("\n") };
    } catch (err) {
      return {
        content: `Error reading messages: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
