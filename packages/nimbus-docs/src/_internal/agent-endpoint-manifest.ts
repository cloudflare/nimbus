import type { StagedAgentEndpointManifest } from "./agent-endpoint-assets.js";
import { readStagedAsset } from "./staged-asset-reader.js";

let loading: Promise<StagedAgentEndpointManifest> | undefined;

/** The agent-endpoint manifest: inlined in dev and prerender, read once per
 * isolate from the deployed assets in a server build. */
export function loadAgentEndpointManifest(
  request?: Request,
): Promise<StagedAgentEndpointManifest> {
  loading ??= import("virtual:nimbus/agent-endpoint-assets").then(async (module) => {
    if (module.manifest) return module.manifest;
    return JSON.parse(
      await readStagedAsset("_nimbus/agent-endpoint-assets/manifest.json", { request }),
    ) as StagedAgentEndpointManifest;
  });
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
