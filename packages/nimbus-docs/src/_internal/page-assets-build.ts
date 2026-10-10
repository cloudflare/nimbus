/** Build-only content-addressed storage. Records and index metadata are opaque. */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type {
  PageAssetIndex,
  PageAssetLocation,
  PageAssetRow,
} from "./page-assets.js";
import { preparedMarkdownRootKey } from "./prepared-markdown-registry.js";

// Bump on any change to how packs or record keys are written: cached packs
// are trusted on their file hash alone, never re-checked record by record.
export const PAGE_ASSET_REVISION = 1;
export const DEFAULT_PAGE_PACK_BYTES = 1024 * 1024;
export function pageAssetDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function writeAtomic(
  filename: string,
  bytes: string,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, filename);
}

// A cache file verified once stays trusted for the life of the process while
// its size and mtime are unchanged, so config-time and loader preparation
// share that work. What is staged resets with each configuration session.
interface VerifiedFile {
  /** Read lazily, only when a location must prove its key. */
  keys?: Set<string>;
  size: number;
  mtimeMs: number;
}
// On globalThis: the integration and the content loader can load separate
// copies of this module in one process.
const WRITER_STATE = Symbol.for("@cloudflare/nimbus-docs/page-asset-writer/v1");
const writerGlobals = globalThis as typeof globalThis & {
  [WRITER_STATE]?: {
    verifiedFiles: Map<string, Map<string, VerifiedFile>>;
    stagedFiles: Map<string, Set<string>>;
    catalogWrites: Map<string, Promise<void>>;
  };
};
const { verifiedFiles, stagedFiles, catalogWrites } = (writerGlobals[
  WRITER_STATE
] ??= {
  verifiedFiles: new Map(),
  stagedFiles: new Map(),
  catalogWrites: new Map(),
});
export function resetPageAssetStaging(root: URL | string): void {
  stagedFiles.delete(preparedMarkdownRootKey(root));
}

/** Packs seal at each version boundary; adding a version never repacks old data. */
export class PageAssetWriter {
  readonly cacheDirectory: string;
  readonly stagingDirectory: string;
  private known = new Map<string, PageAssetLocation>();
  private checked: Map<string, VerifiedFile>;
  private staged: Set<string>;
  private pending = new Map<string, string>();
  private pendingBytes = 26;
  private catalogLoaded = false;
  readonly metrics = {
    recordsWritten: 0,
    recordsReused: 0,
    bytesWritten: 0,
    packsWritten: 0,
  };

  constructor(
    readonly root: string,
    readonly packBytes = DEFAULT_PAGE_PACK_BYTES,
    readonly maxAssetBytes = 25 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maxAssetBytes) ||
      maxAssetBytes < 1024 ||
      !Number.isSafeInteger(packBytes) ||
      packBytes < 1024 ||
      packBytes > maxAssetBytes
    )
      throw new Error(
        "Page pack budget must be at least 1 KiB and no larger than the deployment asset budget.",
      );
    this.cacheDirectory = path.join(root, ".nimbus/cache/page-assets");
    this.stagingDirectory = path.join(root, ".astro/nimbus/pages");
    const key = preparedMarkdownRootKey(root);
    this.checked = verifiedFiles.get(key) ?? new Map();
    verifiedFiles.set(key, this.checked);
    this.staged = stagedFiles.get(key) ?? new Set();
    stagedFiles.set(key, this.staged);
  }

  async initialize(): Promise<void> {
    if (this.catalogLoaded) return;
    this.catalogLoaded = true;
    await mkdir(path.join(this.cacheDirectory, "assets"), { recursive: true });
    await mkdir(this.stagingDirectory, { recursive: true });
    try {
      const raw = JSON.parse(
        await readFile(path.join(this.cacheDirectory, "catalog.json"), "utf8"),
      );
      if (raw.revision === PAGE_ASSET_REVISION && Array.isArray(raw.records)) {
        for (const [hash, location] of raw.records) {
          if (
            /^[a-f0-9]{64}$/.test(hash) &&
            this.validLocation(location) &&
            (location.key === hash ||
              location.filename === `record-${hash}.json`)
          )
            this.known.set(hash, location);
        }
      }
    } catch {
      /* A missing or damaged optimisation cache is a miss. */
    }
  }

  private validLocation(value: unknown): value is PageAssetLocation {
    if (!value || typeof value !== "object") return false;
    const location = value as PageAssetLocation;
    return (
      typeof location.filename === "string" &&
      /^(?:record|pack|index|nav)-[a-f0-9]{64}\.json$/.test(location.filename) &&
      (location.key === undefined || /^[a-f0-9]{64}$/.test(location.key))
    );
  }

  /** Hash-check restored CI artifacts before trusting any cached pointers. */
  async verify(
    location: PageAssetLocation,
    trustKey = false,
  ): Promise<boolean> {
    if (!this.validLocation(location)) return false;
    const filename = path.join(
      this.cacheDirectory,
      "assets",
      location.filename,
    );
    try {
      const { size, mtimeMs } = await stat(filename);
      let checked = this.checked.get(location.filename);
      let bytes: Buffer | undefined;
      if (!checked || checked.size !== size || checked.mtimeMs !== mtimeMs) {
        // The name is the hash of the bytes, so a match proves the file is
        // intact, and with it every record the writer packed into it.
        bytes = await readFile(filename);
        if (!location.filename.includes(pageAssetDigest(bytes))) return false;
        checked = { size, mtimeMs };
        this.checked.set(location.filename, checked);
      }
      if (location.key === undefined || trustKey) return true;
      // A location from the catalog must also prove the pack holds its key.
      if (!checked.keys) {
        const pack = JSON.parse(
          (bytes ?? (await readFile(filename))).toString("utf8"),
        );
        if (
          pack.revision !== 1 ||
          !pack.records ||
          typeof pack.records !== "object"
        )
          return false;
        checked.keys = new Set(Object.keys(pack.records));
      }
      return checked.keys.has(location.key);
    } catch {
      return false;
    }
  }

  async stage(location: PageAssetLocation, trustKey = false): Promise<boolean> {
    if (!(await this.verify(location, trustKey))) return false;
    if (!this.staged.has(location.filename)) {
      try {
        await copyFile(
          path.join(this.cacheDirectory, "assets", location.filename),
          path.join(this.stagingDirectory, location.filename),
          constants.COPYFILE_FICLONE,
        );
      } catch (error) {
        // Pruned since it was verified: a miss, not a failure.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.checked.delete(location.filename);
        return false;
      }
      this.staged.add(location.filename);
    }
    const recordHash =
      location.key ??
      /^record-([a-f0-9]{64})\.json$/.exec(location.filename)?.[1];
    if (recordHash) this.known.set(recordHash, location);
    return true;
  }

  /** Stage locations listed together with their keys in one hash-checked
   * cache entry: each file is checked and copied once, not once per record. */
  async stageListed(locations: readonly PageAssetLocation[]): Promise<boolean> {
    const files = new Set<string>();
    for (const location of locations) {
      if (!this.validLocation(location)) return false;
      files.add(location.filename);
    }
    for (const filename of files) {
      if (!(await this.stage({ filename }))) return false;
    }
    for (const location of locations) {
      const recordHash =
        location.key ??
        /^record-([a-f0-9]{64})\.json$/.exec(location.filename)?.[1];
      if (recordHash) this.known.set(recordHash, location);
    }
    return true;
  }

  /** Returns the stable record hash; call finishVersion before location(hash). */
  async add(record: unknown): Promise<string> {
    await this.initialize();
    const bytes = JSON.stringify(record);
    const hash = pageAssetDigest(bytes);
    const existing = this.known.get(hash);
    if (existing && (await this.stage(existing))) {
      this.metrics.recordsReused++;
      return hash;
    }
    this.known.delete(hash);
    if (this.pending.has(hash)) {
      this.metrics.recordsReused++;
      return hash;
    }
    const size = Buffer.byteLength(bytes) + hash.length + 4;
    if (this.pendingBytes + size > this.packBytes) await this.flush();
    if (size + 26 > this.packBytes) {
      if (Buffer.byteLength(bytes) > this.maxAssetBytes)
        throw new Error(
          `Prepared page record ${hash} exceeds the ${this.maxAssetBytes}-byte deployment asset budget.`,
        );
      const filename = `record-${hash}.json`;
      await this.write(filename, bytes);
      this.known.set(hash, { filename });
    } else {
      this.pending.set(hash, bytes);
      this.pendingBytes += size;
    }
    this.metrics.recordsWritten++;
    return hash;
  }

  private async write(filename: string, bytes: string): Promise<void> {
    await writeAtomic(
      path.join(this.cacheDirectory, "assets", filename),
      bytes,
    );
    this.metrics.bytesWritten += Buffer.byteLength(bytes);
    this.staged.delete(filename);
    await this.stage({ filename });
  }

  private async flush(): Promise<void> {
    if (!this.pending.size) return;
    const records = [...this.pending].sort(([a], [b]) => a.localeCompare(b));
    const bytes = `{"revision":1,"records":{${records.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}}`;
    const filename = `pack-${pageAssetDigest(bytes)}.json`;
    await this.write(filename, bytes);
    for (const [key] of records) this.known.set(key, { filename, key });
    this.metrics.packsWritten++;
    this.pending.clear();
    this.pendingBytes = 26;
  }

  location(hash: string): PageAssetLocation {
    const result = this.known.get(hash);
    if (!result) throw new Error(`Unsealed page record ${hash}.`);
    return result;
  }

  async finishVersion(): Promise<void> {
    await this.flush();
  }

  /** Once per run, merged with the catalog other writers saved meanwhile. */
  async saveCatalog(): Promise<void> {
    const filename = path.join(this.cacheDirectory, "catalog.json");
    const save = (catalogWrites.get(filename) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const records = new Map<string, PageAssetLocation>();
        try {
          const raw = JSON.parse(await readFile(filename, "utf8"));
          if (
            raw.revision === PAGE_ASSET_REVISION &&
            Array.isArray(raw.records)
          ) {
            for (const [hash, location] of raw.records)
              if (this.validLocation(location)) records.set(hash, location);
          }
        } catch {
          /* Rewritten below from this writer's records. */
        }
        for (const [hash, location] of this.known) records.set(hash, location);
        await writeAtomic(
          filename,
          JSON.stringify({
            revision: PAGE_ASSET_REVISION,
            records: [...records],
          }),
        );
      });
    catalogWrites.set(filename, save);
    await save;
  }

  /** Write a file whose name already holds its hash, such as a nav list. */
  async writeAsset(filename: string, bytes: string): Promise<void> {
    if (!this.validLocation({ filename }))
      throw new Error(`nimbus-docs: invalid page asset name ${filename}.`);
    await this.write(filename, bytes);
  }

  async writeIndex(rows: PageAssetRow[], metadata?: unknown): Promise<string> {
    const index: PageAssetIndex = {
      revision: 1,
      rows,
      ...(metadata === undefined ? {} : { metadata }),
    };
    const bytes = JSON.stringify(index);
    if (Buffer.byteLength(bytes) > this.maxAssetBytes)
      throw new Error(
        `nimbus-docs: an API version's page index is ${Buffer.byteLength(bytes)} bytes, over the ${this.maxAssetBytes}-byte per-file limit. Split the API into several api entries.`,
      );
    const filename = `index-${pageAssetDigest(bytes)}.json`;
    await this.write(filename, bytes);
    return filename;
  }
}
