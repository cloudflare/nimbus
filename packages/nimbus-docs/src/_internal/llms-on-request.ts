/**
 * The agent documents made on request: `/llms.txt`, a section's `llms.txt`,
 * `/llms-full.txt` as an index of parts, and each part, from the page list
 * the build put in the manifest, through the same functions the bake uses.
 * A part's page bodies are the baked docs twins' content and request-
 * rendered API pages' Markdown. One isolate assembles one part at a time;
 * assembled parts are kept per isolate within a byte budget, and in the
 * Cache API where there is one, keyed by the build id. Both are best effort.
 */

import type { LlmsEndpointReference } from "../agent-endpoints.js";
import type { StagedAgentEndpointManifest } from "./agent-endpoint-assets.js";
import { readStagedAsset } from "./staged-asset-reader.js";
import {
  assembleLlmsFullPart,
  flattenLlmsGroups,
  groupLlmsPages,
  llmsFullPagesOf,
  llmsFullPartsIndex,
  nestedCollectionLinks,
  partPages,
  resolvePartIdentity,
  sectionIndexDocument,
  servesSectionIndex,
  siteIndexDocument,
  type ApiVersionUrls,
  type LlmsDocumentContext,
  type LlmsGroup,
  type LlmsPage,
} from "./llms-documents.js";

export interface RenderedLlmsDocument {
  body: string;
  mediaType: string;
  digest: string;
}

/** Test seam: how many documents this isolate has assembled, by kind. */
export const LLMS_RENDER_COUNTER = Symbol.for("nimbus.llms-on-request.renders");

function countRender(kind: string): void {
  const host = globalThis as unknown as Record<symbol, Record<string, number> | undefined>;
  const counts = (host[LLMS_RENDER_COUNTER] ??= {});
  counts[kind] = (counts[kind] ?? 0) + 1;
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function documentContext(manifest: StagedAgentEndpointManifest): Promise<LlmsDocumentContext> {
  const [
    { options, capabilities },
    { loadNimbusConfig, loadMountContext, loadNestedLlmsSections },
    { publishedAgentUrls },
    { versionQueryParam },
  ] = await Promise.all([
    import("virtual:nimbus/agent-capabilities"),
    import("./runtime-config.js"),
    import("./agent-surfaces-runtime.js"),
    import("./api/resolve-versions.js"),
  ]);
  const [config, mount, nestedSections, publishes] = await Promise.all([
    loadNimbusConfig(),
    loadMountContext(),
    loadNestedLlmsSections(),
    publishedAgentUrls(),
  ]);
  return {
    site: options.site,
    base: options.base,
    title: options.title,
    ...(config.description ? { description: config.description } : {}),
    versions: mount.versions,
    routes: mount.routes,
    nestedSections,
    ...(capabilities.mcpUrl ? { mcpUrl: capabilities.mcpUrl } : {}),
    ...(manifest.absentSections ? { absentSections: manifest.absentSections } : {}),
    publishes,
    llms: publishes("/llms.txt"),
    llmsFull: publishes("/llms-full.txt"),
    apiVersions: Object.fromEntries(
      (config.api ?? [])
        .filter((entry) => entry.versions && entry.versions.length >= 2)
        .map((entry): [string, ApiVersionUrls] => {
          const fallback = entry.versions!.find((version) => version.default) ?? entry.versions![0]!;
          return [
            entry.collection,
            {
              mode: entry.versionUrl?.in === "query" ? "query" : "path",
              param: versionQueryParam(entry),
              defaultVersion: fallback.version,
              versions: entry.versions!.map((version) => version.version),
            },
          ];
        }),
    ),
  };
}

/** Whether the manifest says `reference` renders on request. */
export function rendersOnRequest(manifest: StagedAgentEndpointManifest, reference: LlmsEndpointReference): boolean {
  const flags = manifest.onRequest;
  if (!flags) return false;
  if (reference.surface === "full") return flags.llmsFull;
  return reference.scope === "site" ? flags.llms : flags.llmsSections;
}

/** A page's Markdown body: the baked twin's content, or the API page rendered now. */
async function pageMarkdown(manifest: StagedAgentEndpointManifest, page: LlmsPage, request?: Request): Promise<string> {
  countRender("page");
  const asset = manifest.markdownAssets.find(
    (candidate) => candidate.surface === "markdown" && candidate.collection === page.collection && candidate.id === page.id,
  );
  if (asset) {
    const body = await readStagedAsset(`_nimbus/agent-endpoint-assets/${asset.path}`, { request });
    return body.slice(asset.contentStart, asset.contentEnd);
  }
  const rendered = manifest.rendered.find((candidate) => candidate.collection === page.collection && candidate.id === page.id);
  if (rendered) {
    const { renderMarkdownDocument } = await import("./api/markdown-record.js");
    return (await renderMarkdownDocument(rendered, request)).content;
  }
  throw new Error(`nimbus-docs: no Markdown for "${page.collection}:${page.id}" to assemble llms-full.txt from.`);
}

// Assembled parts, per isolate: in-flight renders, shared by concurrent
// requests for one part, and completed bodies within a byte budget. A failed
// render is forgotten.
const PART_MEMO_BUDGET_BYTES = 64 * 1024 * 1024;
const inFlight = new Map<string, Promise<string>>();
const completed = new Map<string, { body: string; bytes: number }>();
let completedBytes = 0;
const utf8 = new TextEncoder();

function remember(key: string, body: string): void {
  const bytes = utf8.encode(body).length;
  // A body the whole budget can't hold is served, not kept.
  if (bytes > PART_MEMO_BUDGET_BYTES) return;
  const previous = completed.get(key);
  if (previous) completedBytes -= previous.bytes;
  completed.delete(key);
  completed.set(key, { body, bytes });
  completedBytes += bytes;
  // Evict the oldest completed bodies until the budget holds; the newest
  // stays even when it is larger than the budget alone.
  for (const [other, value] of completed) {
    if (completedBytes <= PART_MEMO_BUDGET_BYTES || other === key) break;
    completed.delete(other);
    completedBytes -= value.bytes;
  }
}

function memoized(key: string, render: () => Promise<string>): Promise<string> {
  // Dev re-renders every time: content and routes change under it.
  if (import.meta.env?.DEV) return render();
  const done = completed.get(key);
  if (done) return Promise.resolve(done.body);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = render().then(
    (body) => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
        remember(key, body);
      }
      return body;
    },
    (error: unknown) => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
      throw error;
    },
  );
  inFlight.set(key, promise);
  return promise;
}
// One part at a time per isolate: a part is the costly assembly, and two in
// flight would hold two parts' bodies at once.
let assembling: Promise<unknown> = Promise.resolve();

/** Runs `work` after every assembly already queued in this isolate. */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = assembling.then(work, work);
  // The tail holds no body: it only orders the next assembly.
  assembling = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The Cache API where the runtime has one (Workers on a custom domain); never required. */
async function cacheStorage(): Promise<Cache | undefined> {
  try {
    const storage = (globalThis as { caches?: { default?: Cache } }).caches;
    return storage?.default;
  } catch {
    return undefined;
  }
}

function cacheKey(manifest: StagedAgentEndpointManifest, site: string, key: string): Request {
  return new Request(`${new URL(site).origin}/_nimbus/llms-on-request/${manifest.buildId}/${encodeURIComponent(key)}`);
}

async function cached(manifest: StagedAgentEndpointManifest, site: string, key: string, render: () => Promise<string>): Promise<string> {
  return memoized(`${manifest.buildId}\0${key}`, async () => {
    const cache = await cacheStorage();
    const request = cacheKey(manifest, site, key);
    if (cache) {
      try {
        const hit = await cache.match(request);
        if (hit?.ok) return hit.text();
      } catch {}
    }
    const body = await queued(render);
    if (cache) {
      try {
        await cache.put(
          request,
          new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=31536000" } }),
        );
      } catch {}
    }
    return body;
  });
}

function findGroup(groups: readonly LlmsGroup[], slug: string): LlmsGroup | undefined {
  return flattenLlmsGroups(groups).find((group) => group.slug === slug);
}

/**
 * Render `reference` from the manifest's page list, or `null` when the
 * document does not exist (an unknown section, or a surface no route serves).
 */
export async function renderLlmsDocument(
  manifest: StagedAgentEndpointManifest,
  reference: LlmsEndpointReference,
  request?: Request,
): Promise<RenderedLlmsDocument | null> {
  const ctx = await documentContext(manifest);
  const pages = manifest.pages ?? [];
  let body: string | null;
  if (reference.surface === "index") {
    // The indexes list the pages they know; a historical version's pages are only in the parts.
    const { leaves, groups } = groupLlmsPages(pages.filter((page) => !page.historical), ctx);
    if (reference.scope === "site") {
      countRender("llms");
      // The full document's shape as the build decided it: parts when it
      // renders on request, else the baked split or the one file.
      body = siteIndexDocument(leaves, groups, ctx, manifest.fullSplit);
    } else {
      const group = findGroup(groups, reference.section);
      if (!group || !servesSectionIndex(group, ctx)) return null;
      countRender("section");
      body = sectionIndexDocument(group, ctx, nestedCollectionLinks(groups, ctx).get(group.slug));
    }
  } else {
    const fullPages = llmsFullPagesOf(pages, ctx);
    if (reference.scope === "site") {
      countRender("full");
      body = llmsFullPartsIndex(fullPages, ctx);
    } else {
      // Parts place a version's pages with the default's; see llmsPlacement.
      const { groups } = groupLlmsPages(fullPages, { ...ctx, nestedSections: true }, true);
      const search = request ? new URL(request.url).searchParams : new URLSearchParams();
      const identity = resolvePartIdentity(groups, reference.section, search, ctx);
      if (!identity) return null;
      const { group, version } = identity;
      // A version with no discoverable pages (a hidden one) has no part.
      if (partPages(group, version).length === 0) return null;
      body = await cached(manifest, ctx.site, `part:${group.slug}@${version ?? ""}`, async () => {
        countRender("part");
        return assembleLlmsFullPart(group, ctx, (page) => pageMarkdown(manifest, page, request), manifest.fullLimitBytes, version);
      });
    }
  }
  return { body, mediaType: "text/plain; charset=utf-8", digest: `sha256:${await sha256(body)}` };
}

/** Dev only: forget assembled parts after the content or routes change. */
export function resetLlmsOnRequest(): void {
  inFlight.clear();
  completed.clear();
  completedBytes = 0;
}
