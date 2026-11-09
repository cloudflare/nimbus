import { collectionMountPrefix } from "./collection-mount.js";
import { isSearchable } from "./discoverability.js";
import {
  contentInventoryEntryUrl,
  requestInventoryVersionStatusKey,
  type RequestRouteInventoryEntry,
} from "./request-route-url.js";
import {
  loadApiCollections,
  loadMountContext,
  loadRequestRenderingCollections,
  loadNimbusConfig,
} from "./runtime-config.js";
import { getIndexedEntries, getVersionStatus, renderIndexedEntryMarkdown } from "../runtime.js";
import {
  readConfiguredMarkdownEndpointPayload,
  readConfiguredRenderedMarkdownPage,
} from "./agent-endpoint-asset-reader.js";
import { renderMarkdownDocument } from "./api/markdown-record.js";

export const prerender = true;

export async function GET() {
  const projectRoot: unknown = import.meta.env.NIMBUS_PROJECT_ROOT;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error(
      "nimbus-docs: request route inventory requires the Nimbus Astro integration.",
    );
  }
  const config = await loadNimbusConfig();
  const requestCollections = new Set(await loadRequestRenderingCollections());
  const apiCollections = new Set(await loadApiCollections());
  const entries = await getIndexedEntries();
  const mountContext = await loadMountContext();
  const routes: RequestRouteInventoryEntry[] = [];

  for (const item of entries) {
    const collection = item.collection;
    const prefix = collectionMountPrefix(collection, mountContext);
    const data = (item.entry.data ?? {}) as Record<string, unknown>;
    const request = requestCollections.has(collection);
    const versionStatus = await getVersionStatus(
      requestInventoryVersionStatusKey(
        collection,
        apiCollections.has(collection),
        item.version,
      ),
    );
    const discoverable = data.noindex !== true && !versionStatus?.isHidden;
    const searchable = !versionStatus?.isHidden && isSearchable(item.entry);
    const route: RequestRouteInventoryEntry = {
      collection,
      url: contentInventoryEntryUrl(
        prefix,
        item.entry.id,
        request,
      ),
      request,
      discoverable,
      searchable,
      title: item.title,
      language: (config.locale ?? "en").split("-")[0]!,
    };
    if (item.description) route.description = item.description;
    if (item.version) route.version = item.version;
    if (versionStatus?.isDeprecated) route.deprecated = true;
    if (route.request && searchable) {
      // The baked body when the build has one; otherwise rendered here, in
      // the build, where every renderer runs (a site whose routes publish no
      // page Markdown bakes none).
      route.content = await pageText(projectRoot, collection, item);
    }
    routes.push(route);
  }

  return new Response(JSON.stringify(routes), {
    headers: { "Content-Type": "application/json" },
  });
}

async function pageText(
  projectRoot: string,
  collection: string,
  item: Awaited<ReturnType<typeof getIndexedEntries>>[number],
): Promise<string> {
  try {
    return (
      await readConfiguredMarkdownEndpointPayload(projectRoot, {
        collection,
        id: item.entry.id,
        surface: "markdown",
      })
    ).content;
  } catch {
    // Not baked: an API page that renders on request takes the serialization
    // the route uses, so the search text is the content the `.md` carries.
    const page = await readConfiguredRenderedMarkdownPage(projectRoot, { collection, id: item.entry.id });
    if (page) return (await renderMarkdownDocument(page)).content;
    return renderIndexedEntryMarkdown(item);
  }
}
