import type { APIRoute } from "astro";
import { options } from "virtual:nimbus/agent-capabilities";
import type { MarkdownEndpointAsset } from "../agent-endpoint-assets.js";
import { loadAgentEndpointManifest } from "../agent-endpoint-manifest.js";
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
        if (!asset) return null;
        const body = await readStagedAsset(`${ASSET_PREFIX}${asset.path}`, { request });
        return body.slice(asset.contentStart, asset.contentEnd);
      },
    },
  });
  return handler.fetch(request);
};
