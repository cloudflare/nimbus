import type {
  MarkdownEndpointPayload,
  MarkdownEndpointReference,
} from "../agent-endpoints.js";

type MarkdownEndpointAssetReader = (
  root: URL | string,
  reference: MarkdownEndpointReference,
) => Promise<MarkdownEndpointPayload>;

interface AgentEndpointAssetReaderState {
  version: 1;
  readMarkdownEndpointPayload?: MarkdownEndpointAssetReader;
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
): void {
  state.readMarkdownEndpointPayload = reader;
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
