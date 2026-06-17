import type { ToolEntry } from "./mod.ts";

const entry: ToolEntry = {
  definition: {
    name: "ap_reply",
    description:
      "Reply to the fediverse user who initiated this session. " +
      "Use instead of send_message when you want to respond directly to the human. " +
      "Supports longer content than the automatic bridge relay.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "HTML content of the reply.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "File path to attach (relative to working dir).",
              },
              description: {
                type: "string",
                description: "Alt text / description of the attachment.",
              },
            },
            required: ["path"],
          },
          description:
            "Files to attach (optional). Images, diffs, logs, etc.",
        },
      },
      required: ["content"],
    },
  },

  async execute(params) {
    const { getApContext } = await import("../activitypub/context.ts");
    const ap = getApContext();
    if (!ap) {
      return {
        content: "ActivityPub is not enabled for this session.",
        is_error: true,
      };
    }

    const attachments = (params.attachments as Array<{ path: string; description?: string }>) ?? [];
    await ap.reply({
      content: params.content as string,
      attachments,
    });
    return { content: "Reply sent to fediverse user." };
  },
};

export default entry;
