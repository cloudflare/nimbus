/**
 * `search sync`: make an AI Search instance's built-in items match the
 * corpus manifests. Item keys carry the page's path hash and its content
 * hash, so comparing is listing keys: no state is kept between runs.
 *
 *   <collection>/<tail>-<sha16(path)>.<hash12>.md
 *
 * The collection is the item's folder and bounds every delete; a changed
 * page is a new key, uploaded before its predecessor is deleted.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SearchCorpusManifest, SearchCorpusPage } from "../../_internal/search-corpus.js";
import { AI_SEARCH_FIELDS, AiSearchApiError, type AiSearchApi, type AiSearchItem } from "./ai-search-api.js";

/** Content the service won't index; skipped and named, never retried. */
export const KNOWN_CONTENT_CODES = new Set([
  "file_content_empty",
  "file_type_unsupported",
  "unsupported_file_type",
  "file_too_large",
  "file_size_exceeded",
]);

const MAX_KEY = 128;
const MAX_BYTES = 10 * 1024 * 1024;

export interface LoadedManifest {
  manifest: SearchCorpusManifest;
  /** The output directory each page's `file` is relative to. */
  outDir: string;
  source: string;
}

export interface SyncOptions {
  dryRun?: boolean;
  purge?: boolean;
  /** `--purge --collection <id>`: one folder only. */
  collection?: string;
  force?: boolean;
  /** Wall-clock budget; the run stops cleanly after it. */
  deadline?: number;
}

export interface SyncSummary {
  uploaded: number;
  unchanged: number;
  repaired: number;
  replacementDeletes: number;
  removalDeletes: number;
  skipped: Array<{ url: string; code: string }>;
  failed: Array<{ url: string; message: string }>;
  orphans: Record<string, number>;
  /** Removal deletes held back for `--force`, by collection. */
  blocked: Record<string, { deletes: number; items: number }>;
  removalsByCollection: Record<string, number>;
  stoppedEarly: boolean;
  requests: number;
}

interface Planned {
  page: SearchCorpusPage;
  outDir: string;
  key: string;
  pathHash: string;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The page's base-free route path: what its path hash identifies across `site` and `base` changes. */
export function routePath(url: string, base: string): string {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const prefix = base === "/" ? "" : base.replace(/\/+$/u, "");
  const route = prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`)) ? pathname.slice(prefix.length) : pathname;
  return route.replace(/\/+$/u, "") || "/";
}

export function itemKey(page: Pick<SearchCorpusPage, "collection" | "url" | "hash">, base: string): { key: string; pathHash: string } {
  const route = routePath(page.url, base);
  const pathHash = sha(route).slice(0, 16);
  const fixed = `${page.collection}/-${pathHash}.${page.hash.slice(0, 12)}.md`;
  const room = Math.max(0, MAX_KEY - fixed.length);
  const last = route.split("/").filter(Boolean).pop() ?? "index";
  const tail = last.toLowerCase().replace(/[^a-z0-9._-]/gu, "-").slice(0, room);
  return { key: `${page.collection}/${tail}-${pathHash}.${page.hash.slice(0, 12)}.md`, pathHash };
}

/** `<collection>/<tail>-<pathHash>.<hash>.md` → its parts; `undefined` for a key this command didn't write. */
export function parseKey(key: string): { collection: string; pathHash: string } | undefined {
  const match = /^([^/]+)\/[a-z0-9._-]*?-([0-9a-f]{16})\.[0-9a-f]{12}\.md$/u.exec(key);
  return match ? { collection: match[1]!, pathHash: match[2]! } : undefined;
}

/** The instance's metadata schema must be exactly the five fields: anything else would drop filters silently. */
export function schemaProblem(fields: Array<{ field_name: string; data_type: string }> | undefined): string | undefined {
  const have = new Map((fields ?? []).map((field) => [field.field_name.toLowerCase(), field.data_type]));
  const want = new Map<string, string>(AI_SEARCH_FIELDS.map((field) => [field.field_name, field.data_type]));
  const problems: string[] = [];
  for (const [name, type] of want) {
    if (!have.has(name)) problems.push(`missing ${name} (${type})`);
    else if (have.get(name) !== type) problems.push(`${name} is ${have.get(name)}, not ${type}`);
  }
  for (const name of have.keys()) if (!want.has(name)) problems.push(`unexpected field ${name}`);
  return problems.length ? problems.join("; ") : undefined;
}

export async function syncSearchCorpus(api: AiSearchApi, manifests: LoadedManifest[], options: SyncOptions = {}): Promise<SyncSummary> {
  const summary: SyncSummary = {
    uploaded: 0,
    unchanged: 0,
    repaired: 0,
    replacementDeletes: 0,
    removalDeletes: 0,
    skipped: [],
    failed: [],
    orphans: {},
    blocked: {},
    removalsByCollection: {},
    stoppedEarly: false,
    requests: 0,
  };
  const outOfTime = () => options.deadline !== undefined && Date.now() >= options.deadline;

  const instance = await api.instance();
  const problem = schemaProblem(instance.custom_metadata);
  if (problem) {
    throw new AiSearchApiError(
      `The instance's metadata fields aren't the five search uses (${problem}). Set custom_metadata to url (text), title (text), version (text), deprecated (boolean), product (text); changing it reindexes the instance.`,
      0,
      "schema",
    );
  }

  const covered = new Set(manifests.flatMap(({ manifest }) => manifest.collections));
  const configured = new Set(manifests.flatMap(({ manifest }) => manifest.siteCollections));
  const items = await api.listItems();
  const byCollection = new Map<string, AiSearchItem[]>();
  for (const item of items) {
    const folder = item.key.includes("/") ? item.key.slice(0, item.key.indexOf("/")) : "";
    if (covered.has(folder)) {
      const list = byCollection.get(folder) ?? [];
      list.push(item);
      byCollection.set(folder, list);
    } else if (!configured.has(folder)) {
      summary.orphans[folder || "(no folder)"] = (summary.orphans[folder || "(no folder)"] ?? 0) + 1;
    }
  }

  if (options.purge) {
    const targets = options.collection ? [options.collection] : [...covered];
    for (const collection of targets) {
      const victims = items.filter((item) => item.key.startsWith(`${collection}/`));
      summary.removalsByCollection[collection] = victims.length;
      if (options.dryRun) continue;
      for (const item of victims) {
        if (outOfTime()) return stop(summary, api);
        await api.deleteItem(item.id);
        summary.removalDeletes += 1;
      }
    }
    summary.requests = api.requests;
    return summary;
  }

  // The pages to index, one per URL (a sliced site's manifests are disjoint).
  const planned: Planned[] = [];
  const seen = new Set<string>();
  for (const { manifest, outDir } of manifests) {
    for (const page of manifest.pages) {
      if (!page.searchable || !covered.has(page.collection) || seen.has(page.url)) continue;
      seen.add(page.url);
      planned.push({ page, outDir, ...itemKey(page, manifest.base) });
    }
  }
  const byKey = new Map(items.map((item) => [item.key, item]));
  const byPath = new Map<string, AiSearchItem[]>();
  for (const item of items) {
    const parsed = parseKey(item.key);
    if (!parsed || !covered.has(parsed.collection)) continue;
    const id = `${parsed.collection}\0${parsed.pathHash}`;
    byPath.set(id, [...(byPath.get(id) ?? []), item]);
  }

  // Removals: covered items whose page is no longer searchable here.
  const wanted = new Set(planned.map((entry) => `${entry.page.collection}\0${entry.pathHash}`));
  const removals = new Map<string, AiSearchItem[]>();
  for (const [collection, list] of byCollection) {
    const gone = list.filter((item) => {
      const parsed = parseKey(item.key);
      return !parsed || !wanted.has(`${parsed.collection}\0${parsed.pathHash}`);
    });
    const pagesHere = planned.some((entry) => entry.page.collection === collection);
    const tooMany = gone.length >= 10 && gone.length > list.length / 4;
    if ((tooMany || (!pagesHere && gone.length > 0)) && !options.force) {
      summary.blocked[collection] = { deletes: gone.length, items: list.length };
      continue;
    }
    if (gone.length) removals.set(collection, gone);
    summary.removalsByCollection[collection] = gone.length;
  }

  for (const entry of planned) {
    if (outOfTime()) return stop(summary, api);
    const present = byKey.get(entry.key);
    const others = (byPath.get(`${entry.page.collection}\0${entry.pathHash}`) ?? []).filter((item) => item.key !== entry.key);
    if (present && (present.status === "completed" || present.status === "queued" || present.status === "running")) {
      summary.unchanged += 1;
      // Stale predecessors left by a run that stopped between upload and delete.
      if (!options.dryRun) for (const item of others) await deleteCounted(api, item, summary, "replacement");
      else summary.replacementDeletes += others.length;
      continue;
    }
    if (present && (present.status === "skipped" || (present.status === "error" && present.code && KNOWN_CONTENT_CODES.has(present.code)))) {
      summary.skipped.push({ url: entry.page.url, code: present.code ?? present.status });
      continue;
    }
    if (entry.page.bytes > MAX_BYTES) {
      summary.skipped.push({ url: entry.page.url, code: "file_too_large" });
      continue;
    }
    const repair = present !== undefined;
    if (options.dryRun) {
      if (repair) summary.repaired += 1;
      else summary.uploaded += 1;
      summary.replacementDeletes += others.length;
      continue;
    }
    try {
      if (repair) await api.deleteItem(present.id);
      const content = (await readFile(path.join(entry.outDir, entry.page.file))).subarray(entry.page.contentStart, entry.page.contentEnd);
      const result = await api.upload(entry.key, content, {
        url: entry.page.url,
        title: entry.page.title,
        version: entry.page.version,
        deprecated: entry.page.deprecated,
        product: entry.page.product,
      });
      if (result.warning) {
        // The fields didn't attach: remove it so the next run retries.
        if (result.id) await api.deleteItem(result.id).catch(() => {});
        summary.failed.push({ url: entry.page.url, message: `upload warned ${result.warning}` });
        continue;
      }
      if (repair) summary.repaired += 1;
      else summary.uploaded += 1;
      for (const item of others) await deleteCounted(api, item, summary, "replacement");
    } catch (error) {
      summary.failed.push({ url: entry.page.url, message: (error as Error).message });
    }
  }

  for (const [, gone] of removals) {
    for (const item of gone) {
      if (outOfTime()) return stop(summary, api);
      if (options.dryRun) summary.removalDeletes += 1;
      else await deleteCounted(api, item, summary, "removal");
    }
  }

  summary.requests = api.requests;
  return summary;
}

async function deleteCounted(api: AiSearchApi, item: AiSearchItem, summary: SyncSummary, kind: "replacement" | "removal") {
  await api.deleteItem(item.id);
  if (kind === "replacement") summary.replacementDeletes += 1;
  else summary.removalDeletes += 1;
}

function stop(summary: SyncSummary, api: AiSearchApi): SyncSummary {
  summary.stoppedEarly = true;
  summary.requests = api.requests;
  return summary;
}
