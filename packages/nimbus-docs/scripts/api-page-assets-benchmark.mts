/**
 * Real preparation/cache/packing benchmark. Run from packages/nimbus-docs:
 * node --import tsx scripts/api-page-assets-benchmark.mts --operations 30 --versions 3 --report /tmp/assets-small.json
 * --spec /tmp/openapi.json uses a real spec; --operations 50 caps it for pilots.
 * Omit --operations for the full spec. --versions 260 exercises retained history.
 * Full workloads require 40 GiB free by default; --min-free-gib sets a measured
 * run-specific reserve. Project to large version counts only from three or more
 * measured counts, never from one run or cloned records.
 * This is preparation/data projection, NOT full Astro HTML/deployment/Workers CPU.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  stat,
  statfs,
  rm,
  rename,
} from "node:fs/promises";
import { cpus, totalmem, platform, arch } from "node:os";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { parse as parseYaml } from "yaml";
import {
  PageAssetWriter,
  pageAssetDigest,
} from "../src/_internal/page-assets-build.js";
import {
  prepareApiAssetVersion,
  stageApiAssetFamily,
  apiPreparationEnvironment,
  getApiAssetPreparationMetrics,
  resetApiAssetPreparationMetrics,
  type PreparedApiAssetVersion,
} from "../src/_internal/api/page-assets-build.js";
import {
  getApiCodePreparationMetrics,
  resetApiCodePreparationMetrics,
} from "../src/_internal/api-loader.js";
import {
  resolveApiFamily,
  type ResolvedApiVersion,
} from "../src/_internal/api/resolve-versions.js";
import { matchApiVersions } from "../src/_internal/api/version-matches.js";
import { createPageAssetReader } from "../src/_internal/page-assets.js";
import { resolveApiAssetLinks } from "../src/_internal/api/page-assets-links.js";
import { activatePreparedApiNav } from "../src/_internal/api/prepared.js";
type Obj = Record<string, any>;
const GiB = 1024 ** 3;
const args = process.argv.slice(2);
const arg = (flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const methods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
interface Options {
  spec?: string;
  operations?: number;
  versions: number;
  rate: number;
  packBytes: number;
  cacheBytes: number;
  reserve: number;
  filesystemCompression: boolean;
  phases: string[];
}
const options: Options = {
  spec: arg("--spec") ? path.resolve(arg("--spec")!) : undefined,
  operations: arg("--operations")
    ? Number(arg("--operations"))
    : arg("--spec")
      ? undefined
      : 30,
  versions: Number(arg("--versions") ?? 3),
  rate: Number(arg("--change-rate") ?? 0.2),
  packBytes: Number(arg("--pack-kib") ?? 1024) * 1024,
  cacheBytes: Number(arg("--cache-mib") ?? 32) * 1024 * 1024,
  reserve: Number(
    arg("--min-free-gib") ??
      ((arg("--spec") && !arg("--operations")) ||
      Number(arg("--operations") ?? 30) > 50
        ? 40
        : 1),
  ),
  filesystemCompression: args.includes("--filesystem-compression"),
  phases: (arg("--phases") ?? "cold,warm,add,upgrade").split(","),
};
async function free(root: string) {
  const fs = await statfs(root);
  return fs.bavail * fs.bsize;
}
async function guard(root: string, o: Options) {
  const remaining = await free(root);
  if (remaining < o.reserve * GiB)
    throw new Error(
      "Disk guard: " +
        (remaining / GiB).toFixed(2) +
        " GiB free; reserve " +
        o.reserve +
        " GiB. No capacity sign-off.",
    );
  return remaining;
}
function generatedSpec(count: number): Obj {
  const paths: Obj = {};
  for (let i = 0; i < count; i++)
    paths["/resources/" + i + "/{id}"] = {
      get: {
        operationId: "getResource" + i,
        tags: ["Group " + Math.floor(i / 25)],
        summary: "Get resource " + i,
        description:
          "Read resource " +
          i +
          ". Supports a stable identifier and returns its current details.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Resource",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "name"],
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    enabled: { type: "boolean" },
                  },
                },
                example: { id: "item-123", name: "An example", enabled: true },
              },
            },
          },
          "404": { description: "Resource not found" },
        },
      },
    };
  return {
    openapi: "3.0.3",
    info: { title: "Generated capacity benchmark", version: "base" },
    servers: [{ url: "https://example.test/v1" }],
    paths,
  };
}
function operationsOf(
  spec: Obj,
): Array<{ pathname: string; method: string; operation: Obj }> {
  return Object.entries(spec.paths ?? {}).flatMap(([pathname, item]) =>
    Object.entries(item as Obj)
      .filter(
        ([method, operation]) =>
          methods.has(method) && operation && typeof operation === "object",
      )
      .map(([method, operation]) => ({
        pathname,
        method,
        operation: operation as Obj,
      })),
  );
}
async function source(o: Options) {
  const raw = o.spec
    ? await readFile(o.spec, "utf8")
    : JSON.stringify(generatedSpec(o.operations ?? 30));
  const spec: Obj = raw.trimStart().startsWith("{")
    ? JSON.parse(raw)
    : parseYaml(raw);
  const all = operationsOf(spec);
  if (o.operations !== undefined && all.length > o.operations) {
    // Evenly spaced sample avoids pretending the first resource represents a whole API.
    const selected = new Set(
      Array.from({ length: o.operations }, (_, i) =>
        Math.floor((i * all.length) / o.operations!),
      ),
    );
    all.forEach(({ pathname, method }, i) => {
      if (!selected.has(i)) delete spec.paths[pathname][method];
    });
    for (const pathname of Object.keys(spec.paths))
      if (
        !Object.keys(spec.paths[pathname]).some((method) => methods.has(method))
      )
        delete spec.paths[pathname];
  }
  return {
    spec,
    inputBytes: Buffer.byteLength(raw),
    inputHash: pageAssetDigest(raw),
    operations: operationsOf(spec).length,
    corpus: o.spec
      ? o.operations
        ? "evenly sampled real operations; original components retained"
        : "full real-spec-derived generated history"
      : "simple synthetic operations; NOT representative of a 27 MB production API",
  };
}
function versionSpec(base: Obj, version: number, rate: number) {
  const spec = structuredClone(base),
    operations = operationsOf(spec);
  const count = Math.max(1, Math.floor(operations.length * rate)),
    groups = Math.ceil(operations.length / count);
  operations.forEach(({ operation }, i) => {
    const previous =
      version - ((version - 1 - Math.floor(i / count) + groups) % groups);
    if (version > 0 && previous > 0)
      operation.description =
        (operation.description ?? "") +
        "\n\nDocumentation revision " +
        previous +
        ".";
  });
  spec.info = { ...spec.info, version: "benchmark-" + version };
  return spec;
}
async function tree(root: string) {
  const result = { files: 0, bytes: 0, largest: 0, allocatedBytes: 0 };
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) {
        const info = await stat(filename);
        result.files++;
        result.bytes += info.size;
        result.largest = Math.max(result.largest, info.size);
        result.allocatedBytes += info.blocks * 512;
      }
    }
  }
  await walk(root);
  return result;
}
/** Optional macOS benchmark-environment storage only: product bytes stay JSON. */
function filesystemCompressor(root: string, o: Options) {
  const seen = new Map<string, string>();
  const metrics = {
    files: 0,
    wallMs: 0,
    parentCpuUserUs: 0,
    parentCpuSystemUs: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
  };
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filename);
        continue;
      }
      if (!entry.isFile() || !filename.endsWith(".json")) continue;
      const info = await stat(filename),
        signature = String(info.size) + ":" + String(info.mtimeMs);
      if (seen.get(filename) === signature || info.size < 16 * 1024) continue;
      // Already transparently compressed (possibly cloned from a previous phase).
      if (info.blocks * 512 < info.size) {
        seen.set(filename, signature);
        continue;
      }
      await guard(root, o);
      const temporary = filename + ".benchmark-compressed";
      const before = process.cpuUsage(),
        started = performance.now();
      try {
        const originalHash = pageAssetDigest(await readFile(filename));
        await promisify(execFile)("/usr/bin/ditto", [
          "--hfsCompression",
          filename,
          temporary,
        ]);
        if (pageAssetDigest(await readFile(temporary)) !== originalHash)
          throw new Error("Filesystem compression changed asset bytes");
        await rename(temporary, filename);
        const current = await stat(filename),
          cpu = process.cpuUsage(before);
        seen.set(
          filename,
          String(current.size) + ":" + String(current.mtimeMs),
        );
        metrics.files++;
        metrics.wallMs += performance.now() - started;
        metrics.parentCpuUserUs += cpu.user;
        metrics.parentCpuSystemUs += cpu.system;
        metrics.logicalBytes += current.size;
        metrics.allocatedBytes += current.blocks * 512;
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  return {
    metrics,
    async run() {
      if (!o.filesystemCompression) return;
      if (platform() !== "darwin")
        throw new Error(
          "--filesystem-compression is a macOS/APFS benchmark environment option",
        );
      await walk(path.join(root, ".nimbus/cache"));
      await walk(path.join(root, ".astro/nimbus/pages"));
    },
  };
}
async function phase(root: string, kind: string, o: Options) {
  await guard(root, o);
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        "../src/_internal/page-assets.ts",
        "../src/_internal/page-assets-build.ts",
        "../src/_internal/api/page-assets-build.ts",
        "../src/_internal/api-loader.ts",
        "../src/_internal/api/version-matches.ts",
      ].map(async (name) => [
        name,
        pageAssetDigest(await readFile(new URL(name, import.meta.url))),
      ]),
    ),
  );
  const cpu = process.cpuUsage(),
    started = performance.now(),
    input = await source(o);
  const sourceBytes: number[] = [],
    versions: Array<{
      target: ResolvedApiVersion;
      prepared: PreparedApiAssetVersion;
    }> = [];
  const writer = new PageAssetWriter(root, o.packBytes);
  const compression = filesystemCompressor(root, o);
  const environment =
    (await apiPreparationEnvironment(root)) +
    (kind === "upgrade" ? ":forced-output-revision" : "");
  resetApiAssetPreparationMetrics();
  resetApiCodePreparationMetrics();
  const count = o.versions + (kind === "add" ? 1 : 0);
  // Sites pass spec files, so the benchmark does too. Generating and writing
  // them is harness work, kept out of the preparation time.
  let harnessMs = 0;
  let preparationOnlyMs = 0;
  for (let version = 0; version < count; version++) {
    await guard(root, o);
    const harnessStart = performance.now();
    const specText = JSON.stringify(versionSpec(input.spec, version, o.rate));
    sourceBytes.push(Buffer.byteLength(specText));
    const specFile = path.join(root, "specs", `v${version}.json`);
    await mkdir(path.dirname(specFile), { recursive: true });
    await writeFile(specFile, specText);
    harnessMs += performance.now() - harnessStart;
    const target = resolveApiFamily({
      collection: "api",
      versionUrl: { in: "query" },
      samples: { generate: ["curl"] },
      versions: [{ version: "v" + version, spec: `./specs/v${version}.json` }],
    })[0]!;
    target.isDefault = version === count - 1;
    const prepareStart = performance.now();
    const prepared = await prepareApiAssetVersion(
      target,
      root,
      writer,
      environment,
      (message) => process.stderr.write(message + "\n"),
    );
    preparationOnlyMs += performance.now() - prepareStart;
    versions.push({ target, prepared });
    await compression.run();
    process.stderr.write(
      kind +
        ": " +
        (version + 1) +
        "/" +
        count +
        ", " +
        (prepared.reused ? "cache hit" : "prepared") +
        ", " +
        ((await free(root)) / GiB).toFixed(2) +
        " GiB free\n",
    );
  }
  const preparationMs = preparationOnlyMs,
    matchStart = performance.now();
  const matches = matchApiVersions(
    versions.map(({ target, prepared }) => ({
      version: target.version,
      rows: prepared.summary.rows,
      shapes: prepared.summary.shapes,
    })),
  );
  const matchingMs = performance.now() - matchStart,
    latest = versions.at(-1)!;
  const canonical = new Map(
    latest.prepared.rows.map((row) => [
      matches.at(-1)!.byId[row.id],
      { version: latest.target.version, id: row.id, slug: row.slug },
    ]),
  );
  const indexStart = performance.now();
  const manifest = await stageApiAssetFamily(
    root,
    "api",
    versions.map(({ target, prepared }, i) => ({
      target,
      prepared,
      metadata: {
        nav: prepared.nav,
        matches: Object.fromEntries(
          Object.entries(matches[i]!.byId).filter(([id, key]) => id !== key),
        ),
        canonicalSlugs: Object.fromEntries(
          prepared.rows.flatMap((row) => {
            const destination = canonical.get(matches[i]!.byId[row.id]);
            return destination?.slug === row.slug
              ? []
              : [[row.id, destination?.slug ?? null]];
          }),
        ),
      },
    })),
    writer,
  );
  const indexMs = performance.now() - indexStart;
  await compression.run();
  const preparation = getApiAssetPreparationMetrics(),
    highlighting = getApiCodePreparationMetrics();
  if (
    kind === "warm" &&
    (preparation.modelPreparations ||
      preparation.pagePreparations ||
      highlighting.highlightCalls)
  )
    throw new Error("Warm run unexpectedly prepared or highlighted pages");
  const recordSizes: number[] = [],
    operationSizes: number[] = [];
  const largestOperations: Array<{ id: string; bytes: number }> = [];
  for (const filename of await readdir(
    path.join(writer.cacheDirectory, "assets"),
  )) {
    if (!/^(pack|record)-/.test(filename)) continue;
    const data = JSON.parse(
      await readFile(
        path.join(writer.cacheDirectory, "assets", filename),
        "utf8",
      ),
    );
    for (const record of filename.startsWith("pack-")
      ? (Object.values(data.records) as Obj[])
      : [data]) {
      const bytes = Buffer.byteLength(JSON.stringify(record));
      recordSizes.push(bytes);
      if (record.kind === "operation") {
        operationSizes.push(bytes);
        largestOperations.push({ id: record.coordinate, bytes });
      }
    }
  }
  recordSizes.sort((a, b) => a - b);
  operationSizes.sort((a, b) => a - b);
  largestOperations.sort((a, b) => b.bytes - a.bytes);
  const reader = createPageAssetReader({
    cacheBudgetBytes: o.cacheBytes,
    readAsset: (asset) =>
      readFile(
        path.join(root, ".astro/nimbus", asset.slice("_nimbus/".length)),
        "utf8",
      ),
  });
  const projections = [];
  for (const state of [
    "representative-cold",
    "representative-warm",
    "largest-cold",
    "largest-warm",
  ]) {
    if (state.endsWith("cold")) reader.clear();
    const begin = performance.now(),
      before = process.cpuUsage(),
      selected = versions[0]!;
    const index = await reader.readIndex(manifest[selected.target.version!]!);
    const row = state.startsWith("largest")
      ? index.byId.get(largestOperations[0]!.id)!
      : (index.rows.find(
          (row) => selected.prepared.summary.shapes[row.id] !== undefined,
        ) ?? index.rows[0]!);
    const page = resolveApiAssetLinks(
      await reader.readRecord(row.location),
      selected.target,
      index,
    );
    activatePreparedApiNav((index.metadata as any).nav, row.id);
    const wallMs = performance.now() - begin,
      cpu = process.cpuUsage(before);
    projections.push({
      state,
      id: row.id,
      indexBytes: Buffer.byteLength(
        JSON.stringify({
          revision: index.revision,
          rows: index.rows,
          metadata: index.metadata,
        }),
      ),
      indexParts: Object.fromEntries(
        Object.entries({ rows: index.rows, ...(index.metadata as any) }).map(
          ([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))],
        ),
      ),
      wallMs,
      cpu,
      pageBytes: Buffer.byteLength(JSON.stringify(page)),
      cache: reader.stats,
    });
  }
  return {
    phase: kind,
    sourceHashes,
    operations: input.operations,
    versions: count,
    corpus: input.corpus,
    sourceBytes: input.inputBytes,
    sourceHash: input.inputHash,
    generatedSourceBytes: {
      min: Math.min(...sourceBytes),
      max: Math.max(...sourceBytes),
      total: sourceBytes.reduce((a, b) => a + b, 0),
    },
    preparationMs,
    matchingMs,
    indexMs,
    wallMs: performance.now() - started,
    harnessMs,
    cpu: process.cpuUsage(cpu),
    peakRssKiB: process.resourceUsage().maxRSS,
    preparation,
    highlighting,
    filesystemCompression: compression.metrics,
    writer: writer.metrics,
    cache: await tree(path.join(root, ".nimbus/cache")),
    staged: await tree(path.join(root, ".astro/nimbus/pages")),
    records: {
      count: recordSizes.length,
      mean: recordSizes.reduce((a, b) => a + b, 0) / recordSizes.length,
      p50: recordSizes[Math.floor(recordSizes.length * 0.5)],
      p95: recordSizes[Math.floor(recordSizes.length * 0.95)],
      max: recordSizes.at(-1),
    },
    operationRecords: {
      count: operationSizes.length,
      mean: operationSizes.reduce((a, b) => a + b, 0) / operationSizes.length,
      p50: operationSizes[Math.floor(operationSizes.length * 0.5)],
      p95: operationSizes[Math.floor(operationSizes.length * 0.95)],
      max: operationSizes.at(-1),
      largest: largestOperations.slice(0, 5),
    },
    freeBytesAfter: await guard(root, o),
    projections,
    limitations:
      "Preparation + index emission + data projection only. Excludes full Astro HTML, agent/search outputs, CI network restore, actual HTTP/Workers CPU. Matcher intentionally recomputed; production matching cache needs separate verification.",
  };
}
if (arg("--worker")) {
  const root = arg("--worker")!,
    o: Options = JSON.parse(
      await readFile(path.join(root, "options.json"), "utf8"),
    );
  await writeFile(
    path.join(root, arg("--phase")! + ".json"),
    JSON.stringify(await phase(root, arg("--phase")!, o), null, 2),
  );
} else {
  if (
    !Number.isInteger(options.versions) ||
    options.versions < 1 ||
    !(options.rate > 0 && options.rate <= 1) ||
    options.reserve < 1 ||
    !options.phases.every((x) => ["cold", "warm", "add", "upgrade"].includes(x))
  )
    throw new Error("Invalid benchmark options");
  const root = await mkdtemp(path.join("/tmp", "nimbus-api-assets-benchmark-")),
    results: unknown[] = [];
  const report: Obj = {
    runner: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    options,
    results,
  };
  try {
    await guard(root, options);
    await writeFile(path.join(root, "options.json"), JSON.stringify(options));
    for (const kind of options.phases) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--max-old-space-size=6144",
            "--import",
            "tsx",
            fileURLToPath(import.meta.url),
            "--worker",
            root,
            "--phase",
            kind,
          ],
          { stdio: "inherit" },
        );
        child.on("error", reject);
        child.on("exit", (code, signal) =>
          code === 0
            ? resolve()
            : reject(
                new Error("Phase " + kind + " failed: " + (code ?? signal)),
              ),
        );
      });
      results.push(
        JSON.parse(await readFile(path.join(root, kind + ".json"), "utf8")),
      );
      if (arg("--report"))
        await writeFile(
          path.resolve(arg("--report")!),
          JSON.stringify(report, null, 2),
        );
    }
  } catch (error) {
    report.error = String(error);
    process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
    report.cleanup = { removed: root, freeBytesAfter: await free("/tmp") };
    if (arg("--report"))
      await writeFile(
        path.resolve(arg("--report")!),
        JSON.stringify(report, null, 2),
      );
    console.log(JSON.stringify(report, null, 2));
  }
}
