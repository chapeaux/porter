import type { ToolEntry } from "./mod.ts";
import { getBus } from "../runtime/bus.ts";

const entry: ToolEntry = {
  definition: {
    name: "send_message",
    description:
      "Send a message to a named channel on the message bus. Other agents subscribed to that channel will receive it.",
    input_schema: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string",
          description:
            "Channel name to publish to (e.g. 'task', 'log', 'control').",
        },
        message: {
          type: "string",
          description: "The message content to send.",
        },
      },
      required: ["channel", "message"],
    },
  },

  async execute(params) {
    const channel = params.channel as string;
    const message = params.message as string;

    try {
      const bus = getBus();
      await bus.publish(channel, message);
      return { content: `Message sent to channel '${channel}'.` };
    } catch (err) {
      return {
        content: `Error sending message: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

export default entry;
