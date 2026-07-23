/**
 * Config validation.
 *
 * Errors target content authors, not framework developers.
 * Astro 7 ships Zod v4 via `astro/zod` — single `error` field, not v3 patterns.
 */

import { z } from "astro/zod";
import type { NimbusConfig } from "../types.js";
import { withStrictKeys } from "./strict-keys.js";

// Head elements: full set valid as direct children of `<head>`. Mirrors the
// frontmatter `head` schema in `schemas.ts` and the `HeadElement` type
// surface — the three sources need to agree so a tag accepted in
// frontmatter doesn't trip config validation (or vice versa).
const headElementSchema = z.object({
  tag: z.enum(["meta", "link", "script", "style", "title", "noscript", "base"], {
    error:
      'head element "tag" must be one of: meta, link, script, style, title, noscript, base',
  }),
  attrs: z.record(z.string(), z.string()).default({}),
  content: z.string().optional(),
});

/**
 * Removed/renamed keys in the `features` sub-object. Each maps to the
 * back-half of a sentence — the parent error message prepends
 * `features sub-key "<name>" ` automatically.
 */
const REMOVED_FEATURE_KEYS: Record<string, string> = {
  toc:
    'was renamed to "tableOfContents". Replace `features: { toc: false }` with `features: { tableOfContents: false }`.',
  pagination:
    "was removed. To hide pagination site-wide, remove `<Pagination />` from `src/layouts/DocsLayout.astro` (it is user-owned).",
  editLinks:
    "was removed. To hide edit links site-wide, omit `editPattern` from the config — the default is null, which produces no edit URLs. Setting `github` alone does not enable edit links.",
  search:
    "moved to the top-level `search` field on the config. Replace `features: { search: false }` with `search: false`.",
};

// Narrow features schema: only kill switches for chrome that's hard to
// hide via user-side edits alone (the sidebar threads through layout +
// header + mobile dialog; the TOC has its own column the layout sets up).
// Both default to `true`. Per-page frontmatter (sidebar/tableOfContents)
// can override in the "off" direction via AND-merge in the route.
const featuresSchema = withStrictKeys(
  z.object({
    sidebar: z.boolean().default(true),
    tableOfContents: z.boolean().default(true),
  }),
  {
    removedKeys: REMOVED_FEATURE_KEYS,
    contextLabel: "features sub-key",
  },
).default({ sidebar: true, tableOfContents: true });

const searchSchema = z
  .union([
    z.literal(false),
    z.object({
      provider: z.enum(["pagefind", "custom"]).default("pagefind"),
    }),
  ])
  .optional();

// Sidebar items are intentionally loose — the sidebar builder accepts the
// shapes documented in types.ts; tightening here adds friction for users
// without catching real errors that the builder doesn't already catch.
const sidebarSchema = z
  .object({
    items: z.array(z.unknown()).optional(),
    scope: z.enum(["full", "section"]).default("full"),
    indexDisplay: z.enum(["header-link", "overview-leaf"]).optional(),
  })
  .passthrough()
  .optional();

// Versioning manifest. Shape validation only. Cross-checking that each
// `others[i]` actually corresponds to a registered `docs-<i>` collection
// happens at integration setup time in `integration.ts` where the parsed
// collections list is available.
//
// Rules enforced here (mirrors versioned-docs spec acceptance criteria):
//   - `current` is a non-empty string.
//   - `others` are non-empty strings, no duplicates.
//   - `deprecated` ⊆ `others`.
//   - `hidden` ⊆ `others`.
//   - `current` not present in `others` (a version is either current or older,
//     never both).
const versionSlugSchema = z
  .string({ error: '"versions" entries must be strings' })
  .min(1, { message: 'Empty string is not a valid version slug' });

const versionsSchema = z
  .object({
    current: versionSlugSchema,
    others: z.array(versionSlugSchema).default([]),
    deprecated: z.array(versionSlugSchema).default([]),
    hidden: z.array(versionSlugSchema).default([]),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.others.forEach((slug, i) => {
      if (seen.has(slug)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate version slug "${slug}" in "others"`,
          path: ["others", i],
        });
      }
      seen.add(slug);
    });
    if (v.others.includes(v.current)) {
      ctx.addIssue({
        code: "custom",
        message:
          `"current" (${JSON.stringify(v.current)}) must not also appear in "others". ` +
          `The current version lives in the primary \`docs\` collection; ` +
          `entries in "others" describe older versions stored in \`docs-<slug>\` collections.`,
        path: ["current"],
      });
    }
    for (const [i, slug] of v.deprecated.entries()) {
      if (!v.others.includes(slug)) {
        ctx.addIssue({
          code: "custom",
          message:
            `"deprecated" entry ${JSON.stringify(slug)} is not in "others". ` +
            `Every deprecated version must also be listed in "others".`,
          path: ["deprecated", i],
        });
      }
    }
    for (const [i, slug] of v.hidden.entries()) {
      if (!v.others.includes(slug)) {
        ctx.addIssue({
          code: "custom",
          message:
            `"hidden" entry ${JSON.stringify(slug)} is not in "others". ` +
            `Every hidden version must also be listed in "others".`,
          path: ["hidden", i],
        });
      }
    }
  })
  .optional();

/**
 * Removed top-level config keys. Hits emit a friendly migration message
 * instead of being silently dropped.
 */
const REMOVED_CONFIG_KEYS: Record<string, string> = {
  logo:
    'was removed. The header now renders `config.title` as text. To use a logo image, edit `src/components/Header.astro` and drop in an <img> or <svg>.',
  footer:
    "was removed. The starter no longer ships a default `Footer.astro`. To add one, create your own component and render it in `src/layouts/DocsLayout.astro`.",
};

const nimbusConfigSchema = withStrictKeys(
  z.object({
    site: z.string().url({ message: '"site" must be a valid URL' }),
    title: z.string(),
    description: z.string().optional(),
    locale: z.string().default("en"),
    homeLabel: z.string().default("Home"),
    github: z.string().url().nullable().default(null),
    // editPattern must contain the `{path}` placeholder. Without it,
    // `getEditUrl()` returns the pattern unchanged for every entry — a
    // silent footgun that ships broken edit links to production.
    editPattern: z
      .string()
      .nullable()
      .default(null)
      .refine((v) => v === null || v.includes("{path}"), {
        message:
          '"editPattern" must contain the "{path}" placeholder, which is replaced with the entry source path. ' +
          'Example: "https://github.com/my-org/my-repo/edit/main/{path}"',
      }),
    socialImage: z
      .string({ error: '"socialImage" must be a string (path or URL)' })
      .optional(),
    socialImageAlt: z
      .string({ error: '"socialImageAlt" must be a string' })
      .optional(),
    head: z.array(headElementSchema).default([]),
    sidebar: sidebarSchema,
    features: featuresSchema,
    search: searchSchema,
    versions: versionsSchema,
  }),
  {
    removedKeys: REMOVED_CONFIG_KEYS,
    contextLabel: "Config field",
  },
);

export function validateNimbusConfig(input: unknown): NimbusConfig {
  const result = nimbusConfigSchema.safeParse(input);
  if (result.success) {
    // Zod safeParse upstream validated the shape against nimbusConfigSchema;
    // double-cast restores the type info tsc lost through the schema's
    // generic `Record<string, unknown>` representation.
    return result.data as unknown as NimbusConfig;
  }

  // Build a content-author-readable issue list. Each line carries:
  //   - the dotted config path (so it's greppable in nimbus.config.ts)
  //   - the validator message
  //   - the offending value (truncated) when one was supplied
  const issues = result.error.issues
    .map((issue) => {
      // Zod v4 widens path entries to PropertyKey. Symbols never appear in
      // our schema (no symbol keys), so it's safe to coerce to string|number
      // for both display and value lookup.
      const issuePath = issue.path
        .filter((p): p is string | number => typeof p !== "symbol");
      const display = issuePath.length > 0 ? issuePath.join(".") : "(root)";
      const received = formatReceived(input, issuePath);
      const tail = received === null ? "" : `\n      received: ${received}`;
      return `  - ${display}: ${issue.message}${tail}`;
    })
    .join("\n");

  throw new Error(
    `Invalid nimbus.config — fix these issues:\n${issues}\n\n` +
      `See https://nimbus-docs.com/config for the full config schema.`,
  );
}

/**
 * Resolve the value at `path` inside the raw input and format it for an
 * error message. Returns null when the path is unreachable (e.g. a
 * required key is missing entirely — in that case the message itself
 * already says "Required", so we don't double up).
 */
function formatReceived(input: unknown, path: ReadonlyArray<string | number>): string | null {
  let cursor: unknown = input;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string | number, unknown>)[key];
    if (cursor === undefined) return null;
  }
  if (cursor === undefined) return null;
  try {
    const json = JSON.stringify(cursor);
    if (json === undefined) return String(cursor);
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return String(cursor);
  }
}
