/**
 * The agent documents made on request: `/llms.txt`, a section's `llms.txt`,
 * `/llms-full.txt` as an index of parts, and each part, from the page list
 * the build put in the manifest, through the same functions the bake uses.
 * A part's page bodies are the baked docs twins' content and request-
 * rendered API pages' Markdown. Parts are kept per isolate once assembled,
 * and in the Cache API where there is one; both are best effort.
 */

import type { LlmsEndpointReference } from "../agent-endpoints.js";
import type { StagedAgentEndpointManifest } from "./agent-endpoint-assets.js";
import { readStagedAsset } from "./staged-asset-reader.js";
import { renderMarkdownDocument } from "./api/markdown-record.js";
import {
  flattenLlmsGroups,
  groupLlmsPages,
  llmsFullPagesOf,
  llmsFullPart,
  llmsFullPartsIndex,
  nestedCollectionLinks,
  sectionIndexDocument,
  servesSectionIndex,
  siteIndexDocument,
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
  const [{ options, capabilities }, { loadNimbusConfig, loadMountContext, loadNestedLlmsSections }, { publishedAgentUrls }] =
    await Promise.all([
      import("virtual:nimbus/agent-capabilities"),
      import("./runtime-config.js"),
      import("./agent-surfaces-runtime.js"),
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
  };
}

/** The pages the manifest lists, or none when no document renders on request. */
function pagesOf(manifest: StagedAgentEndpointManifest): readonly LlmsPage[] {
  return manifest.pages ?? [];
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
  const asset = manifest.markdownAssets.find(
    (candidate) => candidate.surface === "markdown" && candidate.collection === page.collection && candidate.id === page.id,
  );
  if (asset) {
    const body = await readStagedAsset(`_nimbus/agent-endpoint-assets/${asset.path}`, { request });
    return body.slice(asset.contentStart, asset.contentEnd);
  }
  const rendered = manifest.rendered.find((candidate) => candidate.collection === page.collection && candidate.id === page.id);
  if (rendered) return (await renderMarkdownDocument(rendered, request)).content;
  throw new Error(`nimbus-docs: no Markdown for "${page.collection}:${page.id}" to assemble llms-full.txt from.`);
}

// Assembled parts, per isolate: the in-flight promise doubles as the memo,
// so concurrent requests for one part share a render. Bounded; a failed
// render is forgotten.
const PART_MEMO_LIMIT = 32;
const parts = new Map<string, Promise<string>>();

function memoized(key: string, render: () => Promise<string>): Promise<string> {
  // Dev re-renders every time: content and routes change under it.
  if (import.meta.env?.DEV) return render();
  const existing = parts.get(key);
  if (existing) return existing;
  const promise = render().catch((error) => {
    parts.delete(key);
    throw error;
  });
  parts.set(key, promise);
  if (parts.size > PART_MEMO_LIMIT) parts.delete(parts.keys().next().value!);
  return promise;
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
    const body = await render();
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
  const pages = pagesOf(manifest);
  let body: string | null;
  if (reference.surface === "index") {
    const { leaves, groups } = groupLlmsPages(pages, ctx);
    if (reference.scope === "site") {
      countRender("llms");
      // On a request-rendered site the full document is always an index of parts.
      body = siteIndexDocument(leaves, groups, ctx, true);
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
      const { groups } = groupLlmsPages(fullPages, { ...ctx, nestedSections: true });
      const group = findGroup(groups, reference.section);
      if (!group) return null;
      body = await cached(manifest, ctx.site, `part:${group.slug}`, async () => {
        countRender("part");
        const bodies = new Map<LlmsPage, string>();
        // Bodies one at a time: a part is assembled whole before it is sent,
        // and one isolate assembles one part at a time.
        for (const page of flattenPages(group)) bodies.set(page, await pageMarkdown(manifest, page, request));
        return llmsFullPart(group, ctx, (page) => bodies.get(page)!);
      });
    }
  }
  return { body, mediaType: "text/plain; charset=utf-8", digest: `sha256:${await sha256(body)}` };
}

function flattenPages(group: LlmsGroup): LlmsPage[] {
  return [...group.members, ...group.children.flatMap(flattenPages)];
}

/** Dev only: forget assembled parts after the content or routes change. */
export function resetLlmsOnRequest(): void {
  parts.clear();
}
