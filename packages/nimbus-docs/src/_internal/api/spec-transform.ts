/**
 * API spec transforms: `nimbus(config, { api: { <collection>: { transform } } })`.
 *
 * A transform runs in Node at `astro:config:setup`, after content sources
 * resolve, once per spec (each version of a family). Its result is written to
 * `.nimbus/api-specs/<collection>/<sha256>.json` and the entry's `spec` points
 * at that file, so everything after setup (the content loader, page assets,
 * citations, the request-time model) reads a plain file and never the
 * function: the function lives in the integration's options, which no
 * virtual module serializes.
 *
 * Each run transforms the spec as authored (a file, an inline object, or the
 * source snapshot this run selected), never a previous run's output: the
 * inputs are captured when the integration is made, before any run points
 * `spec` elsewhere.
 *
 * `astro preview` serves the last build, so it doesn't transform: it reads the
 * outputs that build recorded at `astro:build:done`. A dev run or a failed
 * build after it leaves that record alone.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { ApiSpec, ApiSpecTransform } from "../../types.js";
import { authorError } from "../author-error.js";
import { createLease, hasLiveLease, releaseLeaseFiles, withSourcesLock } from "../content-sources.js";
import { preparedMarkdownRootKey } from "../prepared-markdown-registry.js";
import { isSpecFromSource } from "../source-repo.js";

export const SPEC_TRANSFORMS_DIR = ".nimbus/api-specs";
const BUILT_FILE = "built.json";
/** The lease scope of transform outputs, released apart from source snapshots'. */
const LEASES = "api-specs";

/** One spec a transform prepares. */
export interface SpecTransformTarget {
  collection: string;
  /** The configured version id, or `null` for an entry without `versions`. */
  version: string | null;
  /** The object whose `spec` points at the output. */
  holder: { spec?: unknown };
  /** The spec as authored. A source spec's input is the snapshot path the run sets. */
  authored: unknown;
  transform: ApiSpecTransform;
}

const key = (target: Pick<SpecTransformTarget, "collection" | "version">) =>
  target.version === null ? target.collection : `${target.collection}@${target.version}`;
const label = (target: Pick<SpecTransformTarget, "collection" | "version">) =>
  `api collection "${target.collection}"${target.version === null ? "" : ` version "${target.version}"`}`;

/**
 * The specs the integration's `api` option transforms, found once when the
 * integration is made. Throws when a key names no `api` entry or a value has
 * no `transform` function.
 */
export function collectSpecTransforms(
  api: readonly ApiSpec[] | undefined,
  options: Record<string, { transform: ApiSpecTransform }> | undefined,
): SpecTransformTarget[] {
  const targets: SpecTransformTarget[] = [];
  for (const [collection, option] of Object.entries(options ?? {})) {
    if (typeof option?.transform !== "function") {
      throw new TypeError(`nimbus-docs: api.${collection}.transform must be a function.`);
    }
    const entry = api?.find((candidate) => candidate.collection === collection);
    if (!entry) {
      const declared = (api ?? []).map((candidate) => `"${candidate.collection}"`).join(", ");
      throw new TypeError(
        `nimbus-docs: the integration's api option names "${collection}", which no api entry in the Nimbus config declares` +
          (declared ? ` (declared: ${declared}).` : "."),
      );
    }
    const holders: { holder: { spec?: unknown }; version: string | null }[] = entry.versions
      ? entry.versions.map((version) => ({ holder: version, version: version.version }))
      : [{ holder: entry, version: null }];
    for (const { holder, version } of holders) {
      targets.push({ collection, version, holder, authored: holder.spec, transform: option.transform });
    }
  }
  return targets;
}

/** The targets a run reads from a source: `applySourceSpecs` sets their input. */
export function readsSource(target: SpecTransformTarget): boolean {
  return isSpecFromSource(target.authored);
}

function readDocument(target: SpecTransformTarget, projectRoot: string): Record<string, unknown> {
  // A source spec's holder holds this run's snapshot path; a file or inline
  // spec is read as authored.
  const input = readsSource(target) ? target.holder.spec : target.authored;
  if (typeof input !== "string") return structuredClone(input as Record<string, unknown>);
  const file = path.resolve(projectRoot, input);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw authorError(`nimbus-docs: cannot read the spec of ${label(target)} at ${file}: ${(error as Error).message}.`);
  }
  try {
    const parsed: unknown = /^\s*\{/.test(text) ? JSON.parse(text) : parseYaml(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (error) {
    throw authorError(`nimbus-docs: cannot parse the spec of ${label(target)} at ${file}: ${(error as Error).message}.`);
  }
  throw authorError(`nimbus-docs: the spec of ${label(target)} at ${file} is not an object.`);
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** The local file a target's spec is authored as, for the dev server to watch. */
export function authoredFile(target: SpecTransformTarget, projectRoot: string): string | undefined {
  return typeof target.authored === "string" ? path.resolve(projectRoot, target.authored) : undefined;
}

/**
 * Run each transform on its spec as authored, write the result, and point
 * the spec at it. Each output is leased, as a source snapshot is; outputs no
 * live process leases and the last build's record doesn't name are removed.
 * Returns this run's leases, for whoever reads the outputs to release.
 */
export async function applySpecTransforms(
  targets: readonly SpecTransformTarget[],
  projectRoot: string,
): Promise<Set<string>> {
  const leases = new Set<string>();
  if (targets.length === 0) return leases;
  const root = path.join(projectRoot, SPEC_TRANSFORMS_DIR);
  const written = new Set<string>();
  try {
    for (const target of targets) await transformOne(target, projectRoot, root, written, leases);
  } catch (error) {
    // A later spec failed: nobody will hold the leases this run already took.
    releaseLeaseFiles(projectRoot, LEASES, leases);
    throw error;
  }
  await withSourcesLock(projectRoot, () => {
    // A build record's partial write, abandoned.
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(`${BUILT_FILE}.tmp-`)) fs.rmSync(path.join(root, name), { force: true });
    }
    const keep = new Set([...written, ...Object.values(readBuilt(projectRoot)).map((file) => path.resolve(projectRoot, file))]);
    for (const collection of new Set(targets.map((target) => target.collection))) {
      const dir = path.join(root, collection);
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        // Writes happen under the lock, so a partial one seen here was abandoned.
        if (name.includes(".tmp-")) {
          fs.rmSync(file, { force: true });
          continue;
        }
        // The leases of an output still here.
        if (!name.endsWith(".json")) continue;
        if (keep.has(file) || hasLiveLease(file)) continue;
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.leases`, { recursive: true, force: true });
      }
    }
  });
  return leases;
}

/** Transform one spec, write its result if new, lease it, and point the spec at it. */
async function transformOne(
  target: SpecTransformTarget,
  projectRoot: string,
  root: string,
  written: Set<string>,
  leases: Set<string>,
): Promise<void> {
  const document = readDocument(target, projectRoot);
  let result: unknown;
  try {
    result = await target.transform(document, { collection: target.collection, version: target.version });
  } catch (error) {
    throw new Error(`nimbus-docs: the transform of ${label(target)} failed: ${(error as Error).message}`, { cause: error });
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw authorError(`nimbus-docs: the transform of ${label(target)} must return the spec as an object.`);
  }
  const json = JSON.stringify(result);
  const digest = createHash("sha256").update(json).digest("hex");
  const dir = path.join(root, target.collection);
  const file = path.join(dir, `${digest}.json`);
  // Written and leased under the lock, so no cleanup can fall between.
  await withSourcesLock(projectRoot, () => {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(file, json);
    }
    leases.add(createLease(projectRoot, file, LEASES));
  });
  written.add(file);
  target.holder.spec = path.relative(projectRoot, file).split(path.sep).join("/");
}

// The dev server's leases per project root. A restart makes a new
// integration from a re-read config, so they live on `globalThis`: `staged`
// are a setup's, and become `serving` when its server is made, which
// releases the old server's. A setup that fails never gets that far, so the
// server still running keeps its leases.
interface DevSpecLeases {
  serving: Set<string>;
  staged?: Set<string>;
}
const devLeasesKey = Symbol.for("@cloudflare/nimbus-docs/api-spec-dev-leases/v1");
const devShared = globalThis as typeof globalThis & { [devLeasesKey]?: Map<string, DevSpecLeases> };
const devLeases = (devShared[devLeasesKey] ??= new Map());

/** A dev setup's leases, held until its server is made or a later setup replaces them. */
export function stageDevSpecLeases(projectRoot: string, leases: Set<string>): void {
  const key = preparedMarkdownRootKey(projectRoot);
  const state = devLeases.get(key) ?? { serving: new Set() };
  if (state.staged) releaseLeaseFiles(projectRoot, LEASES, [...state.staged].filter((lease) => !leases.has(lease)));
  state.staged = leases;
  devLeases.set(key, state);
}

/** The dev server is being made from the staged setup: release the old server's leases. */
export function serveDevSpecLeases(projectRoot: string): void {
  const state = devLeases.get(preparedMarkdownRootKey(projectRoot));
  if (!state?.staged) return;
  const next = state.staged;
  releaseLeaseFiles(projectRoot, LEASES, [...state.serving].filter((lease) => !next.has(lease)));
  state.serving = next;
  state.staged = undefined;
}

// The leases of a build or `astro sync` per project root, also on
// `globalThis`. A sync never records, and a build that fails after its
// transforms ran doesn't either; in a process that lives on (Astro's
// programmatic `build()` and `sync()`), the next run releases what it left.
const buildLeasesKey = Symbol.for("@cloudflare/nimbus-docs/api-spec-build-leases/v1");
const buildShared = globalThis as typeof globalThis & { [buildLeasesKey]?: Map<string, Set<string>> };
const buildLeases = (buildShared[buildLeasesKey] ??= new Map());

/** A build or sync's leases, held until it records or the next run; the earlier run's are released. */
export function holdBuildSpecLeases(projectRoot: string, leases: Set<string>): void {
  const key = preparedMarkdownRootKey(projectRoot);
  const earlier = buildLeases.get(key);
  if (earlier) releaseLeaseFiles(projectRoot, LEASES, [...earlier].filter((lease) => !leases.has(lease)));
  buildLeases.set(key, leases);
}

/** The dev server stopped: release its leases. */
export function releaseDevSpecLeases(projectRoot: string): void {
  const key = preparedMarkdownRootKey(projectRoot);
  const state = devLeases.get(key);
  if (!state) return;
  releaseLeaseFiles(projectRoot, LEASES, [...state.serving, ...(state.staged ?? [])]);
  devLeases.delete(key);
}

function readBuilt(projectRoot: string): Record<string, string> {
  try {
    const built = JSON.parse(fs.readFileSync(path.join(projectRoot, SPEC_TRANSFORMS_DIR, BUILT_FILE), "utf8")) as {
      version?: number;
      specs?: Record<string, string>;
    };
    return built.version === 1 && built.specs ? built.specs : {};
  } catch {
    return {};
  }
}

/**
 * Remove the record when a build starts, so a build that fails leaves none:
 * preview then says to build, rather than reading outputs the served build
 * didn't use.
 */
export function invalidateBuiltSpecTransforms(projectRoot: string): void {
  fs.rmSync(path.join(projectRoot, SPEC_TRANSFORMS_DIR, BUILT_FILE), { force: true });
}

/**
 * Record the outputs a build used, once it succeeded, for `astro preview`,
 * and release the build's leases in the same locked step: the record keeps
 * the outputs.
 */
export async function recordBuiltSpecTransforms(
  targets: readonly SpecTransformTarget[],
  projectRoot: string,
  leases: Set<string>,
): Promise<void> {
  if (targets.length === 0) return;
  const specs = Object.fromEntries(targets.map((target) => [key(target), String(target.holder.spec)]));
  const file = path.join(projectRoot, SPEC_TRANSFORMS_DIR, BUILT_FILE);
  await withSourcesLock(projectRoot, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify({ version: 1, specs }, null, 2)}\n`);
    releaseLeaseFiles(projectRoot, LEASES, leases);
  });
  const rootKey = preparedMarkdownRootKey(projectRoot);
  if (buildLeases.get(rootKey) === leases) buildLeases.delete(rootKey);
}

/** Point each spec at the output the last build recorded, leased while preview runs. */
export async function restoreBuiltSpecTransforms(
  targets: readonly SpecTransformTarget[],
  projectRoot: string,
): Promise<void> {
  if (targets.length === 0) return;
  await withSourcesLock(projectRoot, () => {
    const built = readBuilt(projectRoot);
    for (const target of targets) {
      const recorded = built[key(target)];
      const file = recorded && path.resolve(projectRoot, recorded);
      if (!file || !fs.existsSync(file)) {
        throw authorError(
          `nimbus-docs: ${label(target)} has a transform, and no build recorded its result; run astro build first.`,
        );
      }
      createLease(projectRoot, file, LEASES);
      target.holder.spec = recorded;
    }
  });
}
