import type { ToolEntry } from "./mod.ts";

const entry: ToolEntry = {
  definition: {
    name: "ap_boost",
    description:
      "Boost (repost) an ActivityPub post by URL. " +
      "Use to amplify relevant content to the team's followers.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL of the post to boost.",
        },
      },
      required: ["url"],
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

    await ap.boost(params.url as string);
    return { content: `Boosted: ${params.url}` };
  },
};

export default entry;
