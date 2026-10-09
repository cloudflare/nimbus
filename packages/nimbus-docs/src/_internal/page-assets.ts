import {
  readStagedAsset,
  validateStagedAssetPath,
} from "./staged-asset-reader.js";
import type { StagedAssetContext } from "./staged-asset-reader.js";

export interface PageAssetLocation {
  filename: string;
  key?: string;
}
export interface PageAssetRow {
  id: string;
  slug: string;
  title: string;
  description?: string;
  location: PageAssetLocation;
}
export interface PageAssetIndex {
  revision: 1;
  rows: PageAssetRow[];
  metadata?: unknown;
}
export interface ParsedPageAssetIndex extends PageAssetIndex {
  byId: Map<string, PageAssetRow>;
  bySlug: Map<string, PageAssetRow>;
}
export interface PageAssetReaderOptions {
  readAsset?: (path: string, context: StagedAssetContext) => Promise<string>;
  /** Conservative accounting for parsed values and lookup maps, not a heap measurement. */
  cacheBudgetBytes?: number;
  maxAssetBytes?: number;
  maxPendingReads?: number;
  maxConcurrentReads?: number;
}
const PREFIX = "_nimbus/pages/";
export class PageAssetReadOverloadError extends Error {
  override readonly name = "PageAssetReadOverloadError";
  readonly status = 503;
  constructor() {
    super("nimbus-docs: page asset reader is busy; retry the request.");
  }
}
const byteEncoder = new TextEncoder();
const byteScratch = new Uint8Array(64 * 1024);
/** Native UTF-8 counting with fixed scratch space, not an asset-sized copy. */
function utf8Bytes(value: string): number {
  let position = 0;
  let bytes = 0;
  while (position < value.length) {
    const result = byteEncoder.encodeInto(value.slice(position), byteScratch);
    position += result.read;
    bytes += result.written;
  }
  return bytes;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assetPath(filename: string): string {
  validateStagedAssetPath(filename);
  const relative = filename.startsWith(PREFIX)
    ? filename.slice(PREFIX.length)
    : filename;
  if (!/^(?:index|record|pack)-[a-f0-9]+\.json$/.test(relative)) {
    throw new Error(
      `nimbus-docs: invalid page asset filename ${JSON.stringify(filename)}.`,
    );
  }
  return PREFIX + relative;
}
export function parsePageAssetIndex(value: unknown): ParsedPageAssetIndex {
  if (!object(value) || value.revision !== 1 || !Array.isArray(value.rows)) {
    throw new Error(
      "nimbus-docs: invalid page asset index or unsupported revision.",
    );
  }
  const byId = new Map<string, PageAssetRow>();
  const bySlug = new Map<string, PageAssetRow>();
  // Fields consumers read from every row are checked here; a row's location is
  // validated when that row is read, so a cold request doesn't check 4,000.
  for (const row of value.rows) {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.slug !== "string" ||
      typeof row.title !== "string" ||
      (row.description !== undefined && typeof row.description !== "string")
    ) {
      throw new Error("nimbus-docs: malformed page asset index row.");
    }
    if (byId.has(row.id) || bySlug.has(row.slug))
      throw new Error("nimbus-docs: duplicate page asset id or slug.");
    byId.set(row.id, row as unknown as PageAssetRow);
    bySlug.set(row.slug, row as unknown as PageAssetRow);
  }
  return {
    revision: 1,
    rows: value.rows as PageAssetRow[],
    metadata: value.metadata,
    byId,
    bySlug,
  };
}

/** One bounded cache per reader/isolate; request handlers must reuse the reader. */
export function createPageAssetReader(options: PageAssetReaderOptions = {}) {
  const read = options.readAsset ?? readStagedAsset;
  // An accounting budget; deployment acceptance still measures peak heap.
  // Three quarters go to indexes: a request for a new page loads a new pack,
  // and in one shared pool those packs evicted the indexes every version needs.
  const budget = options.cacheBudgetBytes ?? 32 * 1024 * 1024;
  const maxBytes = options.maxAssetBytes ?? 25 * 1024 * 1024;
  const maxPending = options.maxPendingReads ?? 128;
  const concurrency = options.maxConcurrentReads ?? 2;
  if (
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(maxPending) ||
    maxPending <= 0 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency <= 0
  )
    throw new Error("nimbus-docs: invalid page asset reader limits.");
  const pools = {
    index: {
      entries: new Map<string, { value: unknown; bytes: number }>(),
      bytes: 0,
      budget: Math.floor(budget * 0.75),
    },
    record: {
      entries: new Map<string, { value: unknown; bytes: number }>(),
      bytes: 0,
      budget: budget - Math.floor(budget * 0.75),
    },
  };
  const pending = new Map<string, Promise<unknown>>();
  let active = 0;
  let generation = 0;
  const queue: Array<() => void> = [];
  async function acquire() {
    if (active < concurrency) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  function release() {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
  async function load(
    filename: string,
    index: boolean,
    context: StagedAssetContext,
  ): Promise<unknown> {
    const path = assetPath(filename);
    const key = `${index ? "index" : "record"}:${path}`;
    const pool = pools[index ? "index" : "record"];
    const cached = pool.entries.get(key);
    if (cached) {
      pool.entries.delete(key);
      pool.entries.set(key, cached);
      return cached.value;
    }
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    if (pending.size >= maxPending) throw new PageAssetReadOverloadError();
    const startedGeneration = generation;
    const promise = (async () => {
      await acquire();
      try {
        const body = await read(path, context);
        // A UTF-16 code unit is at most 3 UTF-8 bytes, so most assets are
        // provably under the limit without counting.
        const bytes =
          body.length * 3 <= maxBytes ? body.length : utf8Bytes(body);
        if (bytes > maxBytes)
          throw new Error(
            `nimbus-docs: page asset ${path} exceeds the ${maxBytes}-byte read limit.`,
          );
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error(`nimbus-docs: page asset ${path} is not valid JSON.`);
        }
        const value = index ? parsePageAssetIndex(parsed) : parsed;
        // Raw text is released after this call. A parsed index measured 1.6×
        // its text with both lookup maps (5.1 MiB for 3.15 M characters);
        // charge 2× plus the maps' entries so the estimate stays above it.
        const cost =
          body.length * 2 +
          (index ? (value as ParsedPageAssetIndex).rows.length * 64 : 0);
        if (cost <= pool.budget && generation === startedGeneration) {
          while (pool.bytes + cost > pool.budget && pool.entries.size) {
            const oldest = pool.entries.keys().next().value!;
            pool.bytes -= pool.entries.get(oldest)!.bytes;
            pool.entries.delete(oldest);
          }
          pool.entries.set(key, { value, bytes: cost });
          pool.bytes += cost;
        }
        return value;
      } finally {
        release();
      }
    })();
    pending.set(key, promise);
    try {
      return await promise;
    } finally {
      pending.delete(key);
    }
  }
  return {
    async readIndex(
      filename: string,
      context: StagedAssetContext = {},
    ): Promise<ParsedPageAssetIndex> {
      return (await load(filename, true, context)) as ParsedPageAssetIndex;
    },
    async readRecord(
      location: PageAssetLocation,
      context: StagedAssetContext = {},
    ): Promise<unknown> {
      if (
        !object(location) ||
        typeof location.filename !== "string" ||
        (location.key !== undefined &&
          (typeof location.key !== "string" || !location.key))
      ) {
        throw new Error("nimbus-docs: malformed page asset location.");
      }
      const value = await load(location.filename, false, context);
      if (location.key === undefined) return value;
      if (
        !object(value) ||
        value.revision !== 1 ||
        !object(value.records) ||
        !Object.hasOwn(value.records, location.key)
      ) {
        throw new Error(
          `nimbus-docs: page record ${location.key} is absent from pack ${location.filename}.`,
        );
      }
      return value.records[location.key];
    },
    clear() {
      generation++;
      for (const pool of Object.values(pools)) {
        pool.entries.clear();
        pool.bytes = 0;
      }
    },
    get stats() {
      return {
        entries: pools.index.entries.size + pools.record.entries.size,
        bytes: pools.index.bytes + pools.record.bytes,
        pools: {
          index: {
            entries: pools.index.entries.size,
            bytes: pools.index.bytes,
            budget: pools.index.budget,
          },
          record: {
            entries: pools.record.entries.size,
            bytes: pools.record.bytes,
            budget: pools.record.budget,
          },
        },
        pending: pending.size,
        active,
        queued: queue.length,
        budget,
      };
    },
  };
}
export type PageAssetReader = ReturnType<typeof createPageAssetReader>;
