import { defineCollection } from "astro:content";
import {
  apiCollection,
  docsCollection,
  partialsCollection,
} from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection()),
  partials: defineCollection(partialsCollection()),
  api: defineCollection(apiCollection()),
};
