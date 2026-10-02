/**
 * Config validation.
 *
 * Errors target content authors, not framework developers.
 * Astro 7 ships Zod v4 via `astro/zod` — single `error` field, not v3 patterns.
 */

import { z } from "astro/zod";
import type { NimbusConfig } from "../types.js";
import { withStrictKeys, reportUnknownKeys } from "./strict-keys.js";
import { prefixEntryFault, routeSlugFault } from "./api/route-policy.js";

// `new URL("https:example.com")` does NOT throw (protocol `https:`, host
// `example.com`), so a bare `.url()`/`new URL()` check waves through a missing
// `//`. Require the `://` authority and an http(s) scheme with a host so a
// typo can't silently ship a broken canonical origin.
export function isAbsoluteHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && u.host.length > 0;
  } catch {
    return false;
  }
}

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

const renderingModeSchema = z.enum(["build", "request"], {
  error: 'rendering mode must be either "build" or "request"',
});

const renderingSchema = withStrictKeys(
  z.object({
    default: renderingModeSchema.optional(),
    collections: z
      .record(
        z.string().min(1, {
          message: "rendering collection names must not be empty",
        }),
        renderingModeSchema,
      )
      .optional(),
  }),
  { removedKeys: {}, contextLabel: "rendering sub-key" },
).optional();

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
// Rules enforced here:
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
  gated:
    "was withdrawn from the server-output foundation — it did not hold as a confidentiality boundary. To keep a page out of the build, move it out of a routed content collection.",
  logo:
    'was removed. The header now renders `config.title` as text. To use a logo image, edit `src/components/Header.astro` and drop in an <img> or <svg>.',
  footer:
    "was removed. The starter no longer ships a default `Footer.astro`. To add one, create your own component and render it in `src/layouts/DocsLayout.astro`.",
};

const specSourceSchema = z.union(
  [z.string().min(1), z.record(z.string(), z.unknown())],
  {
    error:
      '"api[].spec" must be a local file path (string) or an inline OpenAPI object — remote URLs are not supported in v1',
  },
);

/**
 * Version ids that would shadow a top-level page slug within a family
 * (`/<collection>/<version>` collides with `/<collection>/schemas/...` etc.).
 * The engine emits `tags/`, `schemas/`, `webhooks/`, and reserves `changelog`
 * and `errors` — a version may not claim any of them. Operation- and tag-level
 * collisions are caught post-parse (build time), where the slug set is known.
 */
const RESERVED_VERSION_IDS = new Set([
  "schemas",
  "tags",
  "webhooks",
  "changelog",
  "errors",
  // The default-root store id; a version named `index` would clobber it.
  "index",
]);

// Route convention policy. `convention` is the only enumerated value in v1;
// `stripPathPrefixes` entries and `operations` override targets are validated
// against the same syntactic grammars the engine enforces at mint time
// (single source of truth in `api/route-policy.ts`), so config-time and
// build-time can never disagree.
const routePolicyShape = {
  convention: z.enum(["resource-action-v1"], {
    error: '"api[].routes.convention" must be "resource-action-v1"',
  }),
  stripPathPrefixes: z.array(z.string()).optional(),
  operations: z.record(z.string(), z.string()).optional(),
};
const routePolicyKeys = new Set(Object.keys(routePolicyShape));
const routePolicySchema = z
  .object(routePolicyShape)
  .passthrough()
  .superRefine((policy, ctx) => {
    reportUnknownKeys(policy, ctx, routePolicyKeys, {
      removedKeys: {},
      contextLabel: "api routes field",
      unknownHint: () => 'Valid keys are "convention", "stripPathPrefixes", and "operations".',
    });
    (policy.stripPathPrefixes ?? []).forEach((entry, i) => {
      const fault = prefixEntryFault(entry);
      if (fault) {
        ctx.addIssue({
          code: "custom",
          path: ["stripPathPrefixes", i],
          message: `stripPathPrefixes entry "${entry}" ${fault}`,
        });
      }
    });
    for (const [operationId, slug] of Object.entries(policy.operations ?? {})) {
      const fault = routeSlugFault(slug);
      if (fault) {
        ctx.addIssue({
          code: "custom",
          path: ["operations", operationId],
          message: `route override for operationId "${operationId}" → "${slug}" ${fault}`,
        });
      }
    }
  });

const apiVersionSpecShape = {
  version: z
    .string({ error: '"api[].versions[].version" must be a non-empty string' })
    .min(1, '"api[].versions[].version" must be a non-empty string')
    .regex(
      /^[a-z0-9-]+$/,
      '"api[].versions[].version" must be lowercase letters, digits, and dashes only (it becomes a URL segment)',
    ),
  spec: specSourceSchema,
  default: z.boolean().optional(),
  status: z.enum(["ga", "beta", "deprecated"]).optional(),
  hidden: z.boolean().optional(),
  label: z.string().optional(),
  routes: routePolicySchema.optional(),
};
const apiVersionSpecKeys = new Set(Object.keys(apiVersionSpecShape));
const apiVersionSpecSchema = z
  .object(apiVersionSpecShape)
  .passthrough()
  .superRefine((version, ctx) => {
    reportUnknownKeys(version, ctx, apiVersionSpecKeys, {
      removedKeys: {},
      contextLabel: "api version field",
    });
  });

const RESERVED_COLLECTION_NAMES = new Set(["docs", "partials", "nimbus-api"]);

const apiSpecShape = {
  collection: z
    .string({ error: '"api[].collection" must be a non-empty string' })
    .min(1, '"api[].collection" must be a non-empty string')
    .regex(
      /^[a-z0-9-]+$/,
      '"api[].collection" must be lowercase letters, digits, and dashes only (it becomes the URL prefix and the coordinate namespace)',
    )
    .refine((c) => !RESERVED_COLLECTION_NAMES.has(c), {
      error:
        '"api[].collection" must not be "docs", "partials", or "nimbus-api" — "docs"/"partials" are the built-in content collections, and "/nimbus-api" is reserved for the published coordinate manifest; each would collide',
    }),
  spec: specSourceSchema.optional(),
  label: z.string().optional(),
  versions: z.array(apiVersionSpecSchema).optional(),
  requireOperationId: z
    .boolean({ error: '"api[].requireOperationId" must be a boolean' })
    .optional(),
  schemaPages: z
    .boolean({ error: '"api[].schemaPages" must be a boolean' })
    .optional(),
  routes: routePolicySchema.optional(),
  sidebar: z
    .enum(["full", "on-demand"], {
      error: '"api[].sidebar" must be "full" or "on-demand"',
    })
    .optional(),
};
const apiSpecKeys = new Set(Object.keys(apiSpecShape));
const apiSpecSchema = z
  .object(apiSpecShape)
  .passthrough()
  .superRefine((entry, ctx) => {
    reportUnknownKeys(entry, ctx, apiSpecKeys, {
      removedKeys: {},
      contextLabel: "api entry field",
    });
    const hasSpec = entry.spec !== undefined;
    const hasVersions = entry.versions !== undefined;
    if (hasSpec === hasVersions) {
      ctx.addIssue({
        code: "custom",
        path: [hasVersions ? "spec" : "versions"],
        message: `api collection "${entry.collection}" must set exactly one of "spec" (single reference) or "versions" (a version family)`,
      });
      return;
    }
    // A version family has no shared route policy (no implicit family/version
    // merge) — each version carries its own. Reject a family-level `routes` so
    // it is never silently ignored.
    if (hasVersions && entry.routes !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["routes"],
        message: `api collection "${entry.collection}" sets "routes" at the family level, but a version family carries no shared route policy — move "routes" onto each version entry.`,
      });
    }
    if (!hasVersions) return;

    const versions = entry.versions!;
    if (versions.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["versions"],
        message: `api collection "${entry.collection}" has an empty "versions" array — declare at least one version`,
      });
      return;
    }

    const seenVersion = new Set<string>();
    let defaultCount = 0;
    versions.forEach((v, vi) => {
      if (RESERVED_VERSION_IDS.has(v.version)) {
        ctx.addIssue({
          code: "custom",
          path: ["versions", vi, "version"],
          message: `version id "${v.version}" is reserved — it would collide with the "/${entry.collection}/${v.version}" section URL`,
        });
      }
      if (seenVersion.has(v.version)) {
        ctx.addIssue({
          code: "custom",
          path: ["versions", vi, "version"],
          message: `duplicate version id "${v.version}" in api collection "${entry.collection}"`,
        });
      }
      seenVersion.add(v.version);
      if (v.default) defaultCount += 1;
    });

    if (defaultCount > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["versions"],
        message: `api collection "${entry.collection}" marks ${defaultCount} versions as "default: true" — only one may be the default`,
      });
    }

    const defaultVersion = versions.find((v) => v.default) ?? versions[0]!;
    if (defaultVersion.hidden) {
      ctx.addIssue({
        code: "custom",
        path: ["versions"],
        message: `the default version "${defaultVersion.version}" of api collection "${entry.collection}" cannot be "hidden" — the default owns the bare /${entry.collection} URL`,
      });
    }
  });

const apiSchema = z
  .array(apiSpecSchema)
  .optional()
  .superRefine((entries, ctx) => {
    if (!entries) return;
    const seen = new Set<string>();
    entries.forEach((entry, i) => {
      if (seen.has(entry.collection)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "collection"],
          message: `duplicate api collection "${entry.collection}" — each spec needs a unique collection name`,
        });
      }
      seen.add(entry.collection);
    });
  });

const apiReferenceSchema = z.object({
  collection: z
    .string({ error: '"apiReferences[].collection" must be a non-empty string' })
    .min(1, '"apiReferences[].collection" must be a non-empty string')
    .regex(
      /^[a-z0-9-]+$/,
      '"apiReferences[].collection" must be lowercase letters, digits, and dashes only (it is the coordinate namespace citations resolve against)',
    )
    .refine((c) => !RESERVED_COLLECTION_NAMES.has(c), {
      error:
        '"apiReferences[].collection" must not be "docs", "partials", or "nimbus-api" — those names are reserved',
    }),
  manifest: z
    .string({ error: '"apiReferences[].manifest" must be a string' })
    .min(1, '"apiReferences[].manifest" must be a non-empty string (an https URL or a local file path)')
    .refine(
      (m) => {
        const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(m);
        return !scheme || scheme[1]?.toLowerCase() === "https";
      },
      {
        error:
          '"apiReferences[].manifest" must be an https URL or a local file path — http:// (and other network schemes) are rejected, since the manifest is fetched at build and a plaintext transport lets a network attacker forge the coordinate contract',
      },
    ),
  origin: z
    .string()
    .refine(isAbsoluteHttpUrl, {
      message:
        '"apiReferences[].origin" must be an absolute http(s) URL with a host, e.g. "https://api.example.com"',
    })
    .optional(),
});

const apiReferencesSchema = z
  .array(apiReferenceSchema)
  .optional()
  .superRefine((entries, ctx) => {
    if (!entries) return;
    const seen = new Set<string>();
    entries.forEach((entry, i) => {
      if (seen.has(entry.collection)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "collection"],
          message: `duplicate apiReferences collection "${entry.collection}" — each remote reference needs a unique collection name`,
        });
      }
      seen.add(entry.collection);
    });
  });

const nimbusConfigSchema = withStrictKeys(
  z.object({
    site: z
      .string()
      .refine(isAbsoluteHttpUrl, {
        message:
          '"site" must be an absolute http(s) URL with a host, e.g. "https://docs.example.com" (did you forget the "//"?)',
      }),
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
    api: apiSchema,
    apiReferences: apiReferencesSchema,
    rendering: renderingSchema,
  }),
  {
    removedKeys: REMOVED_CONFIG_KEYS,
    contextLabel: "Config field",
  },
).superRefine((data, ctx) => {
  // A remote reference must not shadow a locally-built collection.
  const cfg = data as { api?: { collection?: string }[]; apiReferences?: { collection?: string }[] };
  const local = new Set((cfg.api ?? []).map((e) => e.collection));
  (cfg.apiReferences ?? []).forEach((ref, i) => {
    if (ref.collection && local.has(ref.collection)) {
      ctx.addIssue({
        code: "custom",
        path: ["apiReferences", i, "collection"],
        message: `apiReferences collection "${ref.collection}" collides with a local api collection — a citation namespace resolves to one source, and the local spec wins`,
      });
    }
  });
});

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
