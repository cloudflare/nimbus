import { defineCollection, z } from "astro:content";
import { componentsCollection, docsCollection, partialsCollection } from "nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal("human").optional(),
        // Flags a page that was drafted by an AI agent and has not yet been
        // reviewed by a human. Surfaces an "awaiting review" label in the
        // page actions. Remove the flag once a human has reviewed the page.
        aiGenerated: z.boolean().optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
  components: defineCollection(componentsCollection()),
};
