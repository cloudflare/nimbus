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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AstroError } from "astro/errors";
import { glob } from "astro/loaders";
import { ApiBuildError } from "./_internal/api/coordinates.js";
import { unusedExtensions, warnUnusedExtensions } from "./_internal/api/extensions.js";
import { authorError } from "./_internal/author-error.js";
import { collectionMountPrefix, getMountContext } from "./_internal/collection-mount.js";
import type { RebuildReason } from "./_internal/api/page-assets-build.js";
import type { Loader } from "astro/loaders";
import { z } from "astro/zod";

import {
  componentsSchema,
  defineDocSchema,
  definePartialsSchema,
  partialsSchema,
} from "./schemas.js";
import type {
  ApiRoutePolicy,
  ApiSamples,
  ApiVersionSpec,
  ApiVersionUrl,
} from "./types.js";
import {
  noteApiCollectionLoad,
  registeredOutput,
  getRegisteredApiCollections,
  resolveRegisteredApiCollection,
} from "./_internal/api-collection-registry.js";
import { isCollectionInBuildSlice } from "./_internal/build-slice.js";
import { getAuthoredLinkNormalizer } from "./_internal/authored-link-normalizer.js";
import { prepareMarkdownLoader } from "./_internal/markdown-loader.js";
import {
  missingContentSource,
  recordUnavailableSourceCollection,
  registeredContentSourceNames,
  resolveContentSource,
} from "./_internal/content-sources.js";
import { normalizeSourcePath } from "./_internal/source-repo.js";
import { registerSourceCollectionFolder, rewriteSourceLinks } from "./_internal/source-links.js";
import { formatLabel } from "./_internal/sidebar.js";
import {
  beginPreparedMarkdownLoad,
  cancelPreparedMarkdownLoad,
  commitPreparedDataCollection,
  getPreparedMarkdownSession,
  preparedMarkdownRootKey,
  runPreparedMarkdownTransaction,
} from "./_internal/prepared-markdown-registry.js";
import { transparentProxy } from "./_internal/transparent-proxy.js";
import {
  rendersApiOnRequest,
  usesPageAssets,
} from "./_internal/page-assets-config.js";

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
export type {
  DefineSchemaOptions,
  DocSchemaConfig,
  ComponentProp,
} from "./schemas.js";

export interface DocsCollectionOptions<
  TFields extends Record<string, z.ZodTypeAny> = Record<string, never>,
> {
  /**
   * Directory under `src/content/` to load docs from. Default: `"docs"`.
   * With `source`, a folder inside the source's `path` instead (default
   * `""`, the whole `path`); it may not contain `..`.
   */
  base?: string;
  /**
   * Glob pattern relative to `base`.
   * Default: `"** /*.{md,mdx}"` (space added to avoid breaking this comment).
   */
  pattern?: string;
  /**
   * Read the collection from a content source declared in the Nimbus
   * config's `sources`, by name, instead of `src/content`. The integration
   * resolves the source to a snapshot before content sync; `base` is then
   * relative to the source's `path`.
   */
  source?: string;
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
   * `schemaFields` keys to write into each page's `.md` and `.mdx`
   * frontmatter, in this order, after Nimbus's own keys (`title`,
   * `description`, `image`, `version`), which can't be named here. Values
   * are strings, numbers, booleans, dates, or arrays of those; a date at
   * midnight UTC is written `YYYY-MM-DD`.
   */
  markdownFields?: ReadonlyArray<
    string extends keyof TFields ? never : Extract<keyof TFields, string>
  >;
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
/** A quarter of the 64 MiB Workers script limit (uncompressed; there is no
 * compressed limit): developers.cloudflare.com/workers/platform/limits. */
const BUNDLE_HINT_BYTES = 16 * 1024 * 1024;
const NIMBUS_MARKDOWN_GENERATION = 1;
// One cache across roles: wrapping an already-wrapped loader must return it
// unchanged (whatever role it was wrapped with), or the nested wrappers would
// queue the same collection transaction inside itself and deadlock the load.
const wrappedMarkdownLoaders = new WeakMap<Loader, Loader>();
// The folder and pattern of each glob a Nimbus factory constructs, so the
// duplicate-slug pass walks exactly those files. Nimbus's own values; a
// hand-written glob has none and is checked through its store writes.
type GlobFiles = { base: string; pattern: string | string[] };
const nimbusGlobFiles = new WeakMap<
  Loader,
  GlobFiles | ((root: URL) => GlobFiles | undefined)
>();

function nimbusGlob(base: string, pattern: string): Loader {
  const loader = glob({ base, pattern });
  nimbusGlobFiles.set(loader, { base, pattern });
  return loader;
}

type ApiLoaderModule = typeof import("./_internal/api-loader.js");

function loadApiLoader(): Promise<ApiLoaderModule> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const specifier = ["./_internal/", "api-loader.", extension].join("");
  return import(
    /* @vite-ignore */ new URL(specifier, import.meta.url).href
  ) as Promise<ApiLoaderModule>;
}

const INPUT_NAMES: Record<string, string> = {
  environment: "Nimbus or an installed package",
  collection: "the collection name",
  spec: "the spec",
  requireOperationId: "requireOperationId",
  schemaPages: "schemaPages",
  routes: "routes",
  samples: "samples",
  extensions: "extensions",
};

/** " Rebuilt v2: the spec changed." for each version prepared instead of reused. */
function describeRebuilds(
  versions: Array<{
    target: { version: string | null };
    prepared: { rebuilt?: RebuildReason };
  }>,
): string {
  const notes = versions.flatMap(({ target, prepared }) => {
    const rebuilt = prepared.rebuilt;
    if (!rebuilt) return [];
    const subject = target.version ? ` ${target.version}` : "";
    const names = rebuilt.changed.map((name) => INPUT_NAMES[name] ?? name);
    const reason = rebuilt.first
      ? "nothing cached yet"
      : names.length
        ? `${[names.slice(0, -1).join(", "), names.at(-1)].filter(Boolean).join(" and ")} changed`
        : "its cache entry was missing";
    return [`Rebuilt${subject}: ${reason}.`];
  });
  return notes.length ? ` ${notes.join(" ")}` : "";
}

export function withNimbusMarkdown<T extends Loader>(loader: T): T {
  return wrapNimbusMarkdown(loader, "page");
}

/** Frontmatter keys every page's `.md` and `.mdx` already carries. */
const NIMBUS_MARKDOWN_KEYS = new Set(["title", "description", "image", "version"]);

function checkMarkdownFields(
  fields: readonly string[],
  schemaFields: Record<string, unknown> | undefined,
): void {
  const seen = new Set<string>();
  for (const field of fields) {
    // Written as a bare YAML key, so it must read as one.
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(field)) {
      throw new Error(
        `nimbus-docs: docsCollection({ markdownFields }) names "${field}", which can't be a frontmatter key. Use letters, digits, "_" and "-", starting with a letter or "_".`,
      );
    }
    if (seen.has(field)) {
      throw new Error(`nimbus-docs: docsCollection({ markdownFields }) names "${field}" twice.`);
    }
    seen.add(field);
    if (NIMBUS_MARKDOWN_KEYS.has(field)) {
      throw new Error(
        `nimbus-docs: docsCollection({ markdownFields }) names "${field}", which Nimbus already writes to every page's .md and .mdx. Remove it from markdownFields.`,
      );
    }
    if (!schemaFields || !Object.hasOwn(schemaFields, field)) {
      throw new Error(
        `nimbus-docs: docsCollection({ markdownFields }) names "${field}", which isn't in schemaFields. Declare it in schemaFields, or remove it from markdownFields.`,
      );
    }
  }
}

/**
 * Shared implementation behind `withNimbusMarkdown()` (role `page`) and
 * `partialsCollection()` (role `partials`). The role is recorded on the
 * prepared-markdown registry commit and decides whether the collection's
 * entries are pages. It is fixed when a loader is first wrapped: the helpers
 * each wrap a fresh loader, so the only way to hit the cache with a different
 * role is to re-wrap an existing wrapper, which stays a no-op.
 */
function wrapNimbusMarkdown<T extends Loader>(
  loader: T,
  role: "page" | "partials",
  markdownFields?: readonly string[],
): T {
  const existing = wrappedMarkdownLoaders.get(loader);
  if (existing) return existing as T;

  const globFilesOf = nimbusGlobFiles.get(loader);
  const wrappedLoad: Loader["load"] = async (context) => {
    const base = context.config.base || "/";
    const globFiles =
      typeof globFilesOf === "function" ? globFilesOf(context.config.root) : globFilesOf;
    const normalizeAuthoredLinks = getAuthoredLinkNormalizer();
    const prepared = prepareMarkdownLoader(loader, {
      generation: NIMBUS_MARKDOWN_GENERATION,
      base,
      role,
      ...(markdownFields?.length ? { markdownFields: [...markdownFields] } : {}),
      // Partials always load: a page in the slice may render one.
      empty:
        role === "page" &&
        !isCollectionInBuildSlice(context.config.root, context.collection),
      transformRenderMarkdown: false,
      ...(globFiles
        ? {
            files: {
              base: path.resolve(
                fileURLToPath(context.config.root),
                globFiles.base,
              ),
              pattern: globFiles.pattern,
            },
          }
        : {}),
      transform: (source, sourceId) => {
        const filePath = sourceId
          ? fileURLToPath(new URL(sourceId, context.config.root))
          : undefined;
        return normalizeAuthoredLinks(rewriteSourceLinks(source, filePath), {
          base,
          sourceId: sourceId
            ? `${context.collection}:${sourceId}`
            : context.collection,
          filePath,
        });
      },
    });
    await Reflect.apply(
      Reflect.get(prepared, "load", prepared) as Loader["load"],
      prepared,
      [context],
    );
  };

  const wrapped = transparentProxy(loader, new Map([["load", wrappedLoad]]));
  wrappedMarkdownLoaders.set(loader, wrapped);
  wrappedMarkdownLoaders.set(wrapped, wrapped);
  return wrapped;
}

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
  const markdownFields = options.markdownFields ?? [];
  checkMarkdownFields(markdownFields, options.schemaFields);

  return {
    loader: wrapNimbusMarkdown(
      options.source !== undefined
        ? sourceGlob(options.source, options.base, pattern)
        : nimbusGlob(base, pattern),
      "page",
      markdownFields,
    ),
    schema,
  };
}

/** Text with inline HTML tags removed, and no angle bracket left. */
function withoutTags(text: string): string {
  let out = "";
  let inTag = false;
  for (const char of text) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) out += char;
  }
  return out;
}

/**
 * The title of a page with none in its frontmatter: its first Markdown
 * heading (outside code fences, inline markup removed), else its file name.
 */
export function titleFromFile(filePath: string | undefined, id: string): string {
  const fallback = formatLabel(id.split("/").pop() || id);
  if (!filePath) return fallback;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1]! : null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const title = withoutTags(heading[1]!)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")

      .trim();
    if (title) return title;
  }
  return fallback;
}

/**
 * The glob behind `docsCollection({ source })`: Astro's glob over
 * `<snapshot>/<path>/<base>`, looked up at load time, by project root, from
 * the snapshots the integration resolved at setup. A snapshot is frozen for
 * the process, so the glob gets no watcher.
 */
function sourceGlob(source: string, rawBase: string | undefined, pattern: string): Loader {
  const sourceBase = normalizeSourcePath(rawBase);
  if (/^[A-Za-z]:|^[\\/]/.test(rawBase ?? "") || sourceBase.split("/").includes("..")) {
    throw authorError(
      `nimbus-docs: docsCollection({ source: ${JSON.stringify(source)}, base: ${JSON.stringify(rawBase)} }): ` +
        "with source, base is a folder inside the source's path and may not be absolute or contain \"..\".",
    );
  }
  const folderOf = (root: URL) => {
    const snapshot = resolveContentSource(root, source);
    return snapshot && path.join(snapshot.contentDir, sourceBase);
  };
  const loader: Loader = {
    name: "nimbus-docs:content-source",
    async load(context) {
      const META_KEY = "nimbus:content-source";
      const snapshot = resolveContentSource(context.config.root, source);
      const missing = snapshot ? undefined : missingContentSource(context.config.root, source);
      if (missing === "unavailable") {
        // A command that starts without the source (dev, sync): the
        // collection is empty, with nothing left from an earlier run.
        recordUnavailableSourceCollection(context.config.root, context.collection);
        context.store.clear();
        context.meta.delete(META_KEY);
        return;
      }
      if (missing === "skipped") {
        throw authorError(
          `nimbus-docs: collection "${context.collection}" reads source "${source}", which this slice skipped because ` +
            "src/content.config.ts doesn't show the read; write source as a string literal in docsCollection() in " +
            "src/content.config.ts, not in a helper or another module.",
        );
      }
      if (!snapshot) {
        const declared = registeredContentSourceNames(context.config.root);
        throw authorError(
          `nimbus-docs: collection "${context.collection}" in src/content.config.ts sets source: ${JSON.stringify(source)}, ` +
            `but the Nimbus config declares no source named "${source}" in \`sources\`.`,
          declared.length
            ? `Declared sources: ${declared.map((name) => `"${name}"`).join(", ")}.`
            : `Add sources: { ${JSON.stringify(source)}: { repo, ref, path } } to the Nimbus config.`,
        );
      }
      const folder = path.join(snapshot.contentDir, sourceBase);
      let empty: boolean;
      try {
        empty = fs.readdirSync(folder).length === 0;
      } catch {
        empty = true;
      }
      if (empty) {
        const where = [snapshot.path, sourceBase].filter(Boolean).join("/");
        throw authorError(
          `nimbus-docs: collection "${context.collection}" reads source "${source}" at commit ${snapshot.commit.slice(0, 12)}, ` +
            `but ${where ? `the folder "${where}"` : "the repository"} is missing or empty there.`,
          `Check sources.${source}.path, the collection's base, and the ref.`,
        );
      }
      // Astro's glob keeps a stored entry (and its old filePath) when the
      // file's digest is unchanged, so a new snapshot folder would leave
      // unchanged pages pointing at the previous one. Start from an empty
      // store whenever the snapshot or folder changes.
      const stamp = `${snapshot.identity}:${snapshot.commit}:${sourceBase}`;
      if (context.meta.get(META_KEY) !== stamp) {
        context.store.clear();
        context.meta.set(META_KEY, stamp);
      }
      const rootDir = fileURLToPath(context.config.root);
      const relative = path.relative(rootDir, folder).split(path.sep).join("/");
      registerSourceCollectionFolder({ collection: context.collection, folder, root: context.config.root });
      // A repository's docs often have no frontmatter: a page without a
      // `title` takes its first heading, else its file name.
      const parseData = Reflect.get(context, "parseData", context) as typeof context.parseData;
      const parseWithTitle: typeof context.parseData = (props) =>
        Reflect.apply(parseData, context, [
          props.data?.title === undefined
            ? { ...props, data: { ...props.data, title: titleFromFile(props.filePath, props.id) } }
            : props,
        ]);
      const inner = glob({ base: `./${relative}`, pattern });
      await inner.load(
        transparentProxy(
          context,
          new Map<PropertyKey, unknown>([
            ["watcher", undefined],
            ["parseData", parseWithTitle],
          ]),
        ),
      );
    },
  };
  nimbusGlobFiles.set(loader, (root) => {
    const folder = folderOf(root);
    return folder ? { base: folder, pattern } : undefined;
  });
  return loader;
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
    loader: wrapNimbusMarkdown(nimbusGlob(base, pattern), "partials"),
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
export function componentsCollection(
  options: ComponentsCollectionOptions = {},
) {
  const base = `./src/content/${options.base ?? "components"}`;
  const pattern = options.pattern ?? DEFAULT_PATTERN;

  return {
    loader: withNimbusMarkdown(nimbusGlob(base, pattern)),
    schema: componentsSchema,
  };
}

export interface ApiCollectionOptions {
  /** Collection name + base URL prefix — routes mount at `/<collection>`. */
  collection: string;
  /**
   * Local file path (relative to the project root) or an inline OpenAPI
   * object. Omit when `versions` is set.
   */
  spec?: string | Record<string, unknown>;
  /** Human label for build diagnostics (falls back to `collection`). */
  label?: string;
  /**
   * A version family — one entry per version. The default version indexes at
   * `/<collection>`; others nest at `/<collection>/<version>`. Provide exactly
   * one of `spec` or `versions`.
   */
  versions?: ApiVersionSpec[];
  /** Fail the build on an operation missing a usable `operationId`. Default false. */
  requireOperationId?: boolean;
  /** Publish a page per `components/schemas` entry. Default false. */
  schemaPages?: boolean;
  /** Code sample policy. See {@link ApiSamples}. */
  samples?: ApiSamples;
  /** `x-*` extension names to keep. See {@link ApiSpec.extensions}. */
  extensions?: string[];
  /** Route convention for this collection's pages (unversioned only; for a family
   *  set `routes` on each version). Omit to keep legacy operationId URLs. */
  routes?: ApiRoutePolicy;
}

/**
 * Content-collection config for one OpenAPI reference spec. The loader is a
 * build artifact: it parses the spec once and writes one DataStore entry per
 * page. Static sites keep those entries to route metadata and project complete
 * pages during prerendering. Server sites retain prepared page data so request
 * rendering never parses the source specification.
 *
 * Declare each spec once, in the `api` array of the Nimbus config in
 * `astro.config.ts`, and register one collection per entry, keyed by its
 * `collection` name:
 *
 *   // astro.config.ts
 *   const nimbusConfig = defineNimbusConfig({
 *     site: "https://example.com",
 *     title: "Example",
 *     api: [{ collection: "api", spec: "./src/api/openapi.yaml" }],
 *   });
 *
 *   // src/content.config.ts
 *   export const collections = {
 *     docs: defineCollection(docsCollection()),
 *     api: defineCollection(apiCollection()),
 *   };
 *
 * With no argument, the loader reads the `api` entry whose `collection`
 * matches the collection key, from the entries the Nimbus integration
 * registers for this project. A key with no matching entry, or an entry with
 * no matching key, fails the build with a message naming both files.
 *
 * Passing the entry explicitly, `apiCollection({ collection, spec, … })`, still
 * works unchanged and bypasses the lookup — for example from a separate
 * `nimbus.config.ts` built with `defineConfig` from the side-effect-free
 * `@cloudflare/nimbus-docs/config` entry.
 *
 * The OpenAPI engine is imported lazily inside `load()` — a prose-only site
 * that never registers an API collection pulls neither the engine nor its
 * parser.
 */
export function apiCollection(options?: ApiCollectionOptions): {
  loader: Loader;
  schema: z.ZodType<{
    coordinate: string;
    title: string;
    description?: string;
    version?: string;
    prepared?: import("./_internal/api/prepared.js").PreparedApiPage;
  }>;
} {
  // Explicit options are read once, here, exactly as before.
  const explicit: ApiCollectionOptions | undefined = options && {
    collection: options.collection,
    spec: options.spec,
    label: options.label,
    versions: options.versions,
    requireOperationId: options.requireOperationId,
    schemaPages: options.schemaPages,
    samples: options.samples,
    extensions: options.extensions,
    routes: options.routes,
  };

  const loader: Loader = {
    name: "nimbus-docs:api",
    async load(context) {
      const {
        logger,
        store,
        parseData,
        config: astroConfig,
        watcher,
      } = context;

      assertSupportedNode();

      // Without explicit options, read the Nimbus config's `api` entry named
      // after this collection key. The read happens per load, so a dev refresh
      // after an astro.config edit sees the edited entry.
      const registered = explicit
        ? undefined
        : resolveRegisteredApiCollection(astroConfig.root, context.collection);
      const { collection, spec, label, versions, requireOperationId, schemaPages, samples, extensions, routes } =
        explicit ?? registered!;
      // The sidebar and version modes always come from the Nimbus config's
      // `api` entry: request rendering and the build's component check read
      // them there too, so a second value could only disagree.
      const entry =
        registered ??
        getRegisteredApiCollections(astroConfig.root)?.find(
          (candidate) => candidate.collection === collection,
        );
      const sidebar = entry?.sidebar;
      const versionUrl = entry
        ? entry.versionUrl
        : (options as { versionUrl?: ApiVersionUrl } | undefined)?.versionUrl;
      // Compare what the setting means, so key order or a spelled-out
      // default doesn't count as a difference.
      const describeUrl = (url: ApiVersionUrl | undefined) =>
        url?.in === "query"
          ? `{ in: "query", param: "${url.param ?? "version"}" }`
          : `{ in: "path" }`;
      const passedOptions = (options ?? {}) as Record<string, unknown>;
      for (const [key, used, passed] of [
        [
          "sidebar",
          `"${sidebar ?? "full"}"`,
          passedOptions.sidebar === undefined
            ? undefined
            : `"${String(passedOptions.sidebar)}"`,
        ],
        [
          "versionUrl",
          describeUrl(versionUrl),
          passedOptions.versionUrl === undefined
            ? undefined
            : describeUrl(passedOptions.versionUrl as ApiVersionUrl),
        ],
      ] as const) {
        if (explicit && passed !== undefined && passed !== used) {
          logger.warn(
            `apiCollection({ collection: "${collection}" }) sets \`${key}\`, which is read only from the ` +
              `\`api\` entry in the Nimbus config (astro.config.*). Using ${used}; set \`${key}\` on that entry instead.`,
          );
        }
      }
      if (explicit && passedOptions.versionMode !== undefined) {
        logger.warn(
          `apiCollection({ collection: "${collection}" }) sets \`versionMode\`, which is now \`versionUrl\` and is read only from the ` +
            `\`api\` entry in the Nimbus config (astro.config.*). Set versionUrl: { in: "query" } on that entry instead.`,
        );
      }
      noteApiCollectionLoad(astroConfig.root, context.collection, collection);

      const {
        apiPageRoute,
        buildApiModel,
        clearApiModelCache,
        getApiNav,
        getApiPageIndex,
        getApiPageProps,
        getApiRouteProvenance,
        prepareApiNav,
        prepareApiPageCode,
        preparedApiVersion,
        registerConfiguredApiModel,
        resolveApiFamily,
        resolveSpecSource,
        stageApiModelNavList,
        targetUrlFields,
      } = await loadApiLoader();

      const rootDir = fileURLToPath(astroConfig.root);
      const persistPreparedPages =
        (registeredOutput(astroConfig.root) ?? astroConfig.output) !== "static";
      const preparedRoot = preparedMarkdownRootKey(astroConfig.root);
      const preparedSession = getPreparedMarkdownSession(preparedRoot);
      if (!isCollectionInBuildSlice(astroConfig.root, collection)) {
        // A partial build that leaves this reference out: no spec is parsed,
        // and the collection is committed empty so it stays a known page
        // collection whose routes emit nothing. The store is cleared
        // unconditionally so no previous build's pages survive.
        await runPreparedMarkdownTransaction(
          preparedRoot,
          `api:${collection}`,
          async () => {
            if (getPreparedMarkdownSession(preparedRoot) !== preparedSession) {
              return;
            }
            store.clear();
            const epoch = beginPreparedMarkdownLoad(
              preparedRoot,
              collection,
              false,
            );
            commitPreparedDataCollection(preparedRoot, collection, epoch, []);
          },
        );
        return;
      }
      const reportedErrors = new WeakSet<Error>();
      const targets = resolveApiFamily({
        collection,
        spec,
        label,
        versions,
        versionUrl,
        requireOperationId,
        schemaPages,
        samples,
        extensions,
        routes,
        sidebar,
      }, collectionMountPrefix(collection, getMountContext(context.config.root)));

      // M4: a non-default version id must not collide with a top-level page
      // slug of the default version (both would claim `/<collection>/<id>`).
      // Config validation rejects the structural reserved ids (schemas/tags/…);
      // this catches the dynamic set — an untagged `operationId` or a tag that
      // happens to equal a version id — which is only knowable post-parse.
      const nonDefaultVersionIds = targets
        .filter((t) => !t.isDefault && t.version)
        .map((t) => t.version!);

      let preparationNote = "";
      const index = async () => {
        let bundledBytes = 0;
        if (usesPageAssets(astroConfig.root, collection)) {
          const { prepareApiAssetFamily, getApiAssetPreparationMetrics } =
            await import("./_internal/api/page-assets-build.js");
          const started = performance.now();
          const before = getApiAssetPreparationMetrics();
          const prepared = await prepareApiAssetFamily(
            rootDir,
            {
              collection,
              spec,
              label,
              versions,
              versionUrl,
              requireOperationId,
              schemaPages,
              samples,
              extensions,
              routes,
              sidebar,
            },
            (message) => logger.warn(message),
          );
          preparationNote = describeRebuilds(prepared.versions);
          const after = getApiAssetPreparationMetrics();
          const delta = Object.fromEntries(
            Object.entries(after).map(([name, value]) => [
              name,
              value - before[name as keyof typeof before],
            ]),
          );
          logger.debug(
            `API "${collection}" prepared in ${Math.round(performance.now() - started)} ms ${JSON.stringify(delta)}`,
          );
          // No per-page payload or page index enters Astro's bundled store.
          // Build consumers enumerate the default staged index instead.
          return [];
        }
        const nextEntries: Array<Parameters<typeof store.set>[0]> = [];
        // Default-version top segment → the route provenances that produced it
        // ("override"/"derived"/"fallback", or "identity" for a page with none),
        // so the shadow diagnostic names the lever that actually moves each. Per
        // run, so a dev-watch reparse never inherits a stale segment.
        const defaultTopSegments = new Map<string, Set<string>>();
        // Two pages minting the same id is a silent last-writer-wins clobber
        // (e.g. an untagged `operationId: "index"` vs the default root's id).
        const seenIds = new Map<string, string>();
        // Cross-version drift: coordinate → (version → derived slug). Only
        // `derived` slugs are compared (overrides and fallbacks are excluded);
        // hidden versions are included, since they emit real URLs and links.
        const derivedByCoordinate = new Map<string, Map<string, string>>();
        for (const target of targets) {
          let model;
          try {
            const source = await resolveSpecSource(
              {
                collection: target.namespace,
                spec: target.spec,
                label: target.label,
                mountPath: target.mountPath,
                ...targetUrlFields(target),
                requireOperationId: target.requireOperationId,
                schemaPages: target.schemaPages,
                routes: target.routes,
                samples: target.samples,
                extensions: target.extensions,
              },
              rootDir,
            );
            model = await buildApiModel(source);
            warnUnusedExtensions(
              collection,
              target.version,
              unusedExtensions(model, target.extensions),
              (message) => logger.warn(message),
            );
            registerConfiguredApiModel(
              collection,
              target.version ?? null,
              model,
              {
                sidebar: target.sidebar,
                mountPath: target.mountPath,
                ...targetUrlFields(target),
              },
            );
            await stageApiModelNavList(
              rootDir,
              collection,
              target.version ?? null,
              model,
              target.sidebar === "on-demand",
            );
          } catch (err) {
            // `ApiBuildError` already formats a pointed diagnostic list; fail
            // with it (plus which spec failed) as the author's error, no stack.
            const message = `Failed to build the API reference for "${target.label}":\n${(err as Error).message}`;
            if (err instanceof ApiBuildError) throw authorError(message);
            logger.error(message);
            if (err instanceof Error) reportedErrors.add(err);
            throw err;
          }

          const provenance = getApiRouteProvenance(model);
          const navEntryId = apiPageRoute(target, "").storeId;
          const preparedNav = persistPreparedPages
            ? prepareApiNav(getApiNav(model))
            : undefined;
          for (const {
            coordinate,
            slug,
            title,
            description,
          } of getApiPageIndex(model)) {
            if (target.isDefault && slug !== "") {
              const top = slug.split("/")[0]!;
              const kinds = defaultTopSegments.get(top) ?? new Set<string>();
              kinds.add(provenance.get(coordinate) ?? "identity");
              defaultTopSegments.set(top, kinds);
            }
            if (target.version && provenance.get(coordinate) === "derived") {
              const byVersion =
                derivedByCoordinate.get(coordinate) ??
                derivedByCoordinate.set(coordinate, new Map()).get(coordinate)!;
              byVersion.set(target.version, slug);
            }
            const { storeId: id } = apiPageRoute(target, slug);
            const prior = seenIds.get(id);
            if (prior !== undefined) {
              const message =
                `nimbus-docs api: collection "${collection}"${target.version ? ` version "${target.version}"` : ""} ` +
                `maps two pages ("${prior}" and "${coordinate}") to the same route id "${id}". ` +
                `Rename one operation/tag so their URLs stay distinct.`;
              logger.error(message);
              throw new Error(message);
            }
            seenIds.set(id, coordinate);
            const prepared = persistPreparedPages
              ? {
                  version: preparedApiVersion,
                  page: await prepareApiPageCode(
                    getApiPageProps(model, coordinate),
                  ),
                  navEntryId,
                  ...(id === navEntryId ? { nav: preparedNav } : {}),
                }
              : undefined;
            // Measure until the hint threshold; past it the answer is known.
            if (prepared && bundledBytes <= BUNDLE_HINT_BYTES)
              bundledBytes += JSON.stringify(prepared).length;
            const data = await parseData({
              id,
              data: {
                coordinate,
                title,
                ...(description === undefined ? {} : { description }),
                ...(target.version ? { version: target.version } : {}),
                ...(prepared ? { prepared } : {}),
              },
            });
            nextEntries.push({ id, data });
          }
        }
        for (const versionId of nonDefaultVersionIds) {
          const kinds = defaultTopSegments.get(versionId);
          if (kinds) {
            // Renaming the version always resolves it; the second lever names the
            // hardest provenance present, since renaming an operationId moves
            // neither an override slug (pinned) nor a derived one (method+path).
            const fix = kinds.has("override")
              ? `Rename the version, or adjust the \`routes.operations\` override target for the colliding page, `
              : kinds.has("derived")
                ? `Rename the version, or pin a \`routes.operations\` override for the colliding operation ` +
                  `(a derived slug comes from method and path, so renaming the operationId will not change it), `
                : `Rename the version, or the colliding operation/tag, `;
            const message =
              `nimbus-docs api: version "${versionId}" of collection "${collection}" collides with a ` +
              `default-version page mounted at /${collection}/${versionId}. ${fix}so the version segment stays unambiguous.`;
            logger.error(message);
            throw new Error(message);
          }
        }
        // Cross-version drift (non-gating): one coordinate whose derived slug
        // differs across two or more versions, which may use different
        // conventions. Divergent wire paths across versions are legitimate, so
        // this warns and recommends pinning an override; it never fails the build.
        for (const [coordinate, byVersion] of derivedByCoordinate) {
          if (byVersion.size < 2) continue;
          const distinct = new Set(byVersion.values());
          if (distinct.size < 2) continue;
          const detail = [...byVersion]
            .map(([version, slug]) => `${version}→"${slug}"`)
            .join(", ");
          logger.warn(
            `nimbus-docs api: coordinate "${coordinate}" derives different route slugs across ` +
              `versions of "${collection}" (${detail}). Pin an explicit \`routes.operations\` ` +
              `override in each version to keep the URL stable across versions.`,
          );
        }
        // Prepared pages are bundled into the server. Suggest the escape hatch
        // well before the Worker's 64 MiB limit.
        if (
          bundledBytes > BUNDLE_HINT_BYTES &&
          rendersApiOnRequest(astroConfig.root, collection)
        ) {
          logger.warn(
            `API "${collection}" adds more than ${BUNDLE_HINT_BYTES / 1048576} MiB of page data to the server bundle. ` +
              `Set bundle: false on its api entry to serve it from static assets instead (Cloudflare and Node adapters).`,
          );
        }
        return nextEntries;
      };

      const updateIndex = () =>
        runPreparedMarkdownTransaction(
          preparedRoot,
          `api:${collection}`,
          async () => {
            if (getPreparedMarkdownSession(preparedRoot) !== preparedSession) {
              return;
            }
            const epoch = beginPreparedMarkdownLoad(
              preparedRoot,
              collection,
              false,
            );
            try {
              const nextEntries = await index();
              if (getPreparedMarkdownSession(preparedRoot) !== preparedSession) {
                cancelPreparedMarkdownLoad(preparedRoot, collection, epoch);
                return;
              }
              if (
                !commitPreparedDataCollection(
                  preparedRoot,
                  collection,
                  epoch,
                  nextEntries,
                )
              ) {
                return;
              }
              store.clear();
              for (const entry of nextEntries) store.set(entry);
              logger.info(
                usesPageAssets(astroConfig.root, collection)
                  ? `Prepared API pages for "${collection}" as static assets (bundle: false).${preparationNote}`
                  : `Indexed ${store.keys().length} API pages for "${collection}".`,
              );
            } catch (error) {
              cancelPreparedMarkdownLoad(preparedRoot, collection, epoch);
              throw error;
            }
          },
        );

      await updateIndex();

      // Dev only: reparse when any on-disk version spec changes. Inline-object
      // specs have no file to watch. After a dev restart Astro still hands
      // loaders the previous, closed Vite watcher; chokidar's `add()` would
      // silently reopen it and leak an fs watch nobody closes, so skip it (the
      // integration watches specs from the live watcher instead).
      if (watcher && !(watcher as { closed?: boolean }).closed) {
        const specPaths = new Map<string, true>();
        for (const target of targets) {
          if (typeof target.spec !== "string") continue;
          specPaths.set(path.resolve(rootDir, target.spec), true);
        }
        if (specPaths.size > 0) {
          const onChange = (changed: string) => {
            if (!specPaths.has(path.resolve(changed))) return;
            clearApiModelCache(collection);
            void updateIndex().catch((error: unknown) => {
              if (error instanceof Error && reportedErrors.has(error)) return;
              // An author error already names the spec that failed.
              logger.error(
                error instanceof AstroError
                  ? error.message
                  : `Failed to update the API reference for "${collection}":\n${error instanceof Error ? error.message : String(error)}`,
              );
            });
          };
          for (const specPath of specPaths.keys()) watcher.add(specPath);
          watcher.on("change", onChange);
          watcher.on("add", onChange);
          watcher.on("unlink", onChange);
        }
      }
    },
  };

  return {
    loader,
    schema: z.object({
      coordinate: z.string(),
      title: z.string(),
      description: z.string().optional(),
      version: z.string().optional(),
      prepared:
        z.custom<import("./_internal/api/prepared.js").PreparedApiPage>().optional(),
    }),
  };
}

function assertSupportedNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(
      `nimbus-docs api: Node >=22.12.0 is required to build an API reference ` +
        `(running ${process.versions.node}). Upgrade Node, or remove the \`api\` entries from the Nimbus config.`,
    );
  }
}
