import { collectionMountPrefix } from "./collection-mount.js";
import {
  requestInventoryEntryUrl,
  requestInventoryVersionStatusKey,
  type RequestRouteInventoryEntry,
} from "./request-route-url.js";
import {
  loadApiCollections,
  loadRequestRenderingCollections,
  loadNimbusConfig,
} from "./runtime-config.js";
import {
  getIndexedEntries,
  getVersionStatus,
  renderIndexedEntryMarkdown,
} from "../runtime.js";
import { getPreparedTwinArtifact } from "../build.js";

export const prerender = true;

export async function GET() {
  const config = await loadNimbusConfig();
  const requestCollections = new Set(await loadRequestRenderingCollections());
  const apiCollections = new Set(await loadApiCollections());
  const entries = await getIndexedEntries();
  const versions = config.versions
    ? { others: config.versions.others ?? [] }
    : null;
  const routes: RequestRouteInventoryEntry[] = [];

  for (const item of entries) {
    const collection = item.collection;
    const prefix = collectionMountPrefix(collection, versions);
    const data = (item.entry.data ?? {}) as Record<string, unknown>;
    const versionStatus = await getVersionStatus(
      requestInventoryVersionStatusKey(
        collection,
        apiCollections.has(collection),
        item.version,
      ),
    );
    const discoverable = data.noindex !== true && !versionStatus?.isHidden;
    const searchable =
      !versionStatus?.isHidden &&
      (data.searchable === true ||
        (data.searchable !== false && data.noindex !== true));
    const route: RequestRouteInventoryEntry = {
      collection,
      url: requestInventoryEntryUrl(
        prefix,
        item.entry.id,
        apiCollections.has(collection),
      ),
      request: requestCollections.has(collection),
      discoverable,
      searchable,
      title: item.title,
      language: (config.locale ?? "en").split("-")[0]!,
    };
    if (item.description) route.description = item.description;
    if (item.version) route.version = item.version;
    if (versionStatus?.isDeprecated) route.deprecated = true;
    if (route.request && searchable) {
      route.content = apiCollections.has(collection)
        ? await renderIndexedEntryMarkdown(item)
        : (
            await getPreparedTwinArtifact({
              collection,
              id: item.entry.id,
              surface: "markdown",
            })
          ).content;
    }
    routes.push(route);
  }

  return new Response(JSON.stringify(routes), {
    headers: { "Content-Type": "application/json" },
  });
}
