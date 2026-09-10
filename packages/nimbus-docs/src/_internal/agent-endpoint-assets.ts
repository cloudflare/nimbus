import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  copyFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { entryRouteUrl } from "./astro-slug.js";
import { renderApiPageMarkdown } from "./api/markdown.js";
import { isPreparedApiPage } from "./api/prepared.js";
import { expandPreparedPartials } from "./build-partials.js";
import {
  collectionLabel,
  collectionMountPrefix,
  PRIMARY_COLLECTION,
} from "./collection-mount.js";
import { buildLlmsFullMarkdown, type LlmsFullBlock } from "./llms-full.js";
import { isDiscoverable } from "./discoverability.js";
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
import {
  renderEntryAsMarkdown,
} from "./transform.js";
import { toBrowserHref, toRouteKey, withBase } from "./url.js";
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

export const AGENT_ENDPOINT_ASSET_MANIFEST_VERSION = 4;
export const AGENT_ENDPOINT_ASSET_GENERATION = 1;

export interface MarkdownEndpointAsset extends MarkdownEndpointReference {
  digest: string;
  mediaType: string;
  path: string;
  contentStart: number;
  contentEnd: number;
}

export type LlmsEndpointAsset = LlmsEndpointReference & {
  digest: string;
  mediaType: string;
  path: string;
};

export interface AgentEndpointAssetManifest {
  version: 4;
  generation: number;
  base: string;
  audience: "public";
  markdownAssets: MarkdownEndpointAsset[];
  llmsAssets: LlmsEndpointAsset[];
  headings: PreparedHeadingRecord[];
}

export type AgentEndpointVisibilityDecision =
  | { status: "include" }
  | { status: "exclude"; reason: string }
  | { status: "unknown"; reason: string };

export interface BakeAgentEndpointAssetsOptions {
  root: URL | string;
  base: string;
  site: string;
  title: string;
  description?: string;
  socialImage?: string;
  indexedCollections: readonly string[];
  apiCollections?: readonly string[];
  versions?: {
    current: string;
    others: readonly string[];
    hidden?: readonly string[];
  };
  citationIndex?: ReadonlyMap<string, string>;
  componentMap?: Record<string, GeneratedMarkdownComponentTransform>;
  partialResolver?: GeneratedMarkdownPartialResolver;
  decidePublic?: (entry: PreparedMarkdownEntry) => AgentEndpointVisibilityDecision;
  apiEntries?: readonly LlmsEndpointApiEntry[];
  loadApiEntries?: () => Promise<readonly LlmsEndpointApiEntry[]>;
}

export interface BakePreparedHeadingsOptions {
  root: URL | string;
  base: string;
  indexedCollections: readonly string[];
  partialResolver?: GeneratedMarkdownPartialResolver;
}

export interface LlmsEndpointApiEntry {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  hidden?: boolean;
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
    if ((await readFile(file, "utf8")) !== body) {
      throw new Error(
        `nimbus-docs: content-addressed agent-endpoint asset collision at ${file}.`,
      );
    }
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
  const retained = new Set(
    [...manifest.markdownAssets, ...manifest.llmsAssets].map(
      (asset) => asset.path,
    ),
  );
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
        previous
          ? [...previous.markdownAssets, ...previous.llmsAssets].map(
              (asset) => asset.path,
            )
          : [],
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

function assertPreparedCollection(
  name: string,
  collection: PreparedMarkdownCollection,
  base: string,
): void {
  const expected = preparedMarkdownCollectionCapability(
    name,
    collection.entries.values(),
    { generation: AGENT_ENDPOINT_ASSET_GENERATION, base },
  );
  if (
    collection.capability.generation !== expected.generation ||
    collection.capability.base !== expected.base ||
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

function entryVersion(
  entry: PreparedMarkdownEntry,
  versions: BakeAgentEndpointAssetsOptions["versions"],
): string | undefined {
  if (typeof entry.data.version === "string") return entry.data.version;
  if (!versions) return undefined;
  if (entry.collection === PRIMARY_COLLECTION) return versions.current;
  if (entry.collection.startsWith("docs-")) {
    const version = entry.collection.slice("docs-".length);
    if (versions.others.includes(version)) return version;
  }
  return undefined;
}

function preparedMarkdownUrls(
  entry: PreparedMarkdownEntry,
  options: BakeAgentEndpointAssetsOptions,
) {
  const route = entryRouteUrl(
    collectionMountPrefix(entry.collection, options.versions),
    entry.id,
  );
  return {
    markdown: route === "/" ? "/index.md" : `${route}/index.md`,
    source: route === "/" ? "/index.mdx" : `${route}/index.mdx`,
  };
}

function frontmatter(
  entry: PreparedMarkdownEntry,
  options: BakeAgentEndpointAssetsOptions,
): string[] {
  const title =
    typeof entry.data.title === "string" && entry.data.title.length > 0
      ? entry.data.title
      : entry.id;
  const description =
    typeof entry.data.description === "string" &&
    entry.data.description.length > 0
      ? entry.data.description
      : undefined;
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
): MarkdownEndpointPayloadBody {
  const title =
    typeof entry.data.title === "string" && entry.data.title.length > 0
      ? entry.data.title
      : entry.id;
  const urls = preparedMarkdownUrls(entry, options);
  const prefix = [
    ...frontmatter(entry, options),
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absoluteUrl(options.site, options.base, "/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    `# ${title}`,
    "",
  ].join("\n");
  const suffix = [
    "",
    `Source: ${absoluteUrl(options.site, options.base, urls.source)}`,
    "",
  ].join("\n");
  return envelopedAsset(`${prefix}\n`, markdown, `\n${suffix}`);
}

function sourceAsset(
  entry: PreparedMarkdownEntry,
  expanded: string,
  options: BakeAgentEndpointAssetsOptions,
): MarkdownEndpointPayloadBody {
  return envelopedAsset(
    `${[...frontmatter(entry, options), ""].join("\n")}\n`,
    expanded,
  );
}

interface PreparedLlmsPage {
  collection: string;
  id: string;
  title: string;
  description?: string;
  url: string;
  markdownUrl: string;
  markdown: string;
}

interface PreparedLlmsGroup {
  slug: string;
  label: string;
  kind: "primary" | "secondary" | "version";
  members: PreparedLlmsPage[];
}

function preparedLlmsPage(
  entry: Pick<PreparedMarkdownEntry, "collection" | "id" | "data">,
  markdown: string,
  options: BakeAgentEndpointAssetsOptions,
): PreparedLlmsPage {
  const route = entryRouteUrl(
    collectionMountPrefix(entry.collection, options.versions),
    entry.id,
  );
  return {
    collection: entry.collection,
    id: entry.id,
    title:
      typeof entry.data.title === "string" && entry.data.title.length > 0
        ? entry.data.title
        : entry.id,
    description:
      typeof entry.data.description === "string" &&
      entry.data.description.length > 0
        ? entry.data.description
        : undefined,
    url: toBrowserHref(route),
    markdownUrl: route === "/" ? "/index.md" : `${route}/index.md`,
    markdown,
  };
}

function groupPreparedLlmsPages(
  pages: readonly PreparedLlmsPage[],
  options: BakeAgentEndpointAssetsOptions,
): { leaves: PreparedLlmsPage[]; groups: PreparedLlmsGroup[] } {
  const primary = new Map<string, PreparedLlmsPage[]>();
  const secondary = new Map<string, PreparedLlmsPage[]>();
  const versionSlugs = new Set(options.versions?.others ?? []);
  for (const page of pages) {
    const slug =
      page.collection === PRIMARY_COLLECTION
        ? page.id.split("/")[0]!
        : collectionLabel(page.collection, options.versions);
    const buckets =
      page.collection === PRIMARY_COLLECTION ? primary : secondary;
    const bucket = buckets.get(slug);
    if (bucket) bucket.push(page);
    else buckets.set(slug, [page]);
  }

  const leaves: PreparedLlmsPage[] = [];
  const groups: PreparedLlmsGroup[] = [];
  for (const [slug, members] of primary) {
    if (members.length === 1 && members[0]!.id === slug) {
      leaves.push(members[0]!);
    } else {
      groups.push({ slug, label: slug, kind: "primary", members });
    }
  }
  for (const [slug, members] of secondary) {
    groups.push({
      slug,
      label: slug,
      kind: versionSlugs.has(slug) ? "version" : "secondary",
      members,
    });
  }
  leaves.sort((a, b) => compare(a.url, b.url));
  groups.sort((a, b) => compare(a.slug, b.slug));
  for (const group of groups) {
    group.members.sort((a, b) => compare(a.url, b.url));
  }
  return { leaves, groups };
}

function siteIndexAsset(
  leaves: readonly PreparedLlmsPage[],
  groups: readonly PreparedLlmsGroup[],
  options: BakeAgentEndpointAssetsOptions,
): string {
  const rows = [
    ...leaves.map((page) => ({
      key: page.url,
      line: `- [${page.title}](${absoluteUrl(options.site, options.base, page.markdownUrl)})${page.description ? ` — ${page.description}` : ""}`,
    })),
    ...groups
      .filter((group) => group.kind !== "version")
      .map((group) => ({
        key: `/${group.slug}`,
        line: `- [${group.label}](${absoluteUrl(options.site, options.base, `/${group.slug}/llms.txt`)})`,
      })),
  ].sort((a, b) => compare(a.key, b.key));
  return [
    `# ${options.title}`,
    "",
    options.description ?? "Documentation index for AI agents.",
    "",
    `Full documentation (discoverable current pages, one document): ${absoluteUrl(options.site, options.base, "/llms-full.txt")}`,
    "",
    "## Pages",
    "",
    ...rows.map((row) => row.line),
    "",
  ].join("\n");
}

function sectionIndexAsset(
  group: PreparedLlmsGroup,
  options: BakeAgentEndpointAssetsOptions,
): string {
  return [
    `# ${group.label}`,
    "",
    "## Pages",
    "",
    ...group.members.map(
      (page) =>
        `- [${page.title}](${absoluteUrl(options.site, options.base, page.markdownUrl)})${page.description ? ` — ${page.description}` : ""}`,
    ),
    "",
  ].join("\n");
}

function assertLlmsRouteSafety(
  pages: readonly PreparedLlmsPage[],
  groups: readonly PreparedLlmsGroup[],
): void {
  const routes = new Set(["/llms.txt", "/llms-full.txt"]);
  for (const group of groups) {
    let decoded = group.slug;
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
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      throw new Error(
        `nimbus-docs: llms.txt section slug is unsafe: ${JSON.stringify(group.slug)}.`,
      );
    }
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
  handleHotUpdate(context: {
    server: {
      moduleGraph: {
        getModuleById(id: string): unknown;
        invalidateModule(module: unknown): void;
      };
    };
  }): void;
}

const HEADINGS_VIRTUAL_ID = "virtual:nimbus/headings";
const HEADINGS_RESOLVED_ID = `\0${HEADINGS_VIRTUAL_ID}`;
const ARTIFACTS_VIRTUAL_ID = "virtual:nimbus/agent-endpoint-assets";
const ARTIFACTS_RESOLVED_ID = `\0${ARTIFACTS_VIRTUAL_ID}`;
const ASSET_LOADER_VIRTUAL_ID = "virtual:nimbus/agent-endpoint-asset-loader";
const ASSET_LOADER_RESOLVED_ID = `\0${ASSET_LOADER_VIRTUAL_ID}`;

export function preparedHeadingsPlugin(
  root: URL | string,
): PreparedHeadingsPlugin {
  return {
    name: "nimbus-docs:prepared-headings",
    resolveId(id) {
      return id === HEADINGS_VIRTUAL_ID ? HEADINGS_RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== HEADINGS_RESOLVED_ID) return undefined;
      const key = preparedMarkdownRootKey(root);
      const configured = agentEndpointAssetState.roots.get(key);
      if (!configured) {
        throw new Error(
          "nimbus-docs: prepared headings are available only during a configured Astro build or dev server.",
        );
      }
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
      const module =
        context.server.moduleGraph.getModuleById(HEADINGS_RESOLVED_ID);
      if (module) context.server.moduleGraph.invalidateModule(module);
    },
  };
}

export function agentEndpointAssetsRuntimePlugin(
  root: URL | string,
): PreparedHeadingsPlugin {
  return {
    name: "nimbus-docs:agent-endpoint-assets-runtime",
    resolveId(id) {
      return id === ARTIFACTS_VIRTUAL_ID ? ARTIFACTS_RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== ARTIFACTS_RESOLVED_ID) return undefined;
      if (this.environment?.name === "ssr") {
        registerAgentEndpointAssetDemand(root);
      }
      const manifest = await ensureAgentEndpointAssets(root);
      return (
        `export const projectRoot = ${JSON.stringify(preparedMarkdownRootKey(root))};\n` +
        `export const base = ${JSON.stringify(manifest.base)};\n` +
        `export const markdownAssets = ${JSON.stringify(manifest.markdownAssets)};\n` +
        `export const llmsAssets = ${JSON.stringify(manifest.llmsAssets)};\n`
      );
    },
    handleHotUpdate(context) {
      const module =
        context.server.moduleGraph.getModuleById(ARTIFACTS_RESOLVED_ID);
      if (module) context.server.moduleGraph.invalidateModule(module);
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
          "  return env.ASSETS?.fetch(new Request(new URL(path, request.url))) ?? null;\n" +
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
): Promise<void> {
  const projectRoot = preparedMarkdownRootKey(root);
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  const sourceRoot = agentEndpointAssetRoot(projectRoot);
  const targetRoot = path.join(outputRoot, "_nimbus", "agent-endpoint-assets");
  const assets = [...manifest.markdownAssets, ...manifest.llmsAssets];
  const copies = assets.map((asset) => ({
    source: resolveContainedAssetPath(sourceRoot, asset.path),
    target: resolveContainedAssetPath(targetRoot, asset.path),
  }));
  await removeAgentEndpointAssets(outputRoot);
  for (let index = 0; index < copies.length; index += 64) {
    await Promise.all(
      copies.slice(index, index + 64).map(async ({ source, target }) => {
        await assertNoSymlink(projectRoot, source);
        await mkdir(path.dirname(target), { recursive: true });
        await assertNoSymlink(outputRoot, target);
        await copyFile(source, target);
      }),
    );
  }
}

export function configureAgentEndpointAssetRoot(
  root: URL | string,
  mode: "build" | "dev",
  bake: () => Promise<AgentEndpointAssetManifest>,
  bakeHeadings?: () => Promise<PreparedHeadingRecord[]>,
  headingsBase?: string,
): void {
  const key = preparedMarkdownRootKey(root);
  agentEndpointAssetState.demands.delete(key);
  agentEndpointAssetState.roots.set(key, {
    mode,
    bake,
    bakeHeadings,
    headingsBase,
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
  const headings = await mergePartialHeadings(
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
    for (const collectionName of options.indexedCollections) {
      const collection = snapshot.collections.get(collectionName);
      if (!collection) continue;
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
  const apiCollections = new Set(options.apiCollections ?? []);
  const candidates: PreparedMarkdownEntry[] = [];
  for (const collectionName of options.indexedCollections) {
    if (apiCollections.has(collectionName)) continue;
    const collection = snapshot.collections.get(collectionName);
    if (!collection) {
      throw new Error(
        `nimbus-docs: indexed collection "${collectionName}" is not prepared. ` +
          "Wrap its object loader with withNimbusMarkdown(loader).",
      );
    }
    assertPreparedCollection(collectionName, collection, base);
    candidates.push(...collection.entries.values());
  }

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
      assertPreparedCollection("partials", partials, base);
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
  const headingRecords: PreparedHeadingRecord[] = [];
  const preparedLlmsPages: PreparedLlmsPage[] = [];
  const llmsRoutePages: PreparedLlmsPage[] = [];
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
    const markdown = renderEntryAsMarkdown(
      { body: expanded, filePath: entry.filePath },
      {
        citationIndex: basedCitationIndex,
        componentMap: renderers,
        base,
      },
    );
    const page = preparedLlmsPage(entry, markdown, options);
    llmsRoutePages.push(page);
    if (isDiscoverable(entry)) preparedLlmsPages.push(page);
    if (entry.headings) {
      const headings = entry.filePath?.endsWith(".md") ? entry.headings : await mergePartialHeadings(
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
    for (const surface of ["markdown", "source"] as const) {
      const asset =
        surface === "markdown"
          ? markdownAsset(entry, markdown, options)
          : sourceAsset(entry, expanded, options);
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
        digest: `sha256:${fingerprint}`,
        mediaType:
          surface === "markdown"
            ? "text/markdown; charset=utf-8"
            : "text/mdx; charset=utf-8",
        path: `assets/${fingerprint}.${extension}`,
        contentStart,
        contentEnd,
        body,
      });
    }
  }
  for (const entry of apiEntries) {
    const decision = decisions.get(`${entry.collection}\0${entry.id}`)!;
    if (decision.status === "exclude") continue;
    const routePage = preparedLlmsPage(entry, "", options);
    llmsRoutePages.push(routePage);
    if (!isDiscoverable(entry)) continue;
    const coordinate = entry.data.coordinate;
    if (typeof coordinate !== "string") {
      throw new Error(
        `nimbus-docs: API entry "${entry.id}" in collection "${entry.collection}" is missing its coordinate — the apiCollection() loader should have set it.`,
      );
    }
    const prepared = entry.data.prepared;
    if (!isPreparedApiPage(prepared)) {
      throw new Error(
        `nimbus-docs: API entry "${entry.id}" in collection "${entry.collection}" is missing its prepared page data — rebuild the apiCollection() index.`,
      );
    }
    preparedLlmsPages.push(
      preparedLlmsPage(entry, renderApiPageMarkdown(prepared.page, { base }), options),
    );
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

  const { leaves, groups } = groupPreparedLlmsPages(preparedLlmsPages, options);
  assertLlmsRouteSafety(llmsRoutePages, groups);
  const versionSlugs = new Set(options.versions?.others ?? []);
  const llmsFullPages = preparedLlmsPages.filter(
    (page) =>
      page.collection === PRIMARY_COLLECTION ||
      !versionSlugs.has(collectionLabel(page.collection, options.versions)),
  );
  const llmsBodies: Array<{
    reference: LlmsEndpointReference;
    body: string;
  }> = [
    {
      reference: { scope: "site", surface: "index" },
      body: siteIndexAsset(leaves, groups, options),
    },
    {
      reference: { scope: "site", surface: "full" },
      body: buildLlmsFullMarkdown(
        llmsFullPages.map((page): LlmsFullBlock => ({
          title: page.title,
          description: page.description,
          url: page.url,
          markdownUrl: page.markdownUrl,
          markdown: page.markdown,
        })),
        {
          title: options.title,
          description: options.description,
          site: options.site,
          base,
        },
      ),
    },
    ...groups.map((group) => ({
      reference: {
        scope: "section" as const,
        surface: "index" as const,
        section: group.slug,
      },
      body: sectionIndexAsset(group, options),
    })),
  ];
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
        mediaType: "text/plain; charset=utf-8",
        path: `assets/${fingerprint}.txt`,
        body,
      };
    });
  llmsRecords.sort((a, b) => compare(preparedLlmsKey(a), preparedLlmsKey(b)));
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
    markdownAssets: records.map(({ body: _body, ...record }) => record),
    llmsAssets: llmsRecords.map(({ body: _body, ...record }) => record),
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
      [...records, ...llmsRecords],
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
