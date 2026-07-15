/**
 * Content collection helpers for `nimbus-docs/content`.
 *
 * Users plug these into their `src/content.config.ts`:
 *
 *   import { defineCollection } from "astro:content";
 *   import { docsCollection, partialsCollection } from "nimbus-docs/content";
 *
 *   export const collections = {
 *     docs: defineCollection(docsCollection()),
 *     partials: defineCollection(partialsCollection()),
 *   };
 *
 * Extend the docs schema with extra frontmatter fields:
 *
 *   docs: defineCollection(docsCollection({
 *     schemaFields: { author: z.string(), tags: z.array(z.string()) },
 *   })),
 */

import { glob } from "astro/loaders";
import type { z } from "astro/zod";

import {
  componentsSchema,
  defineDocSchema,
  definePartialsSchema,
  partialsSchema,
} from "./schemas.js";

// Re-export the public schema factories from `nimbus-docs/content` so users
// have a single import for content-config concerns (collections + schemas).
export {
  defineDocSchema,
  definePartialsSchema,
  defineSchema,
  docsSchema,
  partialsSchema,
  componentsSchema,
} from "./schemas.js";
export type { DefineSchemaOptions, DocSchemaConfig, ComponentProp } from "./schemas.js";

export interface DocsCollectionOptions<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
> {
  /**
   * Directory under `src/content/` to load docs from.
   * Default: `"docs"`.
   */
  base?: string;
  /**
   * Glob pattern relative to `base`.
   * Default: `"** /*.{md,mdx}"` (space added to avoid breaking this comment).
   */
  pattern?: string;
  /**
   * Extra fields merged into the default docs schema. Lets users add
   * project-specific frontmatter (author, tags, etc.) without rebuilding
   * the whole schema.
   *
   * Generic-typed so the call-site shape (`{ author: z.string() }`) is
   * preserved through to the emitted entry data type — `entry.data.author`
   * resolves to `string`, not `unknown`.
   */
  schemaFields?: TFields;
  /**
   * When `false`, unknown frontmatter keys pass through instead of erroring
   * (default `true`). For ingesting byte-identical content with keys the
   * schema doesn't model. Declared fields in `schemaFields` stay typed.
   */
  strictFrontmatter?: boolean;
}

export interface PartialsCollectionOptions<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
> {
  /**
   * Directory under `src/content/` to load partials from.
   * Default: `"partials"`.
   */
  base?: string;
  /**
   * Glob pattern relative to `base`.
   * Default: `"** /*.{md,mdx}"`.
   */
  pattern?: string;
  /**
   * Extra frontmatter fields merged into the default partials schema.
   * Useful for partials with product-specific metadata (e.g. CF's
   * `inputParameters`). Same generic-preserving shape as
   * `DocsCollectionOptions.schemaFields`.
   */
  schemaFields?: TFields;
}

const DEFAULT_PATTERN = "**/*.{md,mdx}";

/**
 * Returns an Astro content-collection config (`{ loader, schema }`) for the
 * docs collection. Pass to `defineCollection()`.
 */
export function docsCollection<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
>(options: DocsCollectionOptions<TFields> = {}) {
  const base = `./src/content/${options.base ?? "docs"}`;
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const schema = defineDocSchema({
    fields: options.schemaFields,
    strictFrontmatter: options.strictFrontmatter,
  });

  return {
    loader: glob({ base, pattern }),
    schema,
  };
}

/**
 * Returns an Astro content-collection config (`{ loader, schema }`) for the
 * partials collection. Pass to `defineCollection()`.
 *
 * `schemaFields` extends the default partials schema with extra
 * frontmatter — same shape as `docsCollection({ schemaFields })`.
 */
export function partialsCollection<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
>(options: PartialsCollectionOptions<TFields> = {}) {
  const base = `./src/content/${options.base ?? "partials"}`;
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  // Avoid re-deriving the schema when no fields were declared — keeps the
  // default behaviour (`partialsSchema` with its `.default({})`) exact for
  // existing users who don't opt in.
  const schema = options.schemaFields
    ? definePartialsSchema({ fields: options.schemaFields })
    : partialsSchema;

  return {
    loader: glob({ base, pattern }),
    schema,
  };
}

export interface ComponentsCollectionOptions {
  /**
   * Directory under `src/content/` to load component entries from.
   * Default: `"components"`.
   */
  base?: string;
  /**
   * Glob pattern relative to `base`.
   * Default: `"**\/*.{md,mdx}"`.
   */
  pattern?: string;
}

/**
 * Returns an Astro content-collection config (`{ loader, schema }`) for the
 * components collection — for sites documenting their own UI components.
 *
 * Pairs with the `component-showcase` registry recipe, which installs the
 * matching `<Showcase>` / `<Example>` MDX wrappers and the `/components`
 * route. Frontmatter shape: `{ title, tagline, props }`.
 */
export function componentsCollection(options: ComponentsCollectionOptions = {}) {
  const base = `./src/content/${options.base ?? "components"}`;
  const pattern = options.pattern ?? DEFAULT_PATTERN;

  return {
    loader: glob({ base, pattern }),
    schema: componentsSchema,
  };
}
