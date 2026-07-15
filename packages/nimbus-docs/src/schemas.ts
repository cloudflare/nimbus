/**
 * Content schemas for Nimbus.
 *
 * `docsSchema` is the default frontmatter contract for the `docs` collection.
 * `partialsSchema` is the contract for `<Render file="..." />` partials.
 * `defineDocSchema(config)` returns a customizable schema for advanced users
 *   composing schemas outside the `docsCollection()` factory.
 *
 * Error messages target content authors, not framework developers.
 * Astro 6 ships Zod v4 via `astro/zod`. The v4 API uses a single `error`
 * field on every schema constructor — NOT v3's `required_error` /
 * `invalid_type_error` / `errorMap`.
 */

import { z } from "astro/zod";
import { withStrictKeys } from "./_internal/strict-keys.js";
import { isAbsoluteUrl } from "./_internal/url.js";

export interface DocSchemaConfig<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
> {
  /**
   * Additional frontmatter fields merged into the default schema.
   * Generic-typed so the call-site shape is preserved through to
   * `entry.data.<field>` access in consumer code.
   */
  fields?: TFields;
  /**
   * When `false`, unknown frontmatter keys pass through instead of erroring.
   * Default `true` (catches typos/removed keys). Set `false` to ingest
   * byte-identical content that carries keys the schema doesn't model.
   */
  strictFrontmatter?: boolean;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const sidebarBadgeSchema = z.union([
  z.string(),
  z.object({
    text: z.string({ error: 'sidebar badge needs a "text" field' }),
    variant: z
      .enum(
        ["default", "info", "note", "success", "tip", "warning", "caution", "danger"],
        {
          error:
            '"variant" must be one of: default, info, note, success, tip, warning, caution, danger',
        },
      )
      .default("default"),
  }),
]);

// Group-level overrides for sidebar entries that act as a group label
// (i.e. an `index.mdx` whose siblings become the group's children),
// written as `sidebar: { group: { … } }`. Apply only when the entry is
// the index of a directory containing other entries.
const sidebarGroupSchema = z.object({
  /** Override the group label (defaults to the directory name). */
  label: z.string({ error: '"sidebar.group.label" must be a string' }).optional(),
  /** Override the group badge (defaults to none). */
  badge: sidebarBadgeSchema.optional(),
  /** Hide this directory's index from the sidebar: the group label renders as
   *  a non-interactive header instead of a link, and no "Overview" row is
   *  emitted. The page still builds at its path. */
  hideIndex: z
    .boolean({ error: '"sidebar.group.hideIndex" must be true or false' })
    .optional(),
});

const sidebarSchema = z.object({
  order: z.number({ error: '"sidebar.order" must be a number' }).optional(),
  label: z.string({ error: '"sidebar.label" must be a string' }).optional(),
  badge: sidebarBadgeSchema.optional(),
  hidden: z.boolean({ error: '"sidebar.hidden" must be true or false' }).optional(),
  hideChildren: z
    .boolean({ error: '"sidebar.hideChildren" must be true or false' })
    .optional(),
  /** Group-level overrides; see `sidebarGroupSchema`. */
  group: sidebarGroupSchema.optional(),
});

const prevNextSchema = z
  .union([
    z.string(),
    z.object({ link: z.string().optional(), label: z.string().optional() }),
    z.literal(false),
  ])
  .optional();

// Head elements: every HTML tag that's valid as a direct child of <head>.
// Kept as an enum (vs. a free `z.string()`) so typos still fail loudly.
const headElementSchema = z.object({
  tag: z.enum(["meta", "link", "script", "style", "title", "noscript", "base"], {
    error:
      'head element "tag" must be one of: meta, link, script, style, title, noscript, base',
  }),
  attrs: z.record(z.string(), z.string()).default({}),
  content: z.string().optional(),
});

// Mirrors `BannerProps` in types.ts. Layouts consume this directly off
// `entry.data.banner` and render the `<Banner>` component with it, so the
// schema is framework-owned (not user-extensible territory).
const bannerSchema = z.object({
  content: z.string({ error: 'banner "content" must be a string' }),
  type: z
    .enum(["note", "tip", "caution", "danger"], {
      error: 'banner "type" must be one of: note, tip, caution, danger',
    })
    .optional(),
  dismissible: z
    .object({
      id: z.string({
        error: 'banner "dismissible.id" must be a string — a stable identifier you bump when banner content meaningfully changes',
      }),
      days: z.number({ error: 'banner "dismissible.days" must be a number' }).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Removed/renamed frontmatter keys — surface migration errors loudly
// ---------------------------------------------------------------------------

/**
 * Frontmatter keys the schema does not accept, mapped to a migration
 * message. Without this, Zod's default `.strip()` behavior would silently
 * drop an unrecognized key — the page would build, but with subtly
 * different behavior (the toggle just disappears). That's a confusing
 * failure mode for an authoring contract, so these fail loudly instead.
 *
 * `withFrontmatterKeyCheck` (below) consults this map. Hits get the
 * friendly migration message verbatim; everything else falls through to a
 * generic "Unknown frontmatter key" error so typos don't sneak past either.
 */
const REMOVED_FRONTMATTER_KEYS: Record<string, string> = {
  template:
    'was renamed to "mode". Replace `template: "doc"` with `mode: "doc"`, and `template: "splash"` with `mode: "custom"`.',
  pagefind:
    'was renamed to "searchable". Same boolean shape; the default now derives from `noindex` (a non-crawlable page is non-searchable unless you set `searchable: true` explicitly).',
  llms:
    "was removed. Every published page is now listed in /llms.txt; use `noindex: true` to keep a page out of both search engines and the LLM index.",
  aiDeprioritize:
    "was removed. The framework no longer emits an agent-downrank signal. If you want a page hidden from agents, use `noindex: true`.",
  hero:
    "was removed. Compose your hero in the MDX body using user-owned components; there is no longer a `hero` frontmatter contract.",
};

/**
 * Apply this AFTER any `.extend()` so user-added fields are recognized
 * as valid. Wraps the schema in `.passthrough().superRefine()` so removed
 * keys raise a guided migration error; other unknown keys raise a
 * generic error pointing at `defineSchema({ extend: ... })`.
 */
function withFrontmatterKeyCheck<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return withStrictKeys(schema, {
    removedKeys: REMOVED_FRONTMATTER_KEYS,
    contextLabel: "Frontmatter key",
    unknownHint: (key) =>
      `If you meant to add a custom field, declare it in your collection's schema via \`defineSchema({ extend: z.object({ ${key}: ... }) })\`.`,
  });
}

// ---------------------------------------------------------------------------
// Base docs schema
// ---------------------------------------------------------------------------

function baseDocSchema() {
  return z.object({
    title: z.string({
      error: (iss) =>
        iss.input === undefined
          ? 'Missing required "title" in frontmatter. Every doc needs:\n\n  ---\n  title: "Your Page Title"\n  ---'
          : `"title" must be a string, received ${typeof iss.input}`,
    }),
    description: z.string({ error: '"description" must be a string' }).optional(),
    mode: z
      .enum(["doc", "custom"], {
        error: '"mode" must be "doc" or "custom"',
      })
      .default("doc"),
    sidebar: z.union([z.literal(false), sidebarSchema]).optional(),
    /**
     * Top-level alias of `sidebar.hideChildren`. When the page is a section
     * index, collapses the group to a single link. The nested
     * `sidebar.hideChildren` still works and takes precedence.
     */
    hideChildren: z
      .boolean({ error: '"hideChildren" must be true or false' })
      .optional(),
    head: z.array(headElementSchema).default([]),
    banner: bannerSchema.optional(),
    draft: z.boolean({ error: '"draft" must be true or false' }).default(false),
    noindex: z.boolean({ error: '"noindex" must be true or false' }).default(false),
    /**
     * Whether this page is included in the site search index. When omitted,
     * derives from `noindex` (a page that's not crawlable is by default not
     * searchable). Set explicitly to override — e.g. `{ noindex: true,
     * searchable: true }` keeps the page out of search engines but findable
     * in the site's own search.
     */
    searchable: z
      .boolean({ error: '"searchable" must be true or false' })
      .optional(),
    tableOfContents: z
      .union([
        z.literal(false),
        z
          .object({
            minHeadingLevel: z
              .number({ error: '"minHeadingLevel" must be a number (1-6)' })
              .int()
              .min(1)
              .max(6)
              .default(2),
            maxHeadingLevel: z
              .number({ error: '"maxHeadingLevel" must be a number (1-6)' })
              .int()
              .min(1)
              .max(6)
              .default(3),
          })
          .refine((v) => v.minHeadingLevel <= v.maxHeadingLevel, {
            message: "minHeadingLevel must be <= maxHeadingLevel",
          }),
      ])
      .optional(),
    lastUpdated: z.coerce
      .date({ error: '"lastUpdated" must be a valid date (e.g. 2024-01-15)' })
      .optional(),
    /**
     * Explicit per-page social/OG image override (path or absolute URL).
     * When omitted, the page route is expected to fall back to a
     * programmatically-generated card or the site-wide `config.socialImage`.
     */
    socialImage: z
      .string({ error: '"socialImage" must be a string (path or URL)' })
      .optional(),
    prev: prevNextSchema,
    next: prevNextSchema,
    /**
     * Versioning rename escape hatch.
     *
     * When a page is renamed between versions (the URL slug changes), the
     * newer version's frontmatter declares the slug it had in an older
     * version. The framework uses this to link the pages as cross-version
     * alternates and to emit a `<link rel="canonical">` to the current
     * version's URL.
     *
     * Example: `docs-v1/old-name.mdx` was renamed in v2 to `new-name.mdx`.
     * On the new page (`docs/new-name.mdx`, current version), set:
     *
     *   previousSlug: old-name
     *
     * Now `/new-name` and `/v1/old-name` are linked as the same logical
     * page in `<head>` alternates, and the v1 page's canonical points to
     * `/new-name`.
     *
     * Accepts a single slug string (the page's id in the older version)
     * or an array of strings when the page has been renamed across more
     * than one version.
     */
    previousSlug: z
      .union([z.string(), z.array(z.string())], {
        error: '"previousSlug" must be a string or array of strings',
      })
      .optional(),
    /**
     * Rewrite this page's sidebar link to point at an external (or
     * cross-section) URL. The page still builds at its filesystem path —
     * `external_link` only changes how the sidebar links to it. The link
     * renders with `target="_blank" rel="noopener"` and is treated as
     * external by header/footer chrome.
     *
     * Must be either an absolute URL (`https://…`, `mailto:…`,
     * protocol-relative `//cdn.…`) or a site-absolute path (`/foo/bar`).
     * Relative strings (`"foo"`, `"./bar"`) and empty strings are
     * rejected — the sidebar builder consumes this directly as an
     * `<a href>`, and a relative href against the entry's own URL
     * would route somewhere unintended (typically into the entry's
     * own subtree). An empty string would produce an indexHref of
     * `""` on group landings, breaking the link entirely.
     *
     * Useful to redirect deprecated pages to their replacements without
     * 301s.
     */
    external_link: z
      .string({
        error: '"external_link" must be a URL or absolute path',
      })
      .refine((v) => v.length > 0 && (isAbsoluteUrl(v) || v.startsWith("/")), {
        message:
          '"external_link" must be a non-empty absolute URL (e.g. "https://example.com/foo") ' +
          'or a site-absolute path (e.g. "/replacement-page"). ' +
          "Relative paths are rejected because they'd resolve against the entry's own URL rather than where the author intended.",
      })
      .optional(),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a customizable docs schema. Use this when composing schemas outside
 * the `docsCollection()` factory (e.g. multiple docs collections with
 * different shapes).
 *
 * For typed Astro `image()` fields or per-collection field narrowing, use
 * the richer `defineSchema(ctx => ...)` factory instead.
 */
export function defineDocSchema<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
>(config: DocSchemaConfig<TFields> = {}) {
  const base = baseDocSchema();
  // Always extend (with `{}` when no fields) so the result type is
  // `ZodObject<baseShape & TFields>` rather than a union of branches.
  // A union widens the consumer view of `entry.data.X` to the intersection
  // of branch fields, which is "no fields" for the false branch and
  // re-erases everything we just preserved.
  const merged = base.extend((config.fields ?? {}) as TFields);
  // `strictFrontmatter: false` accepts (and passes through) unknown keys.
  if (config.strictFrontmatter === false) {
    return merged.passthrough() as unknown as typeof merged;
  }
  // Cast back to the underlying ZodObject. Runtime wrap (`.passthrough()
  // .superRefine()`) stays — the unknown-key check still fires. But tsdown
  // collapses ZodEffects emissions to `ZodObject<Record<string, ZodType<unknown>>>`,
  // erasing every framework field type at every consumer's `entry.data.X`
  // access. The cast preserves the field shapes through .d.ts emission.
  return withFrontmatterKeyCheck(merged) as unknown as typeof merged;
}

/**
 * Factory options for `defineSchema`.
 *
 *   - `extend`: additional fields merged into the framework schema. Use
 *     this for user-defined frontmatter (`author`, `tags`, `cover`).
 *   - `narrow`: replaces framework fields with tighter types within this
 *     collection. Use when a collection has stricter rules — e.g.
 *     `{ mode: z.literal("doc") }` says no landing pages in this collection.
 */
export interface DefineSchemaOptions {
  extend?: z.ZodTypeAny;
  narrow?: Record<string, z.ZodTypeAny>;
}

/**
 * Build a typed docs schema with access to the Astro `SchemaContext`.
 * Use this when you want typed image fields (`ctx.image()`), per-
 * collection narrowing of framework fields, or both. The simpler
 * `defineDocSchema({ fields })` factory is still available for the
 * common case of just adding fields.
 *
 *   import { defineCollection } from "astro:content";
 *   import { z } from "astro/zod";
 *   import { defineSchema } from "nimbus-docs/schemas";
 *
 *   export const collections = {
 *     docs: defineCollection({
 *       loader: ...,
 *       schema: defineSchema((ctx) => ({
 *         extend: z.object({
 *           cover: ctx.image().optional(),
 *           author: z.string().optional(),
 *         }),
 *         narrow: {
 *           mode: z.literal("doc"),  // no landing pages here
 *         },
 *       })),
 *     }),
 *   };
 */
export function defineSchema(
  factory: (ctx: import("astro:content").SchemaContext) => DefineSchemaOptions,
) {
  return (ctx: import("astro:content").SchemaContext) => {
    const { extend, narrow } = factory(ctx);
    let schema = baseDocSchema() as z.ZodObject<any>;

    // narrowing first (overrides framework fields)
    if (narrow) {
      schema = schema.extend(narrow);
    }

    // additive extension (new user fields). Prefer .merge for ZodObject
    // (preserves object-ness for downstream .extend); fall back to .and
    // for any other Zod type (intersection, union, etc.).
    if (extend) {
      if (extend instanceof z.ZodObject) {
        schema = schema.merge(extend);
      } else {
        // Intersection path — `.and()` returns ZodIntersection, on which
        // we can't run `withFrontmatterKeyCheck` (it operates on ZodObject's
        // `.shape`). Users on this path lose the removed-key migration
        // diagnostic; they own that trade-off by reaching for the
        // non-object extend.
        return schema.and(extend);
      }
    }

    return withFrontmatterKeyCheck(schema);
  };
}

/** Default docs schema. Equivalent to `defineDocSchema()`. */
export const docsSchema = defineDocSchema();

const partialsObjectSchema = z.object({
  /**
   * Declared parameters this partial accepts.
   * Suffix with `?` for optional params: `["name", "deprecated?"]`
   */
  params: z.array(z.string()).optional(),
});

/** Schema for partials (`<Render file="..." />` snippets). */
export const partialsSchema = partialsObjectSchema.default({});

/**
 * Build a customizable partials schema. Mirrors `defineDocSchema` — use
 * when porting upstream partials that ship product-specific frontmatter
 * keys (e.g. CF's `inputParameters`) and you want them to validate without
 * editing the source files.
 *
 *   import { z } from "astro/zod";
 *   import { partialsCollection } from "nimbus-docs/content";
 *
 *   defineCollection(partialsCollection({
 *     schemaFields: { inputParameters: z.string().optional() },
 *   }));
 */
export function definePartialsSchema<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
>(config: { fields?: TFields } = {}) {
  // Same generic preservation trick as `defineDocSchema` — always extend
  // (even with `{}`) so the result type stays `ZodObject<base & TFields>`
  // rather than a union with the no-fields branch erasing types.
  const merged = partialsObjectSchema.extend((config.fields ?? {}) as TFields);
  return merged as unknown as typeof merged;
}

// ---------------------------------------------------------------------------
// Lenient variants — used by `nimbus-docs lint` (`nimbus/frontmatter-shape`).
//
// The standalone lint CLI can't yet see a site's extended
// `content.config.ts` schema, so it validates the *types* of the fields
// the framework owns while tolerating user-added fields (passthrough).
// Unknown-key detection is deferred to when the engine can load the real
// per-collection schema.
// ---------------------------------------------------------------------------

/** Docs frontmatter, framework fields type-checked, extra keys allowed. */
export const lenientDocsSchema = baseDocSchema().passthrough();

/** Partials frontmatter, framework fields type-checked, extra keys allowed. */
export const lenientPartialsSchema = partialsObjectSchema.passthrough();

// ---------------------------------------------------------------------------
// Components collection — used by sites documenting their own UI components.
// Pair with `componentsCollection()` from `nimbus-docs/content`. Authoring
// pattern: hero `<Showcase>` block + `<Example>` blocks in the MDX body, with
// `props` declared in frontmatter for a generated prop table.
// ---------------------------------------------------------------------------

/** One row in a component's `props` frontmatter array. */
const componentPropSchema = z.object({
  name: z.string({ error: 'prop needs a "name"' }),
  type: z.string({ error: 'prop needs a "type"' }),
  defaultValue: z.string().optional(),
  required: z.boolean().default(false),
  description: z.string({ error: 'prop needs a "description"' }),
});

export type ComponentProp = z.infer<typeof componentPropSchema>;

/** Default schema for the components collection. */
export const componentsSchema = z.object({
  title: z.string({
    error: (iss) =>
      iss.input === undefined
        ? 'Missing "title" in frontmatter — display name used in the sidebar and page header.'
        : `"title" must be a string, received ${typeof iss.input}`,
  }),
  tagline: z.string({
    error: (iss) =>
      iss.input === undefined
        ? 'Missing "tagline" in frontmatter — one-sentence summary shown under the title.'
        : `"tagline" must be a string, received ${typeof iss.input}`,
  }),
  props: z.array(componentPropSchema).default([]),
});
