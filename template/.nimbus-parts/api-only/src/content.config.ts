import { defineCollection } from "astro:content";
import { apiCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  // Reusable snippets for MDX pages (`<Render file="…" />`).
  partials: defineCollection(partialsCollection()),
  // The API reference, generated from the `api` entry in astro.config.ts.
  api: defineCollection(apiCollection()),
};
