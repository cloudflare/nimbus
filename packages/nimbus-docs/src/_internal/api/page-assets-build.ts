/** OpenAPI's consumer of the generic staged-page layer. Build-only, never SSR. */
import { unusedExtensions, warnUnusedExtensions } from "./extensions.js";
import {
  readFile,
  writeFile,
  readdir,
  realpath,
  rm,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import {
  PageAssetWriter,
  pageAssetDigest,
  resetPageAssetStaging,
  writeAtomic,
} from "../page-assets-build.js";
import {
  createPageAssetReader,
  type ParsedPageAssetIndex,
  type PageAssetRow,
} from "../page-assets.js";
import { preparedMarkdownRootKey } from "../prepared-markdown-registry.js";
import { buildsPageAssets } from "../page-assets-config.js";
import {
  buildApiModel,
  clearApiModelCache,
  getApiPageIndex,
  getApiPageProps,
  getApiNav,
  getApiRouteProvenance,
} from "../../api/index.js";
import { resolveSpecSource } from "./resolve-spec.js";
import { unwrapModel } from "./model-handle.js";
import {
  operationPaths,
  operationShapes,
  setApiModelPageReferences,
} from "./view-model.js";
import {
  apiNavList,
  apiNavListFiles,
  clearApiNavLists,
  recordApiNavList,
} from "./nav-list.js";
import { prepareApiNav, type PreparedApiNav } from "./prepared.js";
import { prepareApiPageCode } from "../api-loader.js";
import { collectApiCitationSummary } from "./citation-index.js";
import type { ResolvedApiVersion } from "./resolve-versions.js";
import type { ApiPageProps } from "./api-view-types.js";
import {
  getCodeStyleCSS,
  restoreCodeStyleCSS,
} from "../code-style-registry.js";
import { resolveApiAssetLinks } from "./page-assets-links.js";
import { linkPolicy } from "../url.js";

/** Bump when preparation semantics change without a package version change. */
export const API_PAGE_PREPARATION_REVISION = 1;
const verifiedCitationSummaries = new WeakMap<PageAssetWriter, Set<string>>();
// Versions whose inputs can't be fully hashed (external references) never
// reach the persistent cache. Within one `astro build` their inputs can't
// change, so config-time and loader preparation share one result.
const BUILD_PREPARATIONS = Symbol.for(
  "@cloudflare/nimbus-docs/api-build-preparations/v1",
);
const preparationGlobals = globalThis as typeof globalThis & {
  [BUILD_PREPARATIONS]?: Map<string, PreparedApiAssetVersion>;
};
// Once per API per process: the cause is the same for every version.
const externalReferenceWarnings = new Set<string>();
const buildPreparations: Map<string, PreparedApiAssetVersion> =
  (preparationGlobals[BUILD_PREPARATIONS] ??= new Map());
const preparedRecordMemos = new WeakMap<PageAssetWriter, Map<string, string>>();
const PREPARED_RECORD_MEMO_BYTES = 8 * 1024 * 1024;
// Two 64-character digests, UTF-16 strings plus conservative Map-entry overhead.
const PREPARED_RECORD_MEMO_ENTRY_BYTES = 64 * 4 + 96;
const preparationMetrics = {
  modelPreparations: 0,
  pageProjections: 0,
  pagePreparations: 0,
  preparedRecordCacheHits: 0,
  versionCacheHits: 0,
  versionCacheMisses: 0,
};
export function getApiAssetPreparationMetrics() {
  return { ...preparationMetrics };
}
export function resetApiAssetPreparationMetrics(): void {
  preparationMetrics.modelPreparations =
    preparationMetrics.pageProjections =
    preparationMetrics.pagePreparations =
      0;
  preparationMetrics.preparedRecordCacheHits = 0;
  preparationMetrics.versionCacheHits =
    preparationMetrics.versionCacheMisses = 0;
}

export type ApiPageAssetManifest = Record<string, Record<string, string>>;
export interface ApiAssetSummary {
  rows: Array<{
    id: string;
    slug: string;
    title: string;
    description?: string;
    provenance?: string;
  }>;
  shapes: Record<string, string>;
}
export interface PreparedApiAssetVersion {
  inputHash: string;
  rows: PageAssetRow[];
  /** Hash of `rows`, locations included: with inputHash it fixes the index. */
  rowsHash: string;
  nav: PreparedApiNav;
  operationPaths: Record<string, string>;
  summary: ApiAssetSummary;
  reused: boolean;
  citationSummaryPath: string;
  citationSummaryHash: string;
  codeStyleCSS: string;
  /** Listed `api[].extensions` names the version never uses, so a reused
   *  version still warns. */
  unusedExtensions?: string[];
}
export interface ApiPageAssetMetadata {
  nav: PreparedApiNav;
  matches: Record<string, string>;
  canonicalSlugs: Record<string, string | null>;
}
const REGISTRY = Symbol.for("@cloudflare/nimbus-docs/api-page-assets/v1");
const globals = globalThis as typeof globalThis & {
  [REGISTRY]?: Map<string, ApiPageAssetManifest>;
};
const manifests = (globals[REGISTRY] ??= new Map());
// Recorded while staging, so deployment never re-reads the indexes it wrote.
// Shared like the manifests: the loader and integration can be separate copies.
const DEPLOYMENT_FILES = Symbol.for(
  "@cloudflare/nimbus-docs/api-page-assets-files/v1",
);
const fileGlobals = globalThis as typeof globalThis & {
  [DEPLOYMENT_FILES]?: Map<string, Record<string, Set<string>>>;
};
const deploymentFiles: Map<string, Record<string, Set<string>>> = (fileGlobals[
  DEPLOYMENT_FILES
] ??= new Map());
const ACTIVE_INPUTS = Symbol.for(
  "@cloudflare/nimbus-docs/api-page-assets-inputs/v1",
);
const inputGlobals = globalThis as typeof globalThis & {
  [ACTIVE_INPUTS]?: Map<string, Map<string, Set<string>>>;
};
const activeInputs = (inputGlobals[ACTIVE_INPUTS] ??= new Map());
export function getApiPageAssetManifest(
  root: URL | string,
): ApiPageAssetManifest {
  return manifests.get(preparedMarkdownRootKey(root)) ?? {};
}
export function clearApiPageAssetManifest(root: URL | string): void {
  const key = preparedMarkdownRootKey(root);
  manifests.delete(key);
  clearApiNavLists(root);
  deploymentFiles.delete(key);
  activeInputs.delete(key);
  buildReaders.delete(key);
  resetPageAssetStaging(key);
  for (const memo of buildPreparations.keys())
    if (memo.startsWith(`${key}\0`)) buildPreparations.delete(memo);
}

/** Root and dependency bytes, not timestamps, decide whether preparation is reusable.
 * The current parser's external-reference resolution has no reliable dependency
 * report. Such inputs are deliberately never reused until that seam exists. */
export function externalReferenceReason(raw: string): string | undefined {
  // Only run on a cache miss. JSON/YAML syntax, escapes and aliases must not
  // hide a dependency or turn authored text into a generated-link token.
  const value: unknown = raw.trimStart().startsWith("{")
    ? JSON.parse(raw)
    : parseYaml(raw);
  const seen = new Set<object>();
  let reason: string | undefined;
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.includes("nimbus-ref:"))
        throw new Error(
          "Authored API input contains reserved nimbus-ref: prefix.",
        );
      return;
    }
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [key, item] of Object.entries(node)) {
      visit(key);
      if (key === "$ref" && typeof item === "string" && !item.startsWith("#"))
        reason ??= `external reference ${item}`;
      visit(item);
    }
  };
  visit(value);
  return reason;
}

/** The packages whose output is stored in prepared records: parsing, samples,
 * highlighting, and description Markdown rendered and sanitised to HTML. Their
 * whole dependency closure is hashed, so a fix deep inside one invalidates. */
const PREPARATION_PACKAGES = [
  "@scalar/openapi-parser",
  "@scalar/json-magic",
  "openapi-sampler",
  "@readme/httpsnippet",
  "shiki",
  "@shikijs/transformers",
  "yaml",
  "satteri",
  "hast-util-from-html",
  "hast-util-sanitize",
  "hast-util-to-html",
];

const OPTIONAL_PACKAGES = new Set([
  "@scalar/openapi-parser",
  "openapi-sampler",
  "@readme/httpsnippet",
]);

/** Node's package lookup, which also finds packages whose exports hide
 * `package.json` or offer no `require` condition. */
async function packageDirectory(
  name: string,
  from: string,
): Promise<string | undefined> {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    try {
      await readFile(path.join(candidate, "package.json"));
      return await realpath(candidate);
    } catch {
      /* Keep walking up. */
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

/** `name@version` for every package reachable from the preparation packages. */
export async function preparationPackages(): Promise<string[]> {
  const found = new Set<string>();
  const visited = new Set<string>();
  const visit = async (name: string, from: string, root: boolean) => {
    const directory = await packageDirectory(name, from);
    if (!directory) {
      // A dependency's miss is normal: other platforms' optional binaries.
      if (!root) return;
      // An optional tool may be absent; record it, since installing one changes
      // output. Any other miss means the layout can't be read (Yarn PnP has no
      // node_modules), so the key must match nothing written before.
      if (OPTIONAL_PACKAGES.has(name)) found.add(`${name}@absent`);
      else found.add(`${name}@unknown:${randomUUID()}`);
      return;
    }
    if (visited.has(directory)) return;
    visited.add(directory);
    const pkg = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    found.add(`${pkg.name}@${pkg.version}`);
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      await visit(dependency, directory, false);
    }
  };
  const from = path.dirname(fileURLToPath(import.meta.url));
  for (const name of PREPARATION_PACKAGES) await visit(name, from, true);
  return [...found].sort();
}

let nimbusCode: Promise<string> | undefined;
/** Nimbus's own code, not its version string: a workspace or linked install
 * changes code without changing the version. */
function nimbusCodeDigest(): Promise<string> {
  return (nimbusCode ??= (async () => {
    let directory = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      try {
        const pkg = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        );
        if (pkg.name === "@cloudflare/nimbus-docs") break;
      } catch {
        /* Keep walking up to the package root. */
      }
      // Unidentifiable code must never match a cache written by other code.
      if (path.dirname(directory) === directory)
        return `unknown:${randomUUID()}`;
      directory = path.dirname(directory);
    }
    // Hash the tree this module runs from (src/ or dist/), not the whole package.
    const code = path.join(
      directory,
      path
        .relative(directory, fileURLToPath(import.meta.url))
        .split(path.sep)[0]!,
    );
    const hash = createHash("sha256");
    const files = (
      await readdir(code, { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
    for (const file of files)
      hash
        .update(path.relative(code, file))
        .update("\0")
        .update(await readFile(file))
        .update("\0");
    return hash.digest("hex");
  })());
}

/** Every input outside the spec and its options that changes prepared output.
 * Not the lockfile: an unrelated dependency bump must not re-prepare history. */
export async function apiPreparationEnvironment(
  _root: string,
): Promise<string> {
  return pageAssetDigest(
    JSON.stringify({
      revision: API_PAGE_PREPARATION_REVISION,
      nimbus: await nimbusCodeDigest(),
      packages: await preparationPackages(),
    }),
  );
}

/** A version cache file is its hash, a newline, then the JSON it hashes, so a
 * read checks the bytes it already holds instead of serialising them again. */
async function writeVersionCache(
  filename: string,
  value: unknown,
): Promise<void> {
  const body = JSON.stringify(value);
  await writeAtomic(filename, `${pageAssetDigest(body)}\n${body}`);
}
async function readVersionCache(filename: string): Promise<unknown> {
  const raw = await readFile(filename, "utf8");
  const split = raw.indexOf("\n");
  const body = raw.slice(split + 1);
  if (split !== 64 || raw.slice(0, split) !== pageAssetDigest(body))
    throw new Error("Damaged version cache");
  return JSON.parse(body);
}

export async function prepareApiAssetVersion(
  target: ResolvedApiVersion,
  root: string,
  writer: PageAssetWriter,
  environment: string,
  warn: (message: string) => void = () => {},
): Promise<PreparedApiAssetVersion> {
  await writer.initialize();
  const source = await resolveSpecSource(
    {
      collection: target.namespace,
      spec: target.spec,
      // Labels and deployment URLs are context, never part of a shared page.
      requireOperationId: target.requireOperationId,
      schemaPages: target.schemaPages,
      routes: target.routes,
      samples: target.samples,
      extensions: target.extensions,
    },
    root,
  );
  const raw =
    typeof source.spec === "string" ? source.spec : JSON.stringify(source.spec);
  if (raw.includes("nimbus-ref:"))
    throw new Error(
      `API ${target.family}: authored input contains reserved nimbus-ref: prefix.`,
    );
  const inputHash = pageAssetDigest(
    JSON.stringify({
      environment,
      collection: target.namespace,
      spec: pageAssetDigest(raw),
      requireOperationId: target.requireOperationId,
      schemaPages: target.schemaPages,
      routes: target.routes,
      samples: target.samples,
      extensions: target.extensions,
    }),
  );
  const filename = path.join(
    writer.cacheDirectory,
    "versions",
    `${inputHash}.json`,
  );
  const buildKey = `${preparedMarkdownRootKey(root)}\0${inputHash}`;
  const built = buildPreparations.get(buildKey);
  if (built) {
    restoreCodeStyleCSS(built.codeStyleCSS);
    preparationMetrics.versionCacheHits++;
    return { ...built, reused: true };
  }
  {
    try {
      const value = (await readVersionCache(
        filename,
      )) as PreparedApiAssetVersion;
      if (
        value.inputHash !== inputHash ||
        !Array.isArray(value.rows) ||
        typeof value.rowsHash !== "string" ||
        !value.nav ||
        !value.operationPaths ||
        !value.summary
      )
        throw new Error("Invalid version cache");
      value.citationSummaryPath = path.join(
        writer.cacheDirectory,
        "citations",
        `${value.citationSummaryHash}.json`,
      );
      const verified =
        verifiedCitationSummaries.get(writer) ?? new Set<string>();
      if (!verified.has(value.citationSummaryHash)) {
        if (
          pageAssetDigest(await readFile(value.citationSummaryPath)) !==
          value.citationSummaryHash
        )
          throw new Error("Damaged citation summary");
        verified.add(value.citationSummaryHash);
        verifiedCitationSummaries.set(writer, verified);
      }
      if (!(await writer.stageListed(value.rows.map((row) => row.location))))
        throw new Error("Missing prepared asset");
      if (typeof value.codeStyleCSS !== "string")
        throw new Error("Missing cached syntax highlighting CSS");
      restoreCodeStyleCSS(value.codeStyleCSS);
      preparationMetrics.versionCacheHits++;
      return { ...value, reused: true };
    } catch {
      /* Rebuild missing or corrupt cache entries from source. */
    }
  }
  const bypass = externalReferenceReason(raw);
  const warnKey = `${preparedMarkdownRootKey(root)}\0${target.family}`;
  if (bypass && !externalReferenceWarnings.has(warnKey)) {
    externalReferenceWarnings.add(warnKey);
    warn(
      `API "${target.family}" uses an external reference (${bypass.replace(/^external reference /, "")}), so its versions are prepared on every build rather than reused.`,
    );
  }
  preparationMetrics.versionCacheMisses++;
  preparationMetrics.modelPreparations++;
  const model = await buildApiModel(source);
  const spine = unwrapModel(model);
  setApiModelPageReferences(spine, true);
  try {
    const pages = getApiPageIndex(model);
    const provenance = getApiRouteProvenance(model);
    const rows: PageAssetRow[] = [];
    const hashes: string[] = [];
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const page of pages) {
      if (ids.has(page.coordinate) || slugs.has(page.slug))
        throw new Error(
          `API ${target.family} has duplicate id or slug: ${page.coordinate}, ${page.slug}`,
        );
      ids.add(page.coordinate);
      slugs.add(page.slug);
      preparationMetrics.pageProjections++;
      const pageProps = getApiPageProps(model, page.coordinate);
      const projectedHash = pageAssetDigest(
        `${environment}\0${JSON.stringify(pageProps)}`,
      );
      const recordMemo =
        preparedRecordMemos.get(writer) ?? new Map<string, string>();
      preparedRecordMemos.set(writer, recordMemo);
      let recordHash = recordMemo.get(projectedHash);
      if (recordHash) {
        preparationMetrics.preparedRecordCacheHits++;
        recordMemo.delete(projectedHash);
      } else {
        preparationMetrics.pagePreparations++;
        recordHash = await writer.add(await prepareApiPageCode(pageProps));
      }
      recordMemo.set(projectedHash, recordHash);
      while (
        recordMemo.size * PREPARED_RECORD_MEMO_ENTRY_BYTES >
        PREPARED_RECORD_MEMO_BYTES
      )
        recordMemo.delete(recordMemo.keys().next().value!);
      hashes.push(recordHash);
      rows.push({
        id: page.coordinate,
        slug: page.slug,
        title: page.title,
        ...(page.description === undefined
          ? {}
          : { description: page.description }),
        location: { filename: "" },
      });
    }
    await writer.finishVersion();
    rows.forEach((row, i) => {
      row.location = writer.location(hashes[i]!);
    });
    const citationBytes = JSON.stringify(
      collectApiCitationSummary(model, target.schemaPages ?? false),
    );
    const citationSummaryHash = pageAssetDigest(citationBytes);
    const citationSummaryPath = path.join(
      writer.cacheDirectory,
      "citations",
      `${citationSummaryHash}.json`,
    );
    const verified = verifiedCitationSummaries.get(writer) ?? new Set<string>();
    if (!verified.has(citationSummaryHash)) {
      await writeAtomic(citationSummaryPath, citationBytes);
      verified.add(citationSummaryHash);
      verifiedCitationSummaries.set(writer, verified);
    }
    const value: PreparedApiAssetVersion = {
      inputHash,
      rows,
      rowsHash: pageAssetDigest(JSON.stringify(rows)),
      codeStyleCSS: getCodeStyleCSS(),
      citationSummaryPath,
      citationSummaryHash,
      nav: prepareApiNav(getApiNav(model)),
      operationPaths: operationPaths(spine),
      reused: false,
      summary: {
        rows: rows.map(({ location: _location, ...row }) => ({
          ...row,
          provenance: provenance.get(row.id),
        })),
        shapes: Object.fromEntries(operationShapes(spine)),
      },
    };
    const unused = unusedExtensions(model, target.extensions);
    if (unused.length > 0) value.unusedExtensions = unused;
    if (!bypass) await writeVersionCache(filename, value);
    else if (buildsPageAssets(root)) buildPreparations.set(buildKey, value);
    return value;
  } finally {
    setApiModelPageReferences(spine, false);
    // The version cache owns JSON, never a live parse tree. Bound full-model memory.
    clearApiModelCache(target.namespace);
  }
}

/** Publish pointers only after every index has been written successfully. */
export async function stageApiAssetFamily(
  root: string,
  family: string,
  versions: Array<{
    target: ResolvedApiVersion;
    prepared: PreparedApiAssetVersion;
    metadata: ApiPageAssetMetadata;
  }>,
  writer: PageAssetWriter,
): Promise<Record<string, string>> {
  const next: Record<string, string> = Object.create(null);
  const files = new Set<string>();
  for (const { target, prepared, metadata } of versions) {
    // An unchanged version's index is reused: it depends only on its rows and
    // navigation, its match and canonical metadata, its URLs and link policy.
    const indexKey = pageAssetDigest(
      JSON.stringify({
        revision: API_PAGE_PREPARATION_REVISION,
        input: prepared.inputHash,
        rows: prepared.rowsHash,
        url: [
          target.family,
          target.mountPath,
          target.versionMode,
          target.versionParam,
          target.isDefault,
          target.version,
        ],
        policy: linkPolicy(),
        matches: metadata.matches,
        canonicalSlugs: metadata.canonicalSlugs,
      }),
    );
    const indexPointer = path.join(writer.cacheDirectory, "indexes", indexKey);
    let filename = await readFile(indexPointer, "utf8").catch(() => "");
    let nav: PreparedApiNav | undefined;
    const resolvedNav = () =>
      (nav ??= resolveApiAssetLinks(metadata.nav, target, {
        byId: new Map(prepared.rows.map((row) => [row.id, row])),
      }) as PreparedApiNav);
    if (!filename || !(await writer.stage({ filename }))) {
      filename = await writer.writeIndex(prepared.rows, {
        ...metadata,
        nav: resolvedNav(),
      });
      await writeAtomic(indexPointer, filename);
    }
    next[target.version ?? ""] = filename;
    files.add(filename);
    if (target.sidebar === "on-demand") {
      // Same inputs as the index, so the index's key names it too.
      const listPointer = `${indexPointer}.nav`;
      let list = await readFile(listPointer, "utf8").catch(() => "");
      if (!list || !(await writer.stage({ filename: list }))) {
        const written = apiNavList(resolvedNav().nav, prepared.operationPaths);
        await writer.writeAsset(written.filename, written.body);
        list = written.filename;
        await writeAtomic(listPointer, list);
      }
      recordApiNavList(root, target.family, target.version, list);
    }
    for (const row of prepared.rows) files.add(row.location.filename);
  }
  const key = preparedMarkdownRootKey(root);
  manifests.set(key, { ...manifests.get(key), [family]: next });
  deploymentFiles.set(key, { ...deploymentFiles.get(key), [family]: files });
  return next;
}

const buildReaders = new Map<
  string,
  ReturnType<typeof createPageAssetReader>
>();
function buildReader(
  root: URL | string,
): ReturnType<typeof createPageAssetReader> {
  const key = preparedMarkdownRootKey(root);
  let reader = buildReaders.get(key);
  if (!reader) {
    reader = createPageAssetReader({
      cacheBudgetBytes: 32 * 1024 * 1024,
      readAsset: (filename) =>
        readFile(
          path.join(key, ".astro/nimbus/pages", path.basename(filename)),
          "utf8",
        ),
    });
    buildReaders.set(key, reader);
  }
  return reader;
}
export async function readApiAssetIndexForBuild(
  root: URL | string,
  collection: string,
  version: string | null,
): Promise<ParsedPageAssetIndex & { metadata: ApiPageAssetMetadata }> {
  const filename = getApiPageAssetManifest(root)[collection]?.[version ?? ""];
  if (!filename)
    throw new Error(
      `Missing API page asset index for ${collection}@${version ?? ""}`,
    );
  return (await buildReader(root).readIndex(
    filename,
  )) as ParsedPageAssetIndex & { metadata: ApiPageAssetMetadata };
}
export async function readApiAssetPageForBuild(
  root: URL | string,
  row: PageAssetRow,
): Promise<ApiPageProps> {
  return (await buildReader(root).readRecord(row.location)) as ApiPageProps;
}

const FAMILY_QUEUES = Symbol.for(
  "@cloudflare/nimbus-docs/api-page-assets-queues/v1",
);
type ApiFamilyPreparation = Awaited<
  ReturnType<typeof prepareApiAssetFamilyNow>
>;
const queueGlobals = globalThis as typeof globalThis & {
  [FAMILY_QUEUES]?: Map<string, Promise<ApiFamilyPreparation>>;
};
const familyQueues = (queueGlobals[FAMILY_QUEUES] ??= new Map());

/** Serialize content-loader and citation-watcher rebuilds without hiding input changes. */
export async function prepareApiAssetFamily(
  root: string,
  entry: import("../../types.js").ApiSpec,
  warn: (message: string) => void = () => {},
): Promise<ApiFamilyPreparation> {
  const key = `${preparedMarkdownRootKey(root)}\0${entry.collection}`;
  const prior = familyQueues.get(key);
  const pending = (
    prior ? prior.catch(() => undefined) : Promise.resolve()
  ).then(() => prepareApiAssetFamilyNow(root, entry, warn));
  familyQueues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (familyQueues.get(key) === pending) familyQueues.delete(key);
  }
}

/** Shared by config-time citation preparation and the content loader. */
async function prepareApiAssetFamilyNow(
  root: string,
  entry: import("../../types.js").ApiSpec,
  warn: (message: string) => void = () => {},
): Promise<{
  versions: Array<{
    target: ResolvedApiVersion;
    prepared: PreparedApiAssetVersion;
  }>;
  manifest: Record<string, string>;
}> {
  const { resolveApiFamily } = await import("./resolve-versions.js");
  const { matchApiVersions, apiVersionMatcherRevision } =
    await import("./version-matches.js");
  const writer = new PageAssetWriter(root);
  const environment = await apiPreparationEnvironment(root);
  const versions: Array<{
    target: ResolvedApiVersion;
    prepared: PreparedApiAssetVersion;
  }> = [];
  for (const target of resolveApiFamily(entry)) {
    const prepared = await prepareApiAssetVersion(target, root, writer, environment, warn);
    warnUnusedExtensions(target.family, target.version, prepared.unusedExtensions ?? [], warn);
    versions.push({ target, prepared });
  }
  const matchKey = pageAssetDigest(
    JSON.stringify({
      revision: apiVersionMatcherRevision,
      versions: versions.map(({ target, prepared }) => [
        target.version,
        prepared.inputHash,
        pageAssetDigest(JSON.stringify(prepared.summary)),
      ]),
    }),
  );
  const matchPath = path.join(
    writer.cacheDirectory,
    "matches",
    `${pageAssetDigest(entry.collection)}.json`,
  );
  let matches: import("./version-matches.js").ApiVersionMatches[];
  try {
    const cached = JSON.parse(await readFile(matchPath, "utf8"));
    if (
      cached.key !== matchKey ||
      cached.hash !== pageAssetDigest(JSON.stringify(cached.value))
    )
      throw new Error("Missing or damaged matching cache");
    matches = cached.value;
  } catch {
    matches = matchApiVersions(
      versions.map(({ target, prepared }) => ({
        version: target.version,
        rows: prepared.summary.rows,
        shapes: prepared.summary.shapes,
      })),
    );
    await writeAtomic(
      matchPath,
      JSON.stringify({
        key: matchKey,
        hash: pageAssetDigest(JSON.stringify(matches)),
        value: matches,
      }),
    );
  }
  const byVersion = new Map(matches.map((item) => [item.version, item.byId]));
  const defaultVersion = versions.find(({ target }) => target.isDefault)!;
  const defaultMatches = byVersion.get(defaultVersion.target.version)!;
  const canonicalByMatch = new Map(
    defaultVersion.prepared.rows.map((row) => [
      defaultMatches[row.id],
      {
        version: defaultVersion.target.version,
        id: row.id,
        slug: row.slug,
      },
    ]),
  );
  // Preserve the loader's path-version shadow validation when no store rows exist.
  const defaultTop = new Set(
    defaultVersion.prepared.rows
      .filter((row) => row.slug)
      .map((row) => row.slug.split("/")[0]),
  );
  for (const { target } of versions) {
    if (!target.isDefault && target.version && defaultTop.has(target.version)) {
      throw new Error(
        `API version ${target.version} collides with a default page in ${entry.collection}; rename the version or pin its route.`,
      );
    }
  }
  const manifest = await stageApiAssetFamily(
    root,
    entry.collection,
    versions.map(({ target, prepared }) => {
      const versionMatches = byVersion.get(target.version)!;
      return {
        target,
        prepared,
        metadata: {
          nav: prepared.nav,
          matches: Object.fromEntries(
            Object.entries(versionMatches).filter(([id, key]) => id !== key),
          ),
          canonicalSlugs: Object.fromEntries(
            prepared.rows.flatMap((row) => {
              const canonical = canonicalByMatch.get(versionMatches[row.id]);
              return canonical?.slug === row.slug
                ? []
                : [[row.id, canonical?.slug ?? null]];
            }),
          ),
        },
      };
    }),
    writer,
  );
  const rootKey = preparedMarkdownRootKey(root);
  const families = activeInputs.get(rootKey) ?? new Map<string, Set<string>>();
  families.set(
    entry.collection,
    new Set(versions.map(({ prepared }) => prepared.inputHash)),
  );
  activeInputs.set(rootKey, families);
  await writer.saveCatalog();
  return { versions, manifest };
}

/** Only current pointers are deployment assets; the persistent cache may retain more. */
export async function apiPageAssetDeploymentFiles(
  root: URL | string,
): Promise<string[]> {
  const families = deploymentFiles.get(preparedMarkdownRootKey(root)) ?? {};
  return [
    ...new Set([
      ...Object.values(families).flatMap((files) => [...files]),
      ...apiNavListFiles(root),
    ]),
  ].sort();
}

/** Copy only reachable assets; copy-on-write is advisory, never a hard link. */
const PAGE_ASSET_FILE = /^(?:index|record|pack|nav)-[a-f0-9]{64}\.json$/;

/** The files the last successful build deployed, as recorded in the cache. */
async function previousDeploymentFiles(rootPath: string): Promise<string[]> {
  try {
    const value = JSON.parse(
      await readFile(
        path.join(rootPath, ".nimbus/cache/page-assets/deployed.json"),
        "utf8",
      ),
    );
    if (value?.revision !== 1 || !Array.isArray(value.files)) return [];
    return value.files.filter(
      (file: unknown) => typeof file === "string" && PAGE_ASSET_FILE.test(file),
    );
  } catch {
    return [];
  }
}

export async function stagePageAssetDeployment(
  root: URL | string,
  outputRoot: URL | string,
): Promise<void> {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  const outputPath =
    outputRoot instanceof URL ? fileURLToPath(outputRoot) : outputRoot;
  const directory = path.join(outputPath, "_nimbus/pages");
  await mkdir(directory, { recursive: true });
  const files = new Set(await apiPageAssetDeploymentFiles(root));
  for (const filename of files)
    await copyFile(
      path.join(rootPath, ".astro/nimbus/pages", filename),
      path.join(directory, filename),
      constants.COPYFILE_FICLONE,
    );
  // Also ship the previous successful build's files, so a server still
  // running that release mid-rollout can read them. They come from the build
  // cache, which may be restored from CI, so each is hash-checked first.
  for (const filename of await previousDeploymentFiles(rootPath)) {
    if (files.has(filename)) continue;
    let bytes: Buffer;
    try {
      bytes = await readFile(
        path.join(rootPath, ".nimbus/cache/page-assets/assets", filename),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (!filename.includes(pageAssetDigest(bytes))) continue;
    await writeFile(path.join(directory, filename), bytes);
    files.add(filename);
  }
  for (const filename of await readdir(directory)) {
    if (PAGE_ASSET_FILE.test(filename) && !files.has(filename))
      await rm(path.join(directory, filename));
  }
}

/** Call only after the whole site build succeeds, never during preparation. */
export async function pruneApiPageAssetCache(
  root: URL | string,
): Promise<void> {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  const rootKey = preparedMarkdownRootKey(root);
  const families = activeInputs.get(rootKey);
  if (!families) {
    // Only bundled APIs: their filter lists are this build's only page assets.
    const lists = new Set(apiNavListFiles(root));
    if (!lists.size) return;
    await recordDeployment(rootPath, lists, "nav");
    const staging = path.join(rootPath, ".astro/nimbus/pages");
    for (const filename of await readdir(staging).catch(() => [])) {
      if (
        filename.startsWith("nav-") &&
        PAGE_ASSET_FILE.test(filename) &&
        !lists.has(filename)
      )
        await rm(path.join(staging, filename));
    }
    return;
  }
  const inputs = new Set(
    [...families.values()].flatMap((values) => [...values]),
  );
  const files = new Set(await apiPageAssetDeploymentFiles(root));
  const cache = path.join(rootPath, ".nimbus/cache/page-assets");
  const citationHashes = new Set<string>();
  for (const input of inputs) {
    try {
      const value = (await readVersionCache(
        path.join(cache, "versions", `${input}.json`),
      )) as Partial<PreparedApiAssetVersion>;
      if (typeof value.citationSummaryHash === "string")
        citationHashes.add(value.citationSummaryHash);
    } catch {
      /* Uncacheable sources have no version artifact to retain. */
    }
  }
  const retain: Record<string, (filename: string) => boolean> = {
    citations: (filename) =>
      citationHashes.has(filename.replace(/\.json$/, "")),
    assets: (filename) => files.has(filename),
    versions: (filename) =>
      inputs.has(filename.replace(/(?:\.citations)?\.json$/, "")),
    matches: (filename) =>
      [...families.keys()].some(
        (family) => filename === `${pageAssetDigest(family)}.json`,
      ),
  };
  for (const [subdirectory, keep] of Object.entries(retain)) {
    let entries: string[];
    try {
      entries = await readdir(path.join(cache, subdirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const filename of entries) {
      if (
        /^(?:(?:index|record|pack|nav)-)?[a-f0-9]{64}(?:\.citations)?\.json$/.test(
          filename,
        ) &&
        !keep(filename)
      )
        await rm(path.join(cache, subdirectory, filename));
    }
  }
  // Index pointers survive only while the index they name is deployed.
  try {
    for (const pointer of await readdir(path.join(cache, "indexes"))) {
      if (!/^[a-f0-9]{64}(?:\.nav)?$/.test(pointer)) continue;
      const target = path.join(cache, "indexes", pointer);
      if (!files.has(await readFile(target, "utf8"))) await rm(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const catalog = JSON.parse(
      await readFile(path.join(cache, "catalog.json"), "utf8"),
    );
    if (catalog.revision === 1 && Array.isArray(catalog.records)) {
      catalog.records = catalog.records.filter((entry: unknown[]) =>
        files.has((entry[1] as { filename?: string })?.filename ?? ""),
      );
      await writeAtomic(
        path.join(cache, "catalog.json"),
        JSON.stringify(catalog),
      );
    }
  } catch {
    /* A missing or damaged catalog is reconstructed by preparation. */
  }
  const staging = path.join(rootPath, ".astro/nimbus/pages");
  for (const filename of await readdir(staging)) {
    if (PAGE_ASSET_FILE.test(filename) && !files.has(filename))
      await rm(path.join(staging, filename));
  }
  resetPageAssetStaging(rootKey);
  await recordDeployment(rootPath, files);
}

/** Note what this build deployed, which the next build ships again as its
 *  "previous release"; drop cached assets (of one kind, if given) it didn't. */
async function recordDeployment(
  rootPath: string,
  files: Set<string>,
  kind?: "nav",
): Promise<void> {
  const cache = path.join(rootPath, ".nimbus/cache/page-assets");
  if (kind) {
    const assets = path.join(cache, "assets");
    for (const filename of await readdir(assets).catch(() => [])) {
      if (
        filename.startsWith(`${kind}-`) &&
        PAGE_ASSET_FILE.test(filename) &&
        !files.has(filename)
      )
        await rm(path.join(assets, filename));
    }
  }
  await writeAtomic(
    path.join(cache, "deployed.json"),
    JSON.stringify({ revision: 1, files: [...files].sort() }),
  );
}
