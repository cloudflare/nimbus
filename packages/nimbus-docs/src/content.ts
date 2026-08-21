/**
 * Content collection helpers for `nimbus-docs/content`.
 *
 * Users plug these into their `src/content.config.ts`:
 *
 *   import { defineCollection } from "astro:content";
 *   import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";
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

import path from "node:path";
import { fileURLToPath } from "node:url";

import { glob } from "astro/loaders";
import type { Loader } from "astro/loaders";
import { z } from "astro/zod";

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

export interface ApiCollectionOptions {
  /** Collection name + URL prefix — routes mount at `/<collection>`. */
  collection: string;
  /**
   * Local file path (relative to the project root) or an inline OpenAPI
   * object. Authored once in `nimbus.config.ts` `api[]`; pass the entry
   * straight through here.
   */
  spec: string | Record<string, unknown>;
  /** Human label for build diagnostics (falls back to `collection`). */
  label?: string;
}

/**
 * Content-collection config for one OpenAPI reference spec. The loader is a
 * thin **index**: it parses the spec once at build time and writes one small
 * DataStore entry per page (`{ id: slug, data: { coordinate, title,
 * description? } }`). Only routing + display metadata is stored — the heavy
 * parsed model is NOT, so render re-derives it from the same spec via
 * `getApiModel()` and nothing depends on a cache surviving the content-sync →
 * render phase boundary.
 *
 *   // src/content.config.ts
 *   import nimbus from "./nimbus.config";
 *   export const collections = {
 *     docs: defineCollection(docsCollection()),
 *     ...Object.fromEntries(
 *       (nimbus.api ?? []).map((a) => [a.collection, defineCollection(apiCollection(a))]),
 *     ),
 *   };
 *
 * The OpenAPI engine is imported lazily inside `load()` — a prose-only site
 * that never registers an API collection pulls neither the engine nor its
 * parser.
 */
export function apiCollection(options: ApiCollectionOptions): {
  loader: Loader;
  schema: z.ZodType<{ coordinate: string; title: string; description?: string }>;
} {
  const { collection, spec, label } = options;

  const loader: Loader = {
    name: "nimbus-docs:api",
    async load(context) {
      const { logger, store, parseData, config: astroConfig, watcher } = context;

      assertSupportedNode();

      const [{ buildApiModel, getApiPageIndex, clearApiModelCache }, { resolveSpecSource }] =
        await Promise.all([
          import("./api/index.js"),
          import("./_internal/api/resolve-spec.js"),
        ]);

      const rootDir = fileURLToPath(astroConfig.root);
      const name = label ?? collection;

      const index = async () => {
        let model;
        try {
          const source = await resolveSpecSource({ collection, spec, label }, rootDir);
          model = await buildApiModel(source);
        } catch (err) {
          // `ApiBuildError` already formats a pointed diagnostic list; surface
          // it (plus which spec failed) and fail the build cleanly.
          logger.error(
            `Failed to build the API reference for "${name}":\n${(err as Error).message}`,
          );
          throw err;
        }

        store.clear();
        for (const { coordinate, slug, title, description } of getApiPageIndex(model)) {
          // The root page has an empty slug (href `/<collection>`), but Astro's
          // DataStore rejects an empty id — map it to Astro's own `index`
          // convention (`entryRouteUrl("", "index") → "/"`). Render is driven by
          // `data.coordinate`, not the slug; title/description seed the agent
          // index (llms.txt, corpus) without re-deriving the model there.
          const id = slug === "" ? "index" : slug;
          const data = await parseData({
            id,
            data:
              description === undefined
                ? { coordinate, title }
                : { coordinate, title, description },
          });
          store.set({ id, data });
        }
        logger.info(`Indexed ${store.keys().length} API pages for "${collection}".`);
      };

      await index();

      // Dev only: reparse when the on-disk spec changes. Inline-object specs
      // have no file to watch.
      if (watcher && typeof spec === "string") {
        const specPath = path.resolve(rootDir, spec);
        const onChange = async (changed: string) => {
          if (path.resolve(changed) !== specPath) return;
          clearApiModelCache(collection);
          await index();
        };
        watcher.add(specPath);
        watcher.on("change", onChange);
        watcher.on("add", onChange);
      }
    },
  };

  return {
    loader,
    schema: z.object({
      coordinate: z.string(),
      title: z.string(),
      description: z.string().optional(),
    }),
  };
}

function assertSupportedNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(
      `nimbus-docs api: Node >=22.12.0 is required to build an API reference ` +
        `(running ${process.versions.node}). Upgrade Node, or remove the \`api\` block from nimbus.config.`,
    );
  }
}
