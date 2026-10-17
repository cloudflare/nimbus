import { defineCollection } from "astro:content";
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
import { z } from "astro/zod";
import { apiCollection, docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal("human").optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
  api: defineCollection(apiCollection()),
  // The changelog recipe: a docs-shaped collection with a date and tags.
  changelog: defineCollection(
    docsCollection({
      base: "changelog",
      schemaFields: {
        date: z.coerce.date(),
        // The release this entry shipped in; the page's contents list them.
        version: z.string().optional(),
        // Products the entry touches; the feed's filter is built from them.
        tags: z.array(z.string()).default([]),
      },
    }),
  ),
};
