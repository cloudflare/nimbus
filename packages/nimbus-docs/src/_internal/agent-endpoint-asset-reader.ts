import type {
  MarkdownEndpointPayload,
  MarkdownEndpointReference,
} from "../agent-endpoints.js";
import type { RenderedMarkdownPage } from "./api/markdown-record.js";

type MarkdownEndpointAssetReader = (
  root: URL | string,
  reference: MarkdownEndpointReference,
) => Promise<MarkdownEndpointPayload>;

type RenderedMarkdownPageReader = (
  root: URL | string,
  reference: Pick<MarkdownEndpointReference, "collection" | "id">,
) => Promise<RenderedMarkdownPage | undefined>;

interface AgentEndpointAssetReaderState {
  version: 1;
  readMarkdownEndpointPayload?: MarkdownEndpointAssetReader;
  readRenderedMarkdownPage?: RenderedMarkdownPageReader;
}

const STATE_KEY = Symbol.for(
  "@cloudflare/nimbus-docs/agent-endpoint-asset-reader/v1",
);
const stateGlobal = globalThis as typeof globalThis & {
  [STATE_KEY]?: AgentEndpointAssetReaderState;
};
const state = (stateGlobal[STATE_KEY] ??= { version: 1 });

export function registerAgentEndpointAssetReader(
  reader: MarkdownEndpointAssetReader,
  rendered?: RenderedMarkdownPageReader,
): void {
  state.readMarkdownEndpointPayload = reader;
  state.readRenderedMarkdownPage = rendered;
}

/** The build's description of an API page whose Markdown renders on request, if it is one. */
export function readConfiguredRenderedMarkdownPage(
  root: URL | string,
  reference: Pick<MarkdownEndpointReference, "collection" | "id">,
): Promise<RenderedMarkdownPage | undefined> {
  if (!state.readRenderedMarkdownPage) {
    throw new Error(
      "nimbus-docs: agent-endpoint assets are available only during a configured Astro build or dev server.",
    );
  }
  return state.readRenderedMarkdownPage(root, reference);
}

export function readConfiguredMarkdownEndpointPayload(
  root: URL | string,
  reference: MarkdownEndpointReference,
): Promise<MarkdownEndpointPayload> {
  if (!state.readMarkdownEndpointPayload) {
    throw new Error(
      "nimbus-docs: agent-endpoint assets are available only during a configured Astro build or dev server.",
    );
  }
  return state.readMarkdownEndpointPayload(root, reference);
}
