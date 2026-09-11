import { defineCollection } from "astro:content";
import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection()),
  partials: defineCollection(partialsCollection()),
};
