import type { StagedAgentEndpointManifest } from "./agent-endpoint-assets.js";
import { createRequestClaims } from "./request-claims.js";
import { readStagedAsset } from "./staged-asset-reader.js";

let loaded: StagedAgentEndpointManifest | undefined;
// Concurrent first requests read the manifest once; see createRequestClaims.
const loading = createRequestClaims(30_000);

/** The agent-endpoint manifest: inlined in dev and prerender, read once per
 * isolate from the deployed assets in a server build. A failed read is retried. */
export async function loadAgentEndpointManifest(
  request?: Request,
): Promise<StagedAgentEndpointManifest> {
  while (!loaded && loading.size) await loading.released();
  if (loaded) return loaded;
  const claim = loading.claim("manifest");
  try {
    const module = await import("virtual:nimbus/agent-endpoint-assets");
    loaded =
      module.manifest ??
      (JSON.parse(
        await readStagedAsset("_nimbus/agent-endpoint-assets/manifest.json", { request }),
      ) as StagedAgentEndpointManifest);
    return loaded;
  } finally {
    claim.release();
  }
}
