import type { APIRoute } from "astro";
import { options } from "virtual:nimbus/agent-capabilities";
import type { MarkdownEndpointAsset } from "../agent-endpoint-assets.js";
import { loadAgentEndpointManifest } from "../agent-endpoint-manifest.js";
import {
  renderMarkdownDocument,
  renderedMarkdownPath,
  type RenderedMarkdownPage,
} from "../api/markdown-record.js";
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
  return new Map(rendered.map((page) => [renderedMarkdownPath(page), page] as const));
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
        return rendered ? (await renderMarkdownDocument(rendered, request)).content : null;
      },
    },
  });
  return handler.fetch(request);
};
