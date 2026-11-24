import {
  readStagedAsset,
  validateStagedAssetPath,
} from "./staged-asset-reader.js";
import type { StagedAssetContext } from "./staged-asset-reader.js";
import { createRequestClaims } from "./request-claims.js";

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
  /** The stored record's JSON bytes: an estimate of the Markdown made from it. */
  bytes?: number;
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
  /** Requests that may wait for a read before the next is refused as busy. */
  maxPendingReads?: number;
  maxConcurrentReads?: number;
}
const PREFIX = "_nimbus/pages/";
// Far longer than any read; past it, a read's request is taken to have died.
const READ_LEASE_MS = 30_000;
// Waiting requests take a handed-off value within a second of the read.
const HANDOFF_MS = 5_000;
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
      (row.description !== undefined && typeof row.description !== "string") ||
      (row.bytes !== undefined && (typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0))
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
  // Files being read. A request never starts a second read of a file another
  // request is reading: it waits, then finds the value in the cache, or, when
  // the cache can't hold it, in `handoff`, kept only for the requests that
  // were waiting for it when the read finished, and only briefly.
  const reads = createRequestClaims(READ_LEASE_MS);
  const handoff = new Map<string, { value: unknown; left: number; at: number }>();
  let generation = 0;
  async function load(
    filename: string,
    index: boolean,
    context: StagedAssetContext,
  ): Promise<unknown> {
    const path = assetPath(filename);
    const key = `${index ? "index" : "record"}:${path}`;
    const pool = pools[index ? "index" : "record"];
    // A share whose waiting request was cancelled is dropped after a while.
    for (const [other, handed] of handoff)
      if (Date.now() - handed.at > HANDOFF_MS) handoff.delete(other);
    for (;;) {
      const cached = pool.entries.get(key);
      if (cached) {
        pool.entries.delete(key);
        pool.entries.set(key, cached);
        return cached.value;
      }
      if (!reads.has(key) && reads.size < concurrency) break;
      if (reads.waiting() >= maxPending) throw new PageAssetReadOverloadError();
      await reads.released(key);
      const handed = handoff.get(key);
      if (handed) {
        if (--handed.left <= 0) handoff.delete(key);
        return handed.value;
      }
    }
    const claim = reads.claim(key);
    handoff.delete(key);
    const startedGeneration = generation;
    try {
      const body = await read(path, context);
      // A UTF-16 code unit is at most 3 UTF-8 bytes, so most assets are
      // provably under the limit without counting.
      const bytes = body.length * 3 <= maxBytes ? body.length : utf8Bytes(body);
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
      // A read that outlived its lease publishes nothing: another holds the key.
      const current = claim.held() && generation === startedGeneration;
      const waiters = reads.waiting(key);
      if (current && cost > pool.budget && waiters) {
        // One at a time: such a value is large, and its waiters take it at
        // once; any that miss it after a newer one replaces it read it again.
        handoff.clear();
        handoff.set(key, { value, left: waiters, at: Date.now() });
      }
      if (current && cost <= pool.budget) {
        const previous = pool.entries.get(key);
        if (previous) {
          pool.bytes -= previous.bytes;
          pool.entries.delete(key);
        }
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
      claim.release();
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
      handoff.clear();
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
        active: reads.size,
        queued: reads.waiting(),
        budget,
      };
    },
  };
}
export type PageAssetReader = ReturnType<typeof createPageAssetReader>;
