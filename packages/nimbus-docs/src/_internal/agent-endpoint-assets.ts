import { invalidateDevModules, isDevContentFile, type DevServerGraphs } from "./dev-invalidation.js";
import { publishesAgentUrl, type AgentSurfaces } from "./agent-surfaces.js";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstat,
  mkdir,
  open,
  copyFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { entryRouteUrl } from "./astro-slug.js";
import { isPreparedApiPage } from "./api/prepared.js";
import { renderApiMarkdownDocument } from "./api/markdown-document.js";
import {
  LLMS_FULL_LIMIT_BYTES,
  flattenLlmsGroups,
  groupLlmsPages,
  llmsFullBodies,
  llmsSection,
  mebibytes,
  nestedCollectionLinks,
  sectionIndexDocument,
  servesSectionIndex,
  siteIndexDocument,
  utf8Length,
  type AbsentSection,
  type ApiVersionUrls,
  type LlmsDocumentContext,
  type LlmsGroup,
  type LlmsPage,
} from "./llms-documents.js";
import type { RenderedMarkdownPage } from "./api/markdown-record.js";
import { expandPreparedPartials } from "./build-partials.js";
import {
  COLLECTION_URLS_DOCS,
  collectionLabel,
  collectionMountPrefix,
  collectionUrlsKey,
  NO_ROUTES,
  PRIMARY_COLLECTION,
  type MountContext,
} from "./collection-mount.js";
import { collectionOwnershipErrors, type CollectionRoutes } from "./collection-routes.js";
import { llmsAssetUrl } from "./agent-endpoint-coverage.js";
import { isDiscoverable, isSearchable } from "./discoverability.js";
import { mergePartialHeadings } from "./partial-headings.js";
import {
  PREPARED_HEADINGS_GENERATION,
  type PreparedHeadingRecord,
} from "./prepared-headings.js";
import {
  getPreparedMarkdownSnapshot,
  getPreparedMarkdownRevision,
  preparedMarkdownCollectionCapability,
  preparedMarkdownRootKey,
  type PreparedMarkdownCollection,
  type PreparedMarkdownEntry,
  waitForPreparedMarkdownTransactions,
} from "./prepared-markdown-registry.js";
import { orderPageCollections } from "./page-collections.js";
import { registerAgentEndpointAssetReader } from "./agent-endpoint-asset-reader.js";
import {
  absoluteMarkdownLinks,
  renderEntryAsMarkdown,
} from "./transform.js";
import {
  MCP_PAGE_INDEX_VERSION,
  type McpPageIndex,
  type McpPageRecord,
} from "./mcp/page-index.js";
import type { SidebarPosition } from "./llms-order.js";
import { toDocumentHref, toRouteKey, withBase } from "./url.js";
import type {
  GeneratedMarkdownComponentTransform,
  GeneratedMarkdownPartialResolver,
} from "../types.js";
import type {
  LlmsEndpointPayload,
  LlmsEndpointReference,
  MarkdownEndpointPayload,
  MarkdownEndpointReference,
} from "../agent-endpoints.js";

export const AGENT_ENDPOINT_ASSET_MANIFEST_VERSION = 7;
export const AGENT_ENDPOINT_ASSET_GENERATION = 2;

export interface MarkdownEndpointAsset extends MarkdownEndpointReference {
  url: string;
  /** The record's fingerprint (its inputs): the file name and the cache key. */
  digest: string;
  /** SHA-256 of the file's bytes: the response's ETag. */
  hash: string;
  mediaType: string;
  path: string;
  contentStart: number;
  contentEnd: number;
  /**
   * `false` when no route of the site serves `url`: the body is kept for the
   * MCP server, which reads pages by path, and nothing links or serves it.
   */
  published?: false;
}

/** Cloudflare serves static files up to 25 MiB; larger ones fail the deploy. */

export type LlmsEndpointAsset = LlmsEndpointReference & {
  digest: string;
  hash: string;
  mediaType: string;
  path: string;
};

export interface PageIndexAsset {
  digest: string;
  hash: string;
  mediaType: string;
  path: string;
}

export interface AgentEndpointAssetManifest {
  version: 7;
  generation: number;
  base: string;
  audience: "public";
  markdownAssets: MarkdownEndpointAsset[];
  /** API pages that render their Markdown on request instead of baking it. */
  rendered: RenderedMarkdownPage[];
  llmsAssets: LlmsEndpointAsset[];
  /**
   * The agent documents whose routes render on request. Not baked: the
   * Worker makes them from `pages`, the discoverable page list.
   */
  onRequest: { llms: boolean; llmsSections: boolean; llmsFull: boolean };
  /** The discoverable pages the indexes list, in reading order, when a document renders on request. */
  pages?: LlmsPage[];
  /** Sections another build slice holds, for the indexes. */
  absentSections?: AbsentSection[];
  /** Whether `/llms-full.txt` is one document or an index of parts (baked split, or made on request). */
  fullSplit: boolean;
  /** The sections an on-request `llms-full.txt` lists as parts (`/<slug>/llms-full.txt`). */
  renderedParts?: string[];
  /** Tests only: the part size limit the build was given, so the Worker splits at the same size. */
  fullLimitBytes?: number;
  /**
   * Identifies this build's output and the inputs of what it renders on
   * request: a cache key for documents assembled on request.
   */
  buildId: string;
  pageIndex?: PageIndexAsset;
  headings: PreparedHeadingRecord[];
}

/** What a deployed server reads: the manifest without the build-only headings. */
export type StagedAgentEndpointManifest = Omit<AgentEndpointAssetManifest, "headings">;

function stagedManifest(manifest: AgentEndpointAssetManifest): StagedAgentEndpointManifest {
  const { headings: _headings, ...staged } = manifest;
  return staged;
}

function manifestAssets(manifest: AgentEndpointAssetManifest): Array<{ path: string }> {
  return [
    ...manifest.markdownAssets,
    ...manifest.llmsAssets,
    ...(manifest.pageIndex ? [manifest.pageIndex] : []),
  ];
}

export type AgentEndpointVisibilityDecision =
  | { status: "include" }
  | { status: "exclude"; reason: string }
  | { status: "unknown"; reason: string };

export interface BakeAgentEndpointAssetsOptions {
  /**
   * Whether a collection's pages render on request. Such an API page's
   * Markdown is not baked: the manifest describes the page and the Worker
   * renders it when asked, through the same serialization.
   */
  requestRendered?: (collection: string) => boolean;
  /** Versioned API families by collection, for the per-version parts of an on-request `llms-full`. */
  apiVersions?: Readonly<Record<string, ApiVersionUrls>>;
  /** Each page's place in the sidebar's reading order, given the pages. Without it, indexes list by URL. */
  sidebarPosition?: (pages: ReadonlyArray<{ collection: string; url: string }>) => Promise<SidebarPosition>;
  root: URL | string;
  base: string;
  site: string;
  title: string;
  description?: string;
  socialImage?: string;
  versions?: {
    current: string;
    others: readonly string[];
    deprecated?: readonly string[];
    hidden?: readonly string[];
  };
  /** Collections served by a route helper, by where the route file is. None by default. */
  routes?: CollectionRoutes;
  /** The remote MCP endpoint, when the site serves one; `llms.txt` names it. */
  mcpUrl?: string;
  citationIndex?: ReadonlyMap<string, string>;
  componentMap?: Record<string, GeneratedMarkdownComponentTransform>;
  partialResolver?: GeneratedMarkdownPartialResolver;
  decidePublic?: (entry: PreparedMarkdownEntry) => AgentEndpointVisibilityDecision;
  apiEntries?: readonly LlmsEndpointApiEntry[];
  loadApiEntries?: () => Promise<readonly LlmsEndpointApiEntry[]>;
  /** Reports build output that some hosts can't serve. */
  warn?: (message: string) => void;
  /** Reports what the bake did, such as splitting `llms-full.txt`. */
  info?: (message: string) => void;
  /** Tests only: a smaller `llms-full.txt` limit than Cloudflare's. */
  llmsFullLimitBytes?: number;
  /** Whether a route serves `/llms-full.txt`. Default true. `surfaces` wins when given. */
  fullDocument?: boolean;
  /**
   * The agent surfaces the site's routes serve. Without it every surface is
   * taken as served, as a site with every starter route.
   */
  surfaces?: AgentSurfaces;
  /**
   * Keep every page's Markdown body in the build cache even when no route
   * publishes it: Pagefind over request-rendered pages reads the text there.
   * Such bodies are never staged into the deploy.
   */
  buildBodies?: boolean;
  /**
   * A partial build without the root collection: write one `llms-full.txt`
   * per named top-level section (the slice's collections, by label) instead
   * of the site document, which that build's Worker can't serve. A section
   * over the limit splits as usual.
   */
  sectionDocuments?: readonly string[];
  /**
   * Page collections a partial build left empty: the site index lists each
   * one's `llms.txt`, which the slice holding it serves.
   */
  absentSections?: ReadonlyArray<{ slug: string; label: string; position?: number }>;
  /**
   * Whether the section route serves nested paths (`[...section]/llms.txt`).
   * Then each sub-folder gets its own `llms.txt`. Default false.
   */
  nestedSections?: boolean;
  /** The page view model of an API entry that carries none (thin entries). */
  projectApiEntryPage?: (
    entry: LlmsEndpointApiEntry,
  ) => Promise<import("./api/api-view-types.js").ApiPageProps>;
}

/** Whether a route of the site serves `url`; every URL when no surfaces were given. */
function publishes(options: BakeAgentEndpointAssetsOptions, url: string): boolean {
  return options.surfaces ? publishesAgentUrl(options.surfaces.markdownRoutes, url) : true;
}
function servesLlms(options: BakeAgentEndpointAssetsOptions): boolean {
  return options.surfaces?.llms ?? true;
}
function servesLlmsSections(options: BakeAgentEndpointAssetsOptions): boolean {
  return options.surfaces?.llmsSections ?? true;
}
/** Which agent documents the routes render on request. */
function onRequest(options: BakeAgentEndpointAssetsOptions): { llms: boolean; llmsSections: boolean; llmsFull: boolean } {
  return options.surfaces?.onRequest ?? { llms: false, llmsSections: false, llmsFull: false };
}

/** A route at `/llms-full.txt`: the full document is linked from the indexes. */
function servesLlmsFull(options: BakeAgentEndpointAssetsOptions): boolean {
  return options.surfaces?.llmsFull ?? options.fullDocument !== false;
}
/**
 * The full document is baked when a route at `/llms-full.txt` serves it, or
 * when the integration found `llmsFullRoute()` in a route file at another
 * path (the site's own URL for it): that route reads the same payload.
 */
function bakesLlmsFull(options: BakeAgentEndpointAssetsOptions): boolean {
  return servesLlmsFull(options) || options.fullDocument === true;
}

export interface BakePreparedHeadingsOptions {
  root: URL | string;
  base: string;
  partialResolver?: GeneratedMarkdownPartialResolver;
}

export interface LlmsEndpointApiEntry {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  hidden?: boolean;
  /** The entry id of the sidebar group the page is listed under: its own id
   * when it indexes a group (a product, tag or resource), else its nearest
   * ancestor's. Absent for a top-level page, which is placed by its URL. */
  section?: string;
  /**
   * A query-mode non-default version's page: no index lists it and no route
   * serves its Markdown (its URL carries the version), but an `llms-full`
   * part made on request holds it.
   */
  historical?: boolean;
}

interface AgentEndpointAssetState {
  version: 1;
  demands: Set<string>;
  publications: Map<string, Promise<void>>;
  readers: Map<
    string,
    { active: number; idle: Promise<void>; resolve: () => void }
  >;
  roots: Map<
    string,
    {
      mode: "build" | "dev";
      bake: () => Promise<AgentEndpointAssetManifest>;
      bakeHeadings?: () => Promise<PreparedHeadingRecord[]>;
      headingsBase?: string;
      lazyHeading?: (
        collection: string,
        id: string,
      ) => Promise<PreparedHeadingRecord | null>;
      bakedRevision?: number;
      invalidation: number;
      bakedInvalidation?: number;
      inFlight?: Promise<AgentEndpointAssetManifest>;
      manifest?: AgentEndpointAssetManifest;
      markdownAssets?: Map<string, MarkdownEndpointAsset>;
      llmsAssets?: Map<string, LlmsEndpointAsset>;
      headings?: Map<string, PreparedHeadingRecord>;
    }
  >;
}

const STATE_KEY = Symbol.for(
  "@cloudflare/nimbus-docs/agent-endpoint-assets/v1",
);
const stateGlobal = globalThis as typeof globalThis & {
  [STATE_KEY]?: AgentEndpointAssetState;
};
const agentEndpointAssetState = (stateGlobal[STATE_KEY] ??= {
  version: 1,
  demands: new Set(),
  publications: new Map(),
  readers: new Map(),
  roots: new Map(),
});
agentEndpointAssetState.publications ??= new Map();
agentEndpointAssetState.readers ??= new Map();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function markdownAssetKey(reference: MarkdownEndpointReference): string {
  return `${reference.collection}\0${reference.id}\0${reference.surface}`;
}

function preparedLlmsKey(reference: LlmsEndpointReference): string {
  return reference.scope === "site"
    ? `${reference.scope}\0${reference.surface}`
    : `${reference.scope}\0${reference.section}\0${reference.surface}`;
}

function headingKey(collection: string, id: string): string {
  return `${collection}\0${id}`;
}

function agentEndpointAssetRoot(root: URL | string): string {
  return path.join(
    preparedMarkdownRootKey(root),
    ".astro",
    "nimbus",
    "agent-endpoint-assets",
  );
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  try {
    if ((await lstat(root)).isSymbolicLink()) {
      throw new Error(
        `nimbus-docs: agent-endpoint asset path contains a symbolic link: ${root}.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(
          `nimbus-docs: agent-endpoint asset path contains a symbolic link: ${current}.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function resolveContainedAssetPath(root: string, assetPath: string): string {
  if (
    assetPath.length === 0 ||
    path.isAbsolute(assetPath) ||
    path.win32.isAbsolute(assetPath)
  ) {
    throw new Error(
      `nimbus-docs: agent-endpoint asset path must be relative: ${assetPath}.`,
    );
  }
  const resolved = path.resolve(root, assetPath);
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `nimbus-docs: agent-endpoint asset path escapes its root: ${assetPath}.`,
    );
  }
  return resolved;
}

async function writeAsset(file: string, body: string): Promise<boolean> {
  let created = false;
  try {
    const handle = await open(file, "wx");
    created = true;
    try {
      await handle.writeFile(body, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (created) {
      await rm(file, { force: true });
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `nimbus-docs: agent-endpoint asset is not a regular file: ${file}.`,
      );
    }
    if ((await readFile(file, "utf8")) !== body) await writeFile(file, body, "utf8");
    return false;
  }
}

async function writeManifest(
  directory: string,
  manifest: AgentEndpointAssetManifest,
): Promise<void> {
  const temporary = path.join(
    directory,
    `manifest.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, path.join(directory, "manifest.json"));
}

function beginAssetRead(root: string): () => void {
  let readers = agentEndpointAssetState.readers.get(root);
  if (!readers || readers.active === 0) {
    let resolve = () => {};
    const idle = new Promise<void>((done) => {
      resolve = done;
    });
    readers = { active: 0, idle, resolve };
    agentEndpointAssetState.readers.set(root, readers);
  }
  readers.active += 1;
  return () => {
    if (!readers || readers.active === 0) return;
    readers.active -= 1;
    if (readers.active === 0) readers.resolve();
  };
}

async function cleanupAssets(
  root: string,
  directory: string,
  manifest: AgentEndpointAssetManifest,
): Promise<void> {
  const pendingReaders = agentEndpointAssetState.readers.get(root)?.idle;
  if (pendingReaders) await pendingReaders;
  const retained = new Set(manifestAssets(manifest).map((asset) => asset.path));
  const assetDirectory = path.join(directory, "assets");
  const entries = await readdir(assetDirectory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          !entry.isDirectory() && !retained.has(`assets/${entry.name}`),
      )
      .map((entry) =>
        rm(path.join(assetDirectory, entry.name), { force: true }),
      ),
  );
}

async function publishManifest(
  root: string,
  directory: string,
  manifest: AgentEndpointAssetManifest,
  previous: AgentEndpointAssetManifest | undefined,
  isFresh: () => boolean,
  endpointAssets: ReadonlyArray<{ path: string; body: string }>,
  onPublished: () => void | Promise<void>,
): Promise<boolean> {
  const prior = agentEndpointAssetState.publications.get(root) ?? Promise.resolve();
  let published = false;
  const operation = prior.then(async () => {
    if (!isFresh()) return;
    const created: string[] = [];
    const removeCreated = async () => {
      const retained = new Set(
        previous ? manifestAssets(previous).map((asset) => asset.path) : [],
      );
      await Promise.all(
        created
          .filter((assetPath) => !retained.has(assetPath))
          .map((assetPath) =>
            rm(path.join(directory, assetPath), { force: true }),
          ),
      );
    };
    try {
      const writes = await Promise.allSettled(
        endpointAssets.map(async (asset) => {
          if (
            await writeAsset(
              path.join(directory, asset.path),
              asset.body,
            )
          ) {
            created.push(asset.path);
          }
        }),
      );
      const failed = writes.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) throw failed.reason;
      if (!isFresh()) {
        await removeCreated();
        return;
      }
      await writeManifest(directory, manifest);
    } catch (error) {
      await removeCreated();
      throw error;
    }
    if (isFresh()) {
      await onPublished();
      published = true;
    } else if (previous) {
      await writeManifest(directory, previous);
      await removeCreated();
    } else {
      await rm(path.join(directory, "manifest.json"), { force: true });
      await removeCreated();
    }
  });
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  agentEndpointAssetState.publications.set(root, settled);
  try {
    await operation;
  } finally {
    if (agentEndpointAssetState.publications.get(root) === settled) {
      agentEndpointAssetState.publications.delete(root);
    }
  }
  return published;
}

function urlsField(context: MountContext): { urls?: string } {
  const urls = collectionUrlsKey(context);
  return urls === undefined ? {} : { urls };
}

function assertPreparedCollection(
  name: string,
  collection: PreparedMarkdownCollection,
  base: string,
  context: MountContext,
): void {
  const expected = preparedMarkdownCollectionCapability(
    name,
    collection.entries.values(),
    { generation: AGENT_ENDPOINT_ASSET_GENERATION, base, ...urlsField(context) },
  );
  if (
    collection.capability.generation !== expected.generation ||
    collection.capability.base !== expected.base ||
    collection.capability.urls !== expected.urls ||
    collection.capability.digest !== expected.digest
  ) {
    throw new Error(
      `nimbus-docs: cannot bake collection "${name}" because its bodies were not prepared ` +
        `for generation ${AGENT_ENDPOINT_ASSET_GENERATION} and base ${JSON.stringify(base)}. ` +
        "Use withNimbusMarkdown(loader) for custom body-retaining loaders.",
    );
  }
}

function defaultDecision(entry: PreparedMarkdownEntry): AgentEndpointVisibilityDecision {
  if (entry.data.draft === true) return { status: "exclude", reason: "draft" };
  if (
    entry.data.visibility === undefined ||
    entry.data.visibility === "public"
  ) {
    return { status: "include" };
  }
  return {
    status: "unknown",
    reason: `unsupported visibility ${JSON.stringify(entry.data.visibility)}`,
  };
}

function absoluteUrl(site: string, base: string, pathname: string): string {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(pathname)) return pathname;
  const prefix = base === "/" ? "" : base.replace(/\/+$/u, "");
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(`${prefix}${normalized}`, site).href;
}

function absoluteAssetUrl(
  site: string,
  base: string,
  pathname: string,
): string {
  return new URL(withBase(pathname, base), site).href;
}

function withAssetBase(base: string, pathname: string): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return pathname;
  const prefix = base === "/" ? "" : base.replace(/\/+$/u, "");
  return `${prefix}${pathname}`;
}

function docsVersion(
  collection: string,
  versions: BakeAgentEndpointAssetsOptions["versions"],
): string | undefined {
  if (!versions) return undefined;
  if (collection === PRIMARY_COLLECTION) return versions.current;
  const version = collection.startsWith("docs-") ? collection.slice("docs-".length) : undefined;
  return version && versions.others.includes(version) ? version : undefined;
}

function entryVersion(
  entry: Pick<PreparedMarkdownEntry, "collection" | "id" | "data">,
  versions: BakeAgentEndpointAssetsOptions["versions"],
): string | undefined {
  if (typeof entry.data.version === "string") return entry.data.version;
  return docsVersion(entry.collection, versions);
}

function preparedMarkdownUrls(
  entry: Pick<PreparedMarkdownEntry, "collection" | "id" | "data">,
  options: BakeAgentEndpointAssetsOptions,
) {
  const route = entryRouteUrl(
    collectionMountPrefix(entry.collection, mountContext(options)),
    entry.id,
  );
  return {
    markdown: route === "/" ? "/index.md" : `${route}/index.md`,
    source: route === "/" ? "/index.mdx" : `${route}/index.mdx`,
  };
}

/** A date at midnight UTC as `YYYY-MM-DD`; any other instant as full ISO. */
function frontmatterDate(date: Date): string {
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

function frontmatterScalar(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return JSON.stringify(frontmatterDate(value));
  return undefined;
}

/**
 * `docsCollection({ markdownFields })`: each named field of the entry's
 * data as a frontmatter line, in list order. Missing values are left out;
 * arrays are JSON flow sequences.
 */
function markdownFieldLines(
  entry: Pick<PreparedMarkdownEntry, "collection" | "id" | "data">,
  fields: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    const value = entry.data[field];
    if (value === undefined || value === null) continue;
    const written = Array.isArray(value)
      ? value.every((item) => frontmatterScalar(item) !== undefined)
        ? `[${value.map((item) => frontmatterScalar(item)).join(", ")}]`
        : undefined
      : frontmatterScalar(value);
    if (written === undefined) {
      throw new Error(
        `nimbus-docs: "${entry.collection}:${entry.id}" can't write markdownFields "${field}" to its .md: ` +
          "values must be strings, numbers, booleans, dates, or arrays of those.",
      );
    }
    lines.push(`${field}: ${written}`);
  }
  return lines;
}

function entryDescription(
  entry: Pick<PreparedMarkdownEntry, "data">,
): string | undefined {
  return typeof entry.data.description === "string" &&
    entry.data.description.length > 0
    ? entry.data.description
    : undefined;
}

/** An entry's title, as the document's frontmatter carries it. */
function oneLineTitle(entry: Pick<PreparedMarkdownEntry, "id" | "data">): string {
  return typeof entry.data.title === "string" && entry.data.title.length > 0 ? entry.data.title : entry.id;
}

function frontmatter(
  entry: Pick<PreparedMarkdownEntry, "collection" | "id" | "data">,
  options: BakeAgentEndpointAssetsOptions,
  { fields = [], description }: { fields?: readonly string[]; description?: string } = {},
): string[] {
  const title =
    typeof entry.data.title === "string" && entry.data.title.length > 0
      ? entry.data.title
      : entry.id;
  const image =
    typeof entry.data.socialImage === "string" &&
    entry.data.socialImage.length > 0
      ? entry.data.socialImage
      : options.socialImage;
  const version = entryVersion(entry, options.versions);
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(image
      ? [
          `image: ${JSON.stringify(absoluteAssetUrl(options.site, options.base, image))}`,
        ]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    ...markdownFieldLines(entry, fields),
    "---",
  ];
}

interface MarkdownEndpointPayloadBody {
  body: string;
  contentStart: number;
  contentEnd: number;
}

function envelopedAsset(prefix: string, content: string, suffix = "") {
  return {
    body: `${prefix}${content}${suffix}`,
    contentStart: prefix.length,
    contentEnd: prefix.length + content.length,
  } satisfies MarkdownEndpointPayloadBody;
}

function markdownAsset(
  entry: PreparedMarkdownEntry,
  markdown: string,
  options: BakeAgentEndpointAssetsOptions,
  fields: readonly string[],
): MarkdownEndpointPayloadBody {
  const title =
    typeof entry.data.title === "string" && entry.data.title.length > 0
      ? entry.data.title
      : entry.id;
  const urls = preparedMarkdownUrls(entry, options);
  const prefix = [
    ...frontmatter(entry, options, { fields, description: entryDescription(entry) }),
    "",
    ...llmsIndexNote(options),
    `# ${title}`,
    "",
  ].join("\n");
  // The source line names the `.mdx` only when a route serves it.
  const suffix = publishes(options, urls.source)
    ? ["", `Source: ${absoluteUrl(options.site, options.base, urls.source)}`, ""].join("\n")
    : "";
  // A frontmatter-only page is its title and source, with no blank body between.
  if (markdown.trim() === "") return envelopedAsset(`${prefix}\n`, "", suffix.slice(1));
  return envelopedAsset(`${prefix}\n`, markdown, suffix ? `\n${suffix}` : "\n");
}

/** The "Documentation Index" note every page Markdown opens with, when a route serves `/llms.txt`. */
function llmsIndexNote(options: BakeAgentEndpointAssetsOptions): string[] {
  if (!servesLlms(options)) return [];
  return [
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absoluteUrl(options.site, options.base, "/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
  ];
}

function sourceAsset(
  entry: PreparedMarkdownEntry,
  expanded: string,
  options: BakeAgentEndpointAssetsOptions,
  fields: readonly string[],
): MarkdownEndpointPayloadBody {
  return envelopedAsset(
    `${[...frontmatter(entry, options, { fields, description: entryDescription(entry) }), ""].join("\n")}\n`,
    expanded,
  );
}

/** A page as the bake lists it, with its Markdown body for the full document. */
interface PreparedLlmsPage extends LlmsPage {
  markdown: string;
}

/**
 * An estimate of an unrendered API page's Markdown bytes: the stored record's
 * JSON bytes (a page pack row's, or the prepared page's). The Markdown made
 * from a record is usually smaller (0.07–0.98 of the record across the
 * Cloudflare API's pages), though a record rich in constructs the emitter
 * expands can exceed it. A part that proves bigger than its estimate while
 * assembling still stops at the limit; the estimate only decides what is
 * never attempted.
 */
function markdownBytesEstimate(entry: Pick<PreparedMarkdownEntry, "data">): number | undefined {
  if (typeof entry.data.recordBytes === "number") return entry.data.recordBytes;
  if (isPreparedApiPage(entry.data.prepared)) return utf8Length(JSON.stringify(entry.data.prepared.page));
  return undefined;
}

function preparedLlmsPage(
  entry: Pick<PreparedMarkdownEntry, "collection" | "id" | "data"> & { section?: string; historical?: boolean },
  /** The body made here, or `null` for a page the Worker renders. */
  markdown: string | null,
  options: BakeAgentEndpointAssetsOptions,
  api = false,
  /** An estimate of the body's bytes when it is not made here. */
  bytesEstimate?: number,
): PreparedLlmsPage {
  const route = entryRouteUrl(
    collectionMountPrefix(entry.collection, mountContext(options)),
    entry.id,
  );
  // A non-default API version's page says where it is served (`/api/v1/…`,
  // or the version-free URL with the version in the query).
  const ownUrl = typeof entry.data.url === "string" ? entry.data.url : undefined;
  const apiVersion = typeof entry.data.apiVersion === "string" ? entry.data.apiVersion : undefined;
  return {
    collection: entry.collection,
    id: entry.id,
    title:
      typeof entry.data.title === "string" && entry.data.title.length > 0
        ? entry.data.title
        : entry.id,
    description: entryDescription(entry),
    url: ownUrl ?? toDocumentHref(route),
    // A historical page's Markdown is served nowhere; a path-version page's
    // is, where a route serves it, at its own version's URL.
    ...(!entry.historical && publishes(options, route === "/" ? "/index.md" : `${route}/index.md`)
      ? { markdownUrl: route === "/" ? "/index.md" : `${route}/index.md` }
      : {}),
    markdown: markdown ?? "",
    // Exact for a body made here (an empty one included); the record's
    // estimate for one the Worker makes.
    ...(markdown !== null ? { bytes: utf8Length(markdown) } : bytesEstimate !== undefined ? { bytes: bytesEstimate } : {}),
    groupLabel: sidebarGroupLabel(entry.data),
    ...(api ? { api } : {}),
    ...(entry.section !== undefined ? { section: entry.section } : {}),
    ...(apiVersion !== undefined ? { apiVersion } : {}),
    ...(entry.historical ? { historical: true as const } : {}),
  };
}

/** Whether a page's collection is served at the root, like `docs`. */

function mountContext(options: BakeAgentEndpointAssetsOptions): MountContext {
  return { versions: options.versions ?? null, routes: options.routes ?? NO_ROUTES };
}

/** What the agent documents say about the site: the same context the Worker builds on request. */
function documentContext(options: BakeAgentEndpointAssetsOptions): LlmsDocumentContext {
  return {
    site: options.site,
    base: options.base,
    title: options.title,
    ...(options.description ? { description: options.description } : {}),
    versions: options.versions ?? null,
    routes: options.routes ?? NO_ROUTES,
    nestedSections: options.nestedSections === true,
    ...(options.mcpUrl ? { mcpUrl: options.mcpUrl } : {}),
    ...(options.absentSections ? { absentSections: options.absentSections } : {}),
    publishes: (url) => publishes(options, url),
    llms: servesLlms(options),
    llmsFull: servesLlmsFull(options),
    ...(options.apiVersions ? { apiVersions: options.apiVersions } : {}),
  };
}

/**
 * One MCP page-index record. Only docs pages carry a version: an API
 * entry's own version is its API's, not one of the site's docs versions.
 */
function mcpPageRecord(
  entry: Pick<PreparedMarkdownEntry, "collection" | "id" | "data">,
  page: PreparedLlmsPage,
  options: BakeAgentEndpointAssetsOptions,
): McpPageRecord {
  const version = docsVersion(entry.collection, options.versions);
  const deprecated =
    version !== undefined &&
    (options.versions?.deprecated ?? []).includes(version);
  return {
    title: page.title,
    ...(page.description ? { description: page.description } : {}),
    url: absoluteUrl(options.site, options.base, page.url),
    ...(page.markdownUrl ? { markdownUrl: absoluteUrl(options.site, options.base, page.markdownUrl) } : {}),
    // The asset's own path, published or not: the MCP server reads bodies by it.
    markdownPath: preparedMarkdownUrls(entry, options).markdown,
    section: llmsSection(page, documentContext(options)),
    ...(version ? { version } : {}),
    ...(deprecated ? { deprecated: true as const } : {}),
    searchable: isSearchable(entry),
  };
}

function mcpPageIndexAsset(
  pages: McpPageRecord[],
  base: string,
  options: BakeAgentEndpointAssetsOptions,
): PageIndexAsset & { body: string } {
  pages.sort((a, b) => compare(a.url, b.url));
  const hidden = options.versions?.hidden ?? [];
  const pageIndex: McpPageIndex = {
    version: MCP_PAGE_INDEX_VERSION,
    versions: options.versions
      ? [options.versions.current, ...options.versions.others].filter((version) => !hidden.includes(version))
      : [],
    pages,
  };
  const body = `${JSON.stringify(pageIndex)}\n`;
  const fingerprint = digest(
    JSON.stringify({
      generation: AGENT_ENDPOINT_ASSET_GENERATION,
      base,
      audience: "public",
      pageIndex: digest(body),
    }),
  );
  return {
    digest: `sha256:${fingerprint}`,
    hash: digest(body),
    mediaType: "application/json",
    path: `assets/${fingerprint}.json`,
    body,
  };
}

function sidebarGroupLabel(data: Record<string, unknown>): string | undefined {
  const sidebar = data.sidebar as { group?: { label?: unknown } } | undefined;
  const label = sidebar?.group?.label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

/** Every section, parents before their sub-sections. */

/** A section's index page: the member whose path ends at the section. */

/** A section's name, as the sidebar names it: the index page's group label or title, else the formatted slug. */

/** A `> ` summary, one marker per line. */

function assertLlmsRouteSafety(
  pages: readonly PreparedLlmsPage[],
  groups: readonly LlmsGroup<PreparedLlmsPage>[],
): void {
  const routes = new Set(["/llms.txt", "/llms-full.txt"]);
  for (const group of flattenLlmsGroups(groups)) {
    const decodedSegments: string[] = [];
    for (const segment of group.slug.split("/")) {
      let decoded = segment;
      while (true) {
        let next: string;
        try {
          next = decodeURIComponent(decoded);
        } catch {
          throw new Error(
            `nimbus-docs: llms.txt section slug is malformed: ${JSON.stringify(group.slug)}.`,
          );
        }
        if (next === decoded) break;
        decoded = next;
      }
      if (
        decoded === "" ||
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\")
      ) {
        throw new Error(
          `nimbus-docs: llms.txt section slug is unsafe: ${JSON.stringify(group.slug)}.`,
        );
      }
      decodedSegments.push(decoded);
    }
    const decoded = decodedSegments.join("/");
    const route = toRouteKey(`/${decoded}/llms.txt`);
    if (routes.has(route)) {
      throw new Error(
        `nimbus-docs: duplicate llms.txt route identity "${route}".`,
      );
    }
    routes.add(route);
  }
  const pageRoutes = new Map<string, PreparedLlmsPage>();
  for (const page of pages) {
    for (const segment of page.id.split("/")) {
      let decoded = segment;
      while (true) {
        let next: string;
        try {
          next = decodeURIComponent(decoded);
        } catch {
          throw new Error(
            `nimbus-docs: page "${page.collection}:${page.id}" has an unsafe entry ID.`,
          );
        }
        if (next === decoded) break;
        decoded = next;
      }
      if (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\")
      ) {
        throw new Error(
          `nimbus-docs: page "${page.collection}:${page.id}" has an unsafe entry ID.`,
        );
      }
    }
    const route = toRouteKey(page.url);
    const existing = pageRoutes.get(route);
    if (existing) {
      throw new Error(
        `nimbus-docs: page "${page.collection}:${page.id}" collides with ` +
          `page "${existing.collection}:${existing.id}" at generated Markdown route "${route}".`,
      );
    }
    pageRoutes.set(route, page);
    if (routes.has(route)) {
      throw new Error(
        `nimbus-docs: page "${page.collection}:${page.id}" collides with the generated llms.txt route "${route}".`,
      );
    }
  }
}

function componentFingerprint(
  componentMap: BakeAgentEndpointAssetsOptions["componentMap"],
): string {
  return JSON.stringify(
    Object.entries(componentMap ?? {})
      .map(([name, value]): [string, string] => [name, value.revision])
      .sort(([a], [b]) => compare(a, b)),
  );
}

export interface PreparedHeadingsPlugin {
  name: string;
  enforce?: "pre" | "post";
  resolveId(id: string): string | undefined;
  load(
    this: { environment?: { name?: string } },
    id: string,
  ): Promise<string | undefined> | string | undefined;
  handleHotUpdate(context: { server: DevServerGraphs }): void;
}

const HEADINGS_VIRTUAL_ID = "virtual:nimbus/headings";
const HEADINGS_RESOLVED_ID = `\0${HEADINGS_VIRTUAL_ID}`;
const ARTIFACTS_VIRTUAL_ID = "virtual:nimbus/agent-endpoint-assets";
const ARTIFACTS_RESOLVED_ID = `\0${ARTIFACTS_VIRTUAL_ID}`;
const ASSET_LOADER_VIRTUAL_ID = "virtual:nimbus/agent-endpoint-asset-loader";
const ASSET_LOADER_RESOLVED_ID = `\0${ASSET_LOADER_VIRTUAL_ID}`;

const HEADINGS_ENTRY_PREFIX = `${HEADINGS_VIRTUAL_ID}/`;

export function preparedHeadingsPlugin(
  root: URL | string,
): PreparedHeadingsPlugin {
  // Per-entry modules the dev server has loaded, to invalidate on an update.
  const entryModules = new Set<string>();
  return {
    name: "nimbus-docs:prepared-headings",
    resolveId(id) {
      if (id === HEADINGS_VIRTUAL_ID) return HEADINGS_RESOLVED_ID;
      return id.startsWith(HEADINGS_ENTRY_PREFIX) ? `\0${id}` : undefined;
    },
    async load(id) {
      const isEntry = id.startsWith(`\0${HEADINGS_ENTRY_PREFIX}`);
      if (id !== HEADINGS_RESOLVED_ID && !isEntry) return undefined;
      const key = preparedMarkdownRootKey(root);
      const configured = agentEndpointAssetState.roots.get(key);
      if (!configured) {
        throw new Error(
          "nimbus-docs: prepared headings are available only during a configured Astro build or dev server.",
        );
      }
      const lazyHeading = configured.lazyHeading;
      if (lazyHeading) {
        // Dev: one module per page, so startup doesn't render every page.
        const base = JSON.stringify(configured.headingsBase ?? "/");
        const header = `export const generation = ${PREPARED_HEADINGS_GENERATION};\nexport const base = ${base};\n`;
        if (!isEntry) {
          return (
            header +
            "export const records = [];\n" +
            "export function load(collection, id) {\n" +
            "  const bytes = new TextEncoder().encode(JSON.stringify([collection, id]));\n" +
            '  const key = btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/[+]/g, "-").replace(/[/]/g, "_");\n' +
            // The module runner resolves a computed specifier only as a URL, so
            // address the virtual module by its served path.
            `  return import(/* @vite-ignore */ ${JSON.stringify(`/@id/__x00__${HEADINGS_ENTRY_PREFIX}`)} + key);\n` +
            "}\n"
          );
        }
        entryModules.add(id);
        const [collection, entryId] = JSON.parse(
          Buffer.from(
            id.slice(`\0${HEADINGS_ENTRY_PREFIX}`.length),
            "base64url",
          ).toString("utf8"),
        ) as [string, string];
        const record = await lazyHeading(collection, entryId);
        return header + `export const records = ${JSON.stringify(record ? [record] : [])};\n`;
      }
      if (isEntry) return undefined;
      const records = configured.bakeHeadings
        ? await configured.bakeHeadings()
        : (await ensureAgentEndpointAssets(root)).headings;
      return (
        `export const generation = ${PREPARED_HEADINGS_GENERATION};\n` +
        `export const base = ${JSON.stringify(configured.headingsBase ?? records[0]?.base ?? "/")};\n` +
        `export const records = ${JSON.stringify(records)};\n`
      );
    },
    handleHotUpdate(context) {
      // Every environment that loaded an entry, then forget them once.
      invalidateDevModules(context.server, [HEADINGS_RESOLVED_ID, ...entryModules]);
      entryModules.clear();
    },
  };
}

export function agentEndpointAssetsRuntimePlugin(
  root: URL | string,
  serverBuild: () => boolean = () => false,
): PreparedHeadingsPlugin {
  return {
    name: "nimbus-docs:agent-endpoint-assets-runtime",
    resolveId(id) {
      return id === ARTIFACTS_VIRTUAL_ID ? ARTIFACTS_RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== ARTIFACTS_RESOLVED_ID) return undefined;
      const server = this.environment?.name === "ssr";
      if (server) registerAgentEndpointAssetDemand(root);
      const manifest = await ensureAgentEndpointAssets(root);
      const literal = server && serverBuild() ? null : stagedManifest(manifest);
      return `export const manifest = ${JSON.stringify(literal)};\n`;
    },
    handleHotUpdate(context) {
      invalidateDevModules(context.server, [ARTIFACTS_RESOLVED_ID]);
    },
  };
}

interface HotUpdateGraph {
  idToModuleMap: Map<string, unknown>;
}

export interface AgentEndpointHotUpdatePlugin {
  name: string;
  enforce: "pre";
  hotUpdate(
    this: { environment: { moduleGraph: HotUpdateGraph } },
    context: { file: string; modules: unknown[] },
  ): unknown[] | undefined;
}

/**
 * A content edit can reach Vite as an update that touches no module, and
 * Astro then leaves middleware and the modules it imports on the previous
 * snapshot of prepared Markdown, headings and the asset manifest. Hand Vite
 * those modules for such an update so it refreshes them and Astro reloads
 * middleware. Only then: an update carrying server-only modules makes Astro
 * reload the browser instead of hot-updating it.
 */
export function agentEndpointHotUpdatePlugin(root: string): AgentEndpointHotUpdatePlugin {
  return {
    name: "nimbus-docs:agent-endpoint-hot-update",
    enforce: "pre",
    hotUpdate(context) {
      if (context.modules.length > 0 || !isDevContentFile(root, context.file)) return undefined;
      const affected = [...this.environment.moduleGraph.idToModuleMap]
        .filter(
          ([id]) =>
            id === ARTIFACTS_RESOLVED_ID ||
            id === HEADINGS_RESOLVED_ID ||
            id.startsWith(`\0${HEADINGS_ENTRY_PREFIX}`),
        )
        .map(([, module]) => module);
      return affected.length ? affected : undefined;
    },
  };
}

export function agentEndpointAssetLoaderPlugin(
  adapterName: () => string | null,
): PreparedHeadingsPlugin {
  return {
    name: "nimbus-docs:agent-endpoint-asset-loader",
    enforce: "pre",
    resolveId(id) {
      return id === ASSET_LOADER_VIRTUAL_ID
        ? ASSET_LOADER_RESOLVED_ID
        : undefined;
    },
    load(id) {
      if (id !== ASSET_LOADER_RESOLVED_ID) return undefined;
      if (
        adapterName() === "@astrojs/cloudflare" &&
        this.environment?.name === "ssr"
      ) {
        return (
          'import { env } from "cloudflare:workers";\n' +
          "export function fetchAgentEndpointAsset(path, request) {\n" +
          "  // The conditional headers go along, so the assets binding answers 304 itself.\n" +
          "  const headers = new Headers();\n" +
          '  for (const name of ["If-None-Match", "If-Modified-Since"]) {\n' +
          "    const value = request.headers.get(name);\n" +
          "    if (value) headers.set(name, value);\n" +
          "  }\n" +
          "  return env.ASSETS?.fetch(new Request(new URL(path, request.url), { method: request.method, headers })) ?? null;\n" +
          "}\n"
        );
      }
      return "export function fetchAgentEndpointAsset() { return null; }\n";
    },
    handleHotUpdate() {},
  };
}

export async function removeAgentEndpointAssets(
  outputRoot: string,
): Promise<void> {
  for (const directory of ["agent-endpoint-assets", "prepared-artifacts"]) {
    const targetRoot = path.join(outputRoot, "_nimbus", directory);
    await assertNoSymlink(outputRoot, targetRoot);
    await rm(targetRoot, { recursive: true, force: true });
  }
}

export async function stageAgentEndpointAssets(
  root: URL | string,
  outputRoot: string,
  limitBytes = LLMS_FULL_LIMIT_BYTES,
): Promise<void> {
  const projectRoot = preparedMarkdownRootKey(root);
  const baked = await ensureAgentEndpointAssets(projectRoot);
  // A body no route publishes ships only when the MCP server reads it; a body
  // kept for the build's own consumers stays in the build cache.
  const manifest: AgentEndpointAssetManifest = {
    ...baked,
    // Unpublished bodies travel when something reads them by path: the MCP
    // server, or an llms-full part assembled on request.
    markdownAssets: baked.markdownAssets.filter(
      (asset) => asset.published !== false || baked.pageIndex || baked.onRequest.llmsFull,
    ),
  };
  // Every agent endpoint reads this one file, so a server build cannot ship without it.
  const manifestBody = JSON.stringify(stagedManifest(manifest));
  const manifestBytes = utf8Length(manifestBody);
  if (manifestBytes > limitBytes) {
    throw new Error(
      `nimbus-docs: _nimbus/agent-endpoint-assets/manifest.json is ${mebibytes(manifestBytes)}, over Cloudflare's 25 MiB static file limit, so the deploy would fail. ` +
        "It holds one entry per Markdown twin and llms file, so fewer pages shrink it; a site this large needs splitting.",
    );
  }
  const sourceRoot = agentEndpointAssetRoot(projectRoot);
  const targetRoot = path.join(outputRoot, "_nimbus", "agent-endpoint-assets");
  const assets = manifestAssets(manifest);
  const copies = assets.map((asset) => ({
    source: resolveContainedAssetPath(sourceRoot, asset.path),
    target: resolveContainedAssetPath(targetRoot, asset.path),
  }));
  await removeAgentEndpointAssets(outputRoot);
  // The roots and each directory are checked once; a file then costs one
  // lstat (a symlinked source must not be followed) and one clone.
  await assertNoSymlink(projectRoot, sourceRoot);
  const directories = new Map<string, string>();
  for (const { source, target } of copies) {
    directories.set(path.dirname(target), path.dirname(source));
  }
  for (const [target, source] of directories) {
    await assertNoSymlink(sourceRoot, source);
    await mkdir(target, { recursive: true });
    await assertNoSymlink(targetRoot, target);
  }
  for (let index = 0; index < copies.length; index += 64) {
    await Promise.all(
      copies.slice(index, index + 64).map(async ({ source, target }) => {
        if ((await lstat(source)).isSymbolicLink()) {
          throw new Error(
            `nimbus-docs: agent-endpoint asset path contains a symbolic link: ${source}.`,
          );
        }
        await copyFile(source, target, constants.COPYFILE_FICLONE);
      }),
    );
  }
  // A site whose routes serve no agent file still ships the manifest, so the
  // server knows there is nothing to serve.
  await mkdir(targetRoot, { recursive: true });
  await writeFile(path.join(targetRoot, "manifest.json"), manifestBody, "utf8");
}

export function configureAgentEndpointAssetRoot(
  root: URL | string,
  mode: "build" | "dev",
  bake: () => Promise<AgentEndpointAssetManifest>,
  bakeHeadings?: () => Promise<PreparedHeadingRecord[]>,
  headingsBase?: string,
  lazyHeading?: (
    collection: string,
    id: string,
  ) => Promise<PreparedHeadingRecord | null>,
): void {
  const key = preparedMarkdownRootKey(root);
  agentEndpointAssetState.demands.delete(key);
  agentEndpointAssetState.roots.set(key, {
    mode,
    bake,
    bakeHeadings,
    headingsBase,
    lazyHeading,
    invalidation: 0,
  });
}

async function preparedHeadingRecord(
  entry: PreparedMarkdownEntry,
  base: string,
  partials: PreparedMarkdownCollection | undefined,
  partialResolver: GeneratedMarkdownPartialResolver | undefined,
): Promise<PreparedHeadingRecord | null> {
  if (typeof entry.body !== "string" || !entry.headings) return null;
  const headings = /\.md$/iu.test(entry.filePath ?? "")
    ? entry.headings
    : await mergePartialHeadings(
        entry.body,
        entry.headings,
        async (collection, id) =>
          collection === "partials" ? partials?.entries.get(id) : undefined,
        async (partial) => {
          const prepared = partial as PreparedMarkdownEntry;
          if (!prepared.headings) throw new Error("missing prepared headings");
          return { headings: prepared.headings };
        },
        partialResolver
          ? {
              resolvePartialId: ({ file, product }) =>
                file ? partialResolver.resolve({ file, product }) : undefined,
            }
          : undefined,
      );
  return {
    collection: entry.collection,
    id: entry.id,
    generation: PREPARED_HEADINGS_GENERATION,
    base,
    headings,
  };
}

export async function bakePreparedHeadings(
  options: BakePreparedHeadingsOptions,
): Promise<PreparedHeadingRecord[]> {
  const root = preparedMarkdownRootKey(options.root);
  while (true) {
    await waitForPreparedMarkdownTransactions(root);
    const snapshot = getPreparedMarkdownSnapshot(root);
    if (!snapshot) {
      throw new Error(
        "nimbus-docs: prepared Markdown registry is unavailable.",
      );
    }
    const partials = snapshot.collections.get("partials");
    const records: PreparedHeadingRecord[] = [];
    for (const collection of snapshot.collections.values()) {
      if (collection.role !== "page") continue;
      for (const entry of collection.entries.values()) {
        const record = await preparedHeadingRecord(
          entry,
          options.base || "/",
          partials,
          options.partialResolver,
        );
        if (record) records.push(record);
      }
    }
    await waitForPreparedMarkdownTransactions(root);
    if (getPreparedMarkdownRevision(root) !== snapshot.revision) continue;
    records.sort(
      (a, b) => compare(a.collection, b.collection) || compare(a.id, b.id),
    );
    return records;
  }
}

export function registerAgentEndpointAssetDemand(root: URL | string): void {
  agentEndpointAssetState.demands.add(preparedMarkdownRootKey(root));
}

export function isAgentEndpointAssetRequested(root: URL | string): boolean {
  return agentEndpointAssetState.demands.has(preparedMarkdownRootKey(root));
}

export async function ensureAgentEndpointAssets(
  root: URL | string,
): Promise<AgentEndpointAssetManifest> {
  const key = preparedMarkdownRootKey(root);
  const configured = agentEndpointAssetState.roots.get(key);
  if (!configured) {
    throw new Error(
      "nimbus-docs: agent-endpoint assets are available only during a configured Astro build or dev server.",
    );
  }
  while (true) {
    const revision = getPreparedMarkdownRevision(key);
    if (revision === undefined) {
      throw new Error(
        "nimbus-docs: prepared Markdown registry is unavailable.",
      );
    }
    if (
      configured.bakedRevision === revision &&
      configured.bakedInvalidation === configured.invalidation &&
      configured.manifest
    ) {
      return configured.manifest;
    }
    if (configured.inFlight) {
      await configured.inFlight;
      continue;
    }
    const invalidation = configured.invalidation;
    const operation = configured.bake();
    configured.inFlight = operation;
    try {
      const manifest = await operation;
      if (
        getPreparedMarkdownRevision(key) === revision &&
        configured.invalidation === invalidation
      ) {
        configured.bakedRevision = revision;
        configured.bakedInvalidation = invalidation;
        configured.manifest = manifest;
        configured.markdownAssets = new Map(
          manifest.markdownAssets.map(
            (
              asset: MarkdownEndpointAsset,
            ): [string, MarkdownEndpointAsset] => [
              markdownAssetKey(asset),
              asset,
            ],
          ),
        );
        configured.llmsAssets = new Map(
          manifest.llmsAssets.map(
            (
              asset: LlmsEndpointAsset,
            ): [string, LlmsEndpointAsset] => [
              preparedLlmsKey(asset),
              asset,
            ],
          ),
        );
        configured.headings = new Map(
          manifest.headings.map(
            (
              record: PreparedHeadingRecord,
            ): [string, PreparedHeadingRecord] => [
              headingKey(record.collection, record.id),
              record,
            ],
          ),
        );
      }
    } finally {
      if (configured.inFlight === operation) configured.inFlight = undefined;
    }
  }
}

export function invalidateAgentEndpointAssets(root: URL | string): void {
  const configured = agentEndpointAssetState.roots.get(preparedMarkdownRootKey(root));
  if (configured) configured.invalidation += 1;
}

function withoutBody<T>({ body: _body, ...record }: T & { body: string }): T {
  return record as T;
}

export async function bakeAgentEndpointAssets(
  options: BakeAgentEndpointAssetsOptions,
): Promise<AgentEndpointAssetManifest> {
  const root = preparedMarkdownRootKey(options.root);
  const configuredAtStart = agentEndpointAssetState.roots.get(root);
  const previousManifest = configuredAtStart?.manifest;
  const invalidationAtStart = configuredAtStart?.invalidation;
  let snapshot: NonNullable<ReturnType<typeof getPreparedMarkdownSnapshot>>;
  let apiEntries: LlmsEndpointApiEntry[];
  while (true) {
    await waitForPreparedMarkdownTransactions(root);
    const candidateSnapshot = getPreparedMarkdownSnapshot(root);
    if (!candidateSnapshot) {
      throw new Error(
        "nimbus-docs: prepared Markdown registry is unavailable.",
      );
    }
    apiEntries = [
      ...(options.loadApiEntries
        ? await options.loadApiEntries()
        : (options.apiEntries ?? [])),
    ];
    await waitForPreparedMarkdownTransactions(root);
    if (getPreparedMarkdownRevision(root) === candidateSnapshot.revision) {
      snapshot = candidateSnapshot;
      break;
    }
  }
  const base = options.base || "/";
  // Page collections come from the same registry snapshot this bake reads:
  // the collections Nimbus's helpers committed with role `page`, in the
  // deterministic order the list is published everywhere (API entries arrive
  // separately through `loadApiEntries`/`apiEntries`).
  const candidates: PreparedMarkdownEntry[] = [];
  for (const collectionName of orderPageCollections(snapshot, {
    versionsOthers: options.versions?.others,
  })) {
    const collection = snapshot.collections.get(collectionName);
    if (!collection) continue;
    assertPreparedCollection(collectionName, collection, base, mountContext(options));
    candidates.push(...collection.entries.values());
  }
  // The build checks this after content sync; dev reaches here first when a
  // page is added under a collection's URL while the server runs.
  const ownership = collectionOwnershipErrors(
    candidates.map((entry) => ({
      collection: entry.collection,
      url: entryRouteUrl(collectionMountPrefix(entry.collection, mountContext(options)), entry.id),
      source: entry.filePath ?? `${entry.collection}:${entry.id}`,
    })),
    [...new Set(candidates.map((entry) => entry.collection))],
    mountContext(options),
  );
  if (ownership.length > 0)
    throw new Error(`nimbus-docs: ${ownership.map((error) => error.message).join("\n\n")}\n\nSee ${COLLECTION_URLS_DOCS}.`);

  const decide = options.decidePublic ?? defaultDecision;
  const decisions = new Map<string, AgentEndpointVisibilityDecision>();
  const hiddenVersions = new Set(options.versions?.hidden ?? []);
  const decideEntry = (entry: PreparedMarkdownEntry) => {
    const version = entry.collection.startsWith("docs-")
      ? collectionLabel(entry.collection, options.versions)
      : undefined;
    const decision =
      version && hiddenVersions.has(version)
        ? ({ status: "exclude", reason: "hidden version" } as const)
        : decide(entry);
    decisions.set(`${entry.collection}\0${entry.id}`, decision);
    if (decision.status === "unknown") {
      throw new Error(
        `nimbus-docs: public Markdown visibility is unknown for "${entry.collection}:${entry.id}": ${decision.reason}.`,
      );
    }
  };
  for (const entry of candidates) {
    decideEntry(entry);
  }
  for (const entry of apiEntries) {
    if (entry.hidden) {
      decisions.set(`${entry.collection}\0${entry.id}`, {
        status: "exclude",
        reason: "hidden API version",
      });
    } else {
      decideEntry(entry);
    }
  }

  const partials = snapshot.collections.get("partials");
  let partialsPrepared = false;
  const getPartial = (id: string): PreparedMarkdownEntry => {
    if (!partials) {
      throw new Error(`nimbus-docs: missing prepared partial "${id}".`);
    }
    if (!partialsPrepared) {
      assertPreparedCollection("partials", partials, base, mountContext(options));
      partialsPrepared = true;
    }
    const partial = partials.entries.get(id);
    if (!partial)
      throw new Error(`nimbus-docs: missing prepared partial "${id}".`);
    const decision = decide(partial);
    if (decision.status !== "include") {
      throw new Error(
        `nimbus-docs: public Markdown depends on ${decision.status} partial "partials:${id}"${
          "reason" in decision ? `: ${decision.reason}` : ""
        }.`,
      );
    }
    return partial;
  };

  const records: Array<MarkdownEndpointAsset & { body: string }> = [];

  const renderedPages: RenderedMarkdownPage[] = [];
  const headingRecords: PreparedHeadingRecord[] = [];
  const preparedLlmsPages: PreparedLlmsPage[] = [];
  const llmsRoutePages: PreparedLlmsPage[] = [];
  const indexPages: McpPageRecord[] = [];
  const componentRevisions = componentFingerprint(options.componentMap);
  const partialResolverRevision = options.partialResolver?.revision ?? "";
  const citationFingerprint = digest(
    JSON.stringify(
      [...(options.citationIndex ?? [])].sort(([a], [b]) => compare(a, b)),
    ),
  );
  const renderers = Object.fromEntries(
    Object.entries(options.componentMap ?? {}).map(([name, value]) => [
      name,
      value.render,
    ]),
  );
  const basedCitationIndex = options.citationIndex
    ? new Map(
        [...options.citationIndex].map(([coordinate, url]) => [
          coordinate,
          withAssetBase(base, url),
        ]),
      )
    : undefined;
  for (const entry of candidates) {
    const decision = decisions.get(`${entry.collection}\0${entry.id}`)!;
    if (decision.status === "exclude") continue;
    if (typeof entry.body !== "string") {
      throw new Error(
        `nimbus-docs: prepared entry "${entry.collection}:${entry.id}" has no body.`,
      );
    }
    const expanded = await expandPreparedPartials(entry.body, {
      sourceId: `${entry.collection}:${entry.filePath ?? entry.id}`,
      getPartial,
      resolvePartialId: options.partialResolver?.resolve,
    });
    const markdown = absoluteMarkdownLinks(
      renderEntryAsMarkdown(
        { body: expanded, filePath: entry.filePath },
        {
          citationIndex: basedCitationIndex,
          componentMap: renderers,
          base,
        },
      ),
      options.site,
    );
    const page = preparedLlmsPage(entry, markdown, options);
    llmsRoutePages.push(page);
    if (options.mcpUrl) indexPages.push(mcpPageRecord(entry, page, options));
    if (isDiscoverable(entry)) preparedLlmsPages.push(page);
    if (entry.headings) {
      const headings = /\.md$/iu.test(entry.filePath ?? "")
        ? entry.headings
        : await mergePartialHeadings(
            entry.body,
            entry.headings,
            async (collection, id) =>
              collection === "partials" ? getPartial(id) : undefined,
            async (partial) => {
              const prepared = partial as PreparedMarkdownEntry;
              if (!prepared.headings) {
                throw new Error(
                  `nimbus-docs: prepared partial "${prepared.id}" is missing headings.`,
                );
              }
              return {
                headings: prepared.headings,
              };
            },
            options.partialResolver
              ? {
                  resolvePartialId: ({ file, product }) =>
                    file
                      ? options.partialResolver!.resolve({ file, product })
                      : undefined,
                }
              : undefined,
          );
      headingRecords.push({
        collection: entry.collection,
        id: entry.id,
        generation: PREPARED_HEADINGS_GENERATION,
        base,
        headings,
      });
    }
    const urls = preparedMarkdownUrls(entry, options);
    const fields = snapshot.collections.get(entry.collection)?.markdownFields ?? [];
    for (const surface of ["markdown", "source"] as const) {
      // No route, no file: except the `.md` body the MCP server reads by path.
      const published = publishes(options, urls[surface]);
      // No route, no file: except the `.md` body the MCP server reads by
      // path, or that an llms-full part assembled on request reads.
      if (
        !published &&
        !(surface === "markdown" && (options.mcpUrl || options.buildBodies || (servesLlmsFull(options) && onRequest(options).llmsFull)))
      )
        continue;
      const asset =
        surface === "markdown"
          ? markdownAsset(entry, markdown, options, fields)
          : sourceAsset(entry, expanded, options, fields);
      const { body, contentStart, contentEnd } = asset;
      const fingerprint = digest(
        JSON.stringify({
          generation: AGENT_ENDPOINT_ASSET_GENERATION,
          base,
          audience: "public",
          collection: entry.collection,
          id: entry.id,
          surface,
          body: digest(body),
          components: componentRevisions,
          partialResolver: partialResolverRevision,
          citations: citationFingerprint,
        }),
      );
      const extension = surface === "markdown" ? "md" : "mdx";
      records.push({
        collection: entry.collection,
        id: entry.id,
        surface,
        url: urls[surface],
        digest: `sha256:${fingerprint}`,
    hash: digest(body),
        mediaType:
          surface === "markdown"
            ? "text/markdown; charset=utf-8"
            : "text/mdx; charset=utf-8",
        path: `assets/${fingerprint}.${extension}`,
        contentStart,
        contentEnd,
        ...(published ? {} : { published: false as const }),
        body,
      });
    }
  }
  for (const entry of apiEntries) {
    const decision = decisions.get(`${entry.collection}\0${entry.id}`)!;
    if (decision.status === "exclude") continue;
    const routePage = preparedLlmsPage(entry, null, options);
    // A historical page is listed by no index and no MCP record.
    if (!entry.historical) {
      llmsRoutePages.push(routePage);
      if (options.mcpUrl) indexPages.push(mcpPageRecord(entry, routePage, options));
    }
    const coordinate = entry.data.coordinate;
    if (typeof coordinate !== "string") {
      throw new Error(
        `nimbus-docs: API entry "${entry.id}" in collection "${entry.collection}" is missing its coordinate — the apiCollection() loader should have set it.`,
      );
    }
    const url = preparedMarkdownUrls(entry, options).markdown;
    const published = !entry.historical && publishes(options, url);
    const rendered = options.requestRendered?.(entry.collection) === true;
    // An on-request full document reads every page's body, the historical ones included.
    const partsReadBodies = servesLlmsFull(options) && onRequest(options).llmsFull;
    const meta = {
      collection: entry.collection,
      id: entry.id,
      title: oneLineTitle(entry),
      ...(typeof entry.data.version === "string" ? { version: entry.data.version } : {}),
      ...(typeof entry.data.socialImage === "string" && entry.data.socialImage.length > 0
        ? { image: entry.data.socialImage }
        : {}),
      url: routePage.url,
    };
    if (rendered) {
      // The Worker renders this page's Markdown from the record it already
      // holds; the build only describes it. Its body is made here only when a
      // build-time document needs it.
      renderedPages.push({
        collection: entry.collection,
        id: entry.id,
        version: typeof entry.data.version === "string" ? entry.data.version : null,
        coordinate,
        title: meta.title,
        ...(meta.image ? { image: meta.image } : {}),
        url: routePage.url,
        published,
        ...(entry.historical ? { historical: true as const } : {}),
        // What the record holds, without rendering it: the prepared page, or
        // the page pack's content-addressed file.
        fingerprint: digest(
          typeof entry.data.fingerprint === "string"
            ? entry.data.fingerprint
            : JSON.stringify(isPreparedApiPage(entry.data.prepared) ? entry.data.prepared.page : entry.data),
        ).slice(0, 16),
      });
      // The indexes list the page without its body; only the full document
      // needs the body made here.
      if (!(servesLlmsFull(options) && !onRequest(options).llmsFull && isDiscoverable(entry)) || entry.historical) {
        if (isDiscoverable(entry)) preparedLlmsPages.push(preparedLlmsPage(entry, null, options, true, markdownBytesEstimate(entry)));
        continue;
      }
    }
    // A historical page in a build-rendered collection: its body is baked
    // (unpublished) only for parts made on request; it is in no baked document.
    if (entry.historical && !partsReadBodies) {
      if (isDiscoverable(entry)) preparedLlmsPages.push(preparedLlmsPage(entry, null, options, true));
      continue;
    }
    const prepared = entry.data.prepared;
    let page: import("./api/api-view-types.js").ApiPageProps;
    if (isPreparedApiPage(prepared)) {
      page = prepared.page;
    } else if (options.projectApiEntryPage) {
      page = await options.projectApiEntryPage(entry);
    } else {
      throw new Error(
        `nimbus-docs: API entry "${entry.id}" in collection "${entry.collection}" is missing its prepared page data — rebuild the apiCollection() index.`,
      );
    }
    const document = renderApiMarkdownDocument(page, meta, {
      site: options.site,
      base,
      ...(options.socialImage ? { socialImage: options.socialImage } : {}),
      publishes: (candidate) => publishes(options, candidate),
    });
    const markdown = document.content;
    if (isDiscoverable(entry)) {
      preparedLlmsPages.push(preparedLlmsPage(entry, markdown, options, true));
    }
    if (rendered) continue;
    if (!published && !options.mcpUrl && !options.buildBodies && !partsReadBodies) continue;
    const { body, contentStart, contentEnd } = document;
    const fingerprint = digest(
      JSON.stringify({
        generation: AGENT_ENDPOINT_ASSET_GENERATION,
        base,
        audience: "public",
        collection: entry.collection,
        id: entry.id,
        surface: "markdown",
        body: digest(body),
        citations: citationFingerprint,
      }),
    );
    records.push({
      collection: entry.collection,
      id: entry.id,
      surface: "markdown",
      url,
      digest: `sha256:${fingerprint}`,
    hash: digest(body),
      mediaType: "text/markdown; charset=utf-8",
      path: `assets/${fingerprint}.md`,
      contentStart,
      contentEnd,
      ...(published ? {} : { published: false as const }),
      body,
    });
  }
  records.sort(
    (a, b) =>
      compare(a.collection, b.collection) ||
      compare(a.id, b.id) ||
      compare(a.surface, b.surface),
  );
  const identities = new Set<string>();
  const hashes = new Set<string>();
  for (const record of records) {
    const identity = `${record.collection}\0${record.id}\0${record.surface}`;
    if (identities.has(identity))
      throw new Error(`nimbus-docs: duplicate Markdown identity ${identity}.`);
    if (hashes.has(record.digest))
      throw new Error(`nimbus-docs: duplicate Markdown digest ${record.digest}.`);
    identities.add(identity);
    hashes.add(record.digest);
  }

  if (options.sidebarPosition) {
    const pages = new Set([...preparedLlmsPages, ...llmsRoutePages]);
    const position = await options.sidebarPosition([...pages]);
    for (const page of pages) {
      const value = position(page);
      if (value !== undefined) page.position = value;
    }
    // A section another slice builds sits where the sidebar links it.
    const { section } = position;
    if (section && options.absentSections) {
      options = {
        ...options,
        absentSections: options.absentSections.map((absent) => {
          const value = section(`/${absent.slug}`);
          return value === undefined ? absent : { ...absent, position: value };
        }),
      };
    }
  }
  const ctx = documentContext(options);
  // The indexes and the baked full document list the pages the indexes know;
  // historical pages travel in the page list for the parts made on request.
  const listedPages = preparedLlmsPages.filter((page) => !page.historical);
  const { leaves, groups } = groupLlmsPages(listedPages, ctx);
  assertLlmsRouteSafety(llmsRoutePages, groups);
  const versionSlugs = new Set(options.versions?.others ?? []);
  const llmsFullPages = listedPages.filter(
    (page) =>
      page.collection === PRIMARY_COLLECTION ||
      !versionSlugs.has(collectionLabel(page.collection, options.versions)),
  );
  const rendersOnRequest = onRequest(options);
  // Without a route, the file would only be shipped, never served (a route at
  // another path still reads the baked payload); a route that renders on
  // request makes the document from the page list when asked.
  const full = !bakesLlmsFull(options) || rendersOnRequest.llmsFull
    ? { bodies: [], split: rendersOnRequest.llmsFull }
    : llmsFullBodies(llmsFullPages, ctx, (page) => page.markdown, {
        ...(options.llmsFullLimitBytes !== undefined ? { limit: options.llmsFullLimitBytes } : {}),
        ...(options.sectionDocuments ? { sectionDocuments: options.sectionDocuments } : {}),
        ...(options.info ? { info: options.info } : {}),
      });
  const nestedLinks = nestedCollectionLinks(groups, ctx);
  const llmsBodies: Array<{
    reference: LlmsEndpointReference;
    body: string;
  }> = [
    // Each index exists only where a route serves it.
    ...(servesLlms(options) && !rendersOnRequest.llms
      ? [
          {
            reference: { scope: "site", surface: "index" } as LlmsEndpointReference,
            body: siteIndexDocument(leaves, groups, ctx, full.split),
          },
        ]
      : []),
    ...full.bodies,
    ...(rendersOnRequest.llmsSections ? [] : flattenLlmsGroups(groups).filter((group) => servesSectionIndex(group, ctx))).map((group) => ({
      reference: {
        scope: "section" as const,
        surface: "index" as const,
        section: group.slug,
      },
      body: sectionIndexDocument(group, ctx, nestedLinks.get(group.slug)),
    })),
  ];
  // Every agent file is one static file on most hosts; one over the limit
  // fails a Cloudflare deploy. A UTF-8 byte is at most three UTF-16 units,
  // so most bodies are cleared without encoding them.
  const limit = options.llmsFullLimitBytes ?? LLMS_FULL_LIMIT_BYTES;
  for (const [url, body] of [
    ...records.map((record) => [record.url, record.body] as const),
    ...llmsBodies.map(({ reference, body }) => [llmsAssetUrl(reference), body] as const),
  ]) {
    if (body.length * 3 <= limit) continue;
    const bytes = utf8Length(body);
    if (bytes > limit) {
      options.warn?.(
        `${url} is ${mebibytes(bytes)}, over Cloudflare's 25 MiB file limit, so the deploy will fail.`,
      );
    }
  }
  const llmsRecords: Array<LlmsEndpointAsset & { body: string }> =
    llmsBodies.map(({ reference, body }) => {
      const fingerprint = digest(
        JSON.stringify({
          generation: AGENT_ENDPOINT_ASSET_GENERATION,
          base,
          audience: "public",
          reference,
          body: digest(body),
          components: componentRevisions,
          partialResolver: partialResolverRevision,
          citations: citationFingerprint,
        }),
      );
      return {
        ...reference,
        digest: `sha256:${fingerprint}`,
    hash: digest(body),
        mediaType: "text/plain; charset=utf-8",
        path: `assets/${fingerprint}.txt`,
        body,
      };
    });
  llmsRecords.sort((a, b) => compare(preparedLlmsKey(a), preparedLlmsKey(b)));
  const pageIndexRecord = options.mcpUrl ? mcpPageIndexAsset(indexPages, base, options) : undefined;
  if (options.surfaces) {
    const { describeAgentSurfaces, agentRouteFiles, isSectionLlmsPattern } = await import("./agent-surfaces.js");
    const routes = options.surfaces.markdownRoutes;
    options.info?.(
      `Agent surfaces follow the site's routes: ${describeAgentSurfaces({
        pageMarkdown: routes.some((route) => route.pattern.endsWith(".md")),
        source: routes.some((route) => route.pattern.endsWith(".mdx")),
        llms: servesLlms(options),
        llmsSections: servesLlmsSections(options),
        llmsFull: servesLlmsFull(options),
        mcpBodies: !!options.mcpUrl,
        onRequest: rendersOnRequest,
        renderedPages: renderedPages.length,
        files: {
          pageMarkdown: agentRouteFiles(routes, (route) => route.pattern.endsWith(".md")),
          source: agentRouteFiles(routes, (route) => route.pattern.endsWith(".mdx")),
          llms: agentRouteFiles(routes, (route) => route.pattern === "/llms.txt"),
          llmsSections: agentRouteFiles(routes, (route) => isSectionLlmsPattern(route.pattern)),
          llmsFull: agentRouteFiles(routes, (route) => route.pattern === "/llms-full.txt"),
        },
      }).join("; ")}.`,
    );
  }
  headingRecords.sort(
    (a, b) => compare(a.collection, b.collection) || compare(a.id, b.id),
  );
  for (let index = 1; index < headingRecords.length; index += 1) {
    const previous = headingRecords[index - 1]!;
    const current = headingRecords[index]!;
    if (
      previous.collection === current.collection &&
      previous.id === current.id
    ) {
      throw new Error(
        `nimbus-docs: duplicate heading identity "${current.collection}:${current.id}".`,
      );
    }
  }
  const llmsIdentities = new Set<string>();
  for (const record of llmsRecords) {
    const identity = preparedLlmsKey(record);
    if (llmsIdentities.has(identity)) {
      throw new Error(`nimbus-docs: duplicate llms.txt identity ${identity}.`);
    }
    if (hashes.has(record.digest)) {
      throw new Error(
        `nimbus-docs: duplicate asset digest ${record.digest}.`,
      );
    }
    llmsIdentities.add(identity);
    hashes.add(record.digest);
  }

  const directory = agentEndpointAssetRoot(root);
  await assertNoSymlink(root, directory);
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await assertNoSymlink(root, path.join(directory, "assets"));
  const manifest: AgentEndpointAssetManifest = {
    version: AGENT_ENDPOINT_ASSET_MANIFEST_VERSION,
    generation: AGENT_ENDPOINT_ASSET_GENERATION,
    base,
    audience: "public",
    markdownAssets: records.map(withoutBody),
    rendered: renderedPages,
    llmsAssets: llmsRecords.map(withoutBody),
    onRequest: rendersOnRequest,
    fullSplit: full.split,
    ...(rendersOnRequest.llmsFull && options.llmsFullLimitBytes !== undefined ? { fullLimitBytes: options.llmsFullLimitBytes } : {}),
    ...(rendersOnRequest.llms || rendersOnRequest.llmsSections || rendersOnRequest.llmsFull
      ? { pages: preparedLlmsPages.map(({ markdown: _markdown, ...page }) => page) }
      : {}),
    ...(rendersOnRequest.llmsFull
      ? {
          renderedParts: flattenLlmsGroups(
            groupLlmsPages(preparedLlmsPages.filter((page) => page.collection === PRIMARY_COLLECTION || !versionSlugs.has(collectionLabel(page.collection, options.versions))), { ...ctx, nestedSections: true }, true).groups,
          ).map((group) => group.slug),
        }
      : {}),
    ...(options.absentSections ? { absentSections: [...options.absentSections] } : {}),
    // Every input a document made on request reads: the baked bodies, the
    // described records, the page list and the context the documents are
    // written for. A change to any of them is a new build id.
    buildId: digest(
      JSON.stringify([
        AGENT_ENDPOINT_ASSET_GENERATION,
        options.site,
        base,
        options.title,
        options.description ?? "",
        options.nestedSections === true,
        options.mcpUrl ?? "",
        options.surfaces?.markdownRoutes.map((route) => route.pattern) ?? [],
        rendersOnRequest,
        servesLlms(options),
        servesLlmsFull(options),
        full.split,
        options.absentSections ?? [],
        options.apiVersions ?? {},
        ...records.map((record) => record.digest),
        ...llmsRecords.map((record) => record.digest),
        ...renderedPages.map((page) => `${page.collection}\0${page.id}\0${page.url}\0${page.published}\0${page.fingerprint}`),
        // Every body-free field of every listed page: a group label or a
        // section is a document input too.
        ...preparedLlmsPages.map(({ markdown: _markdown, ...page }) => JSON.stringify(page)),
      ]),
    ).slice(0, 16),
    ...(pageIndexRecord ? { pageIndex: withoutBody(pageIndexRecord) } : {}),
    headings: headingRecords,
  };
  const isFresh = () => {
    const current = agentEndpointAssetState.roots.get(root);
    return (
      (!configuredAtStart || current === configuredAtStart) &&
      current?.invalidation === invalidationAtStart &&
      getPreparedMarkdownRevision(root) === snapshot.revision
    );
  };
  if (
    !(await publishManifest(
      root,
      directory,
      manifest,
      previousManifest,
      isFresh,
      [...records, ...llmsRecords, ...(pageIndexRecord ? [pageIndexRecord] : [])],
      async () => {
        const configured = agentEndpointAssetState.roots.get(root);
        let installed = !configuredAtStart;
        if (
          configured &&
          configured === configuredAtStart &&
          configured.invalidation === invalidationAtStart &&
          getPreparedMarkdownRevision(root) === snapshot.revision
        ) {
          installed = true;
          configured.bakedRevision = snapshot.revision;
          configured.bakedInvalidation = configured.invalidation;
          configured.manifest = manifest;
          configured.markdownAssets = new Map(
            manifest.markdownAssets.map((asset) => [
              markdownAssetKey(asset),
              asset,
            ]),
          );
          configured.llmsAssets = new Map(
            manifest.llmsAssets.map((asset) => [preparedLlmsKey(asset), asset]),
          );
          configured.headings = new Map(
            manifest.headings.map((record): [string, PreparedHeadingRecord] => [
              headingKey(record.collection, record.id),
              record,
            ]),
          );
        }
        if (installed) {
          await cleanupAssets(root, directory, manifest);
        }
      },
    ))
  ) {
    return manifest;
  }
  return manifest;
}

export async function getAgentEndpointAssetManifest(
  root: URL | string,
): Promise<AgentEndpointAssetManifest> {
  return ensureAgentEndpointAssets(root);
}

export async function readMarkdownEndpointPayload(
  root: URL | string,
  reference: MarkdownEndpointReference,
): Promise<MarkdownEndpointPayload> {
  const key = preparedMarkdownRootKey(root);
  await ensureAgentEndpointAssets(key);
  const endRead = beginAssetRead(key);
  try {
    const configured = agentEndpointAssetState.roots.get(key);
    const record = configured?.markdownAssets?.get(markdownAssetKey(reference));
    if (!record) {
      throw new Error(
        `nimbus-docs: no ${reference.surface} agent-endpoint asset for "${reference.collection}:${reference.id}".`,
      );
    }
    const body = await readAssetBody(key, record);
    if (
      !Number.isSafeInteger(record.contentStart) ||
      !Number.isSafeInteger(record.contentEnd) ||
      record.contentStart < 0 ||
      record.contentEnd < record.contentStart ||
      record.contentEnd > body.length
    ) {
      throw new Error(
        `nimbus-docs: ${reference.surface} agent-endpoint asset for "${reference.collection}:${reference.id}" has invalid content bounds.`,
      );
    }
    return {
      ...reference,
      digest: record.digest,
      mediaType: record.mediaType,
      body,
      content: body.slice(record.contentStart, record.contentEnd),
    };
  } finally {
    endRead();
  }
}

async function readAssetBody(
  root: string,
  record: { path: string },
): Promise<string> {
  const directory = agentEndpointAssetRoot(root);
  const resolved = path.resolve(directory, record.path);
  const relative = path.relative(directory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `nimbus-docs: agent-endpoint asset path escapes its root: ${record.path}.`,
    );
  }
  await assertNoSymlink(root, resolved);
  const canonicalDirectory = await realpath(directory);
  const canonicalFile = await realpath(resolved);
  const canonicalRelative = path.relative(canonicalDirectory, canonicalFile);
  if (
    canonicalRelative.startsWith("..") ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(
      `nimbus-docs: agent-endpoint asset path escapes its root: ${record.path}.`,
    );
  }
  return readFile(resolved, "utf8");
}

export async function readLlmsEndpointPayload(
  root: URL | string,
  reference: LlmsEndpointReference,
): Promise<LlmsEndpointPayload> {
  const key = preparedMarkdownRootKey(root);
  await ensureAgentEndpointAssets(key);
  const endRead = beginAssetRead(key);
  try {
    const configured = agentEndpointAssetState.roots.get(key);
    const record = configured?.llmsAssets?.get(preparedLlmsKey(reference));
    if (!record) {
      const identity =
        reference.scope === "site"
          ? `${reference.scope} ${reference.surface}`
          : `${reference.scope} ${reference.section} ${reference.surface}`;
      throw new Error(
        `nimbus-docs: no llms.txt agent-endpoint asset for ${identity}.`,
      );
    }
    const body = await readAssetBody(key, record);
    return {
      ...reference,
      digest: record.digest,
      mediaType: record.mediaType,
      body,
    };
  } finally {
    endRead();
  }
}

registerAgentEndpointAssetReader(readMarkdownEndpointPayload, async (root, reference) =>
  (await ensureAgentEndpointAssets(root)).rendered.find(
    (page) => page.collection === reference.collection && page.id === reference.id,
  ),
);
