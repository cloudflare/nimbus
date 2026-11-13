import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { pathToFileURL } from "node:url";
import { componentsCollection, docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";
import { componentsSchema } from "@cloudflare/nimbus-docs/schemas";
import { releasesLoader } from "./lib/releases";

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
        // The date a person last followed the page's steps and they worked,
        // as our content recipes ask. Set it when you re-run a page.
        lastVerified: z.coerce.date().optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
  // /blog/: dated posts, pages like the docs, so each has its Markdown, an
  // llms.txt line and search. `date` and `author` reach the Markdown too.
  blog: defineCollection(
    docsCollection({
      base: "blog",
      schemaFields: {
        date: z.coerce.date().optional(),
        author: z.string().default("The Nimbus team"),
      },
      markdownFields: ["date", "author"],
    }),
  ),
  // The tagline is each component's description, so its Markdown, llms.txt
  // and MCP carry it as docs pages carry theirs.
  components: defineCollection({
    ...componentsCollection(),
    schema: componentsSchema.transform((data) => ({ ...data, description: data.tagline })),
  }),
  // /changelog/: the packages' releases, from their CHANGELOG.md files and
  // release tags. The build runs in apps/www, two folders below the repo.
  releases: defineCollection({
    loader: releasesLoader(new URL("../../", pathToFileURL(`${process.cwd()}/`))),
    schema: z.object({
      title: z.string(),
      package: z.enum(["nimbus-docs", "create-nimbus-docs"]),
      version: z.string(),
      date: z.date().optional(),
      order: z.number(),
    }),
  }),
};
