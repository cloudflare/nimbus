import type { APIRoute } from "astro";
import { options } from "virtual:nimbus/agent-capabilities";
import type { MarkdownEndpointAsset } from "../agent-endpoint-assets.js";
import { loadAgentEndpointManifest } from "../agent-endpoint-manifest.js";
import type { RenderedMarkdownPage } from "../api/markdown-record.js";

const renderedMarkdownPath = (page: RenderedMarkdownPage) => {
  const route = page.url.split("?")[0]!.replace(/\/+$/u, "");
  return route === "" ? "/index.md" : `${route}/index.md`;
};
import { readStagedAsset } from "../staged-asset-reader.js";
import { cachedPerOrigin, createDocsMcpHandler, type DocsMcpHandler } from "./handler.js";
import type { McpPageIndex } from "./page-index.js";

export const prerender = false;

const ASSET_PREFIX = "_nimbus/agent-endpoint-assets/";
const markdownByPath = cachedPerOrigin(async (request): Promise<Map<string, MarkdownEndpointAsset>> => {
  const { markdownAssets } = await loadAgentEndpointManifest(request);
  return new Map(
    markdownAssets
      .filter((asset) => asset.surface === "markdown")
      .map((asset) => [asset.url, asset] as const),
  );
});
// Request-rendered API pages, by the `.md` path their index record names.
const renderedByPath = cachedPerOrigin(async (request): Promise<Map<string, RenderedMarkdownPage>> => {
  const { rendered = [] } = await loadAgentEndpointManifest(request);
  // A historical version's page shares its path with the default's; only the default answers by path.
  return new Map(rendered.filter((page) => !page.historical).map((page) => [renderedMarkdownPath(page), page] as const));
});
let handler: DocsMcpHandler | undefined;

export const ALL: APIRoute = ({ request }) => {
  handler ??= createDocsMcpHandler({
    identity: options.mcp!,
    base: options.base,
    source: {
      readIndex: cachedPerOrigin(async (request) => {
        const { pageIndex } = await loadAgentEndpointManifest(request);
        return JSON.parse(await readStagedAsset(`${ASSET_PREFIX}${pageIndex!.path}`, { request })) as McpPageIndex;
      }),
      async readPage(record, request) {
        const asset = (await markdownByPath(request)).get(record.markdownPath);
        if (asset) {
          const body = await readStagedAsset(`${ASSET_PREFIX}${asset.path}`, { request });
          return body.slice(asset.contentStart, asset.contentEnd);
        }
        // A request-rendered API page: the same content the `.md` route serves.
        const rendered = (await renderedByPath(request)).get(record.markdownPath);
        if (!rendered) return null;
        const { renderMarkdownDocument } = await import("../api/markdown-record.js");
        return (await renderMarkdownDocument(rendered, request)).content;
      },
    },
  });
  return handler.fetch(request);
};
