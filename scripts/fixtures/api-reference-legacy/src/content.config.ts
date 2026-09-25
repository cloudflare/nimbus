import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import {
  apiCollection,
  docsCollection,
  partialsCollection,
} from "@cloudflare/nimbus-docs/content";
import nimbusConfig from "../nimbus.config";

const api = nimbusConfig.api?.find((entry) => entry.collection === "api");
if (!api) throw new Error('Missing the "api" collection in nimbus.config.ts');

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: { audience: z.literal("human").optional() },
    }),
  ),
  partials: defineCollection(partialsCollection()),
  api: defineCollection(apiCollection(api)),
};
