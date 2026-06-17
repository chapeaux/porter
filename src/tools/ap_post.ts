import type { ToolEntry } from "./mod.ts";

const entry: ToolEntry = {
  definition: {
    name: "ap_post",
    description:
      "Post a message to the team's ActivityPub followers. Use for sharing findings, summaries, or status updates with the fediverse audience.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description:
            "HTML content of the post (basic formatting: <p>, <code>, <a>).",
        },
        visibility: {
          type: "string",
          enum: ["public", "followers_only"],
          description:
            "Who can see this post. Default: followers_only.",
        },
        summary: {
          type: "string",
          description:
            "Content warning / summary text (optional). Shown collapsed in Mastodon.",
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

    const visibility = (params.visibility as string) ?? "followers_only";
    await ap.post({
      content: params.content as string,
      visibility,
      summary: params.summary as string | undefined,
    });
    return { content: `Posted to ${visibility} audience.` };
  },
};

export default entry;
