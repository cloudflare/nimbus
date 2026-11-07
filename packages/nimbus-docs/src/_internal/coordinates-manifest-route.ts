/**
 * `/nimbus-api/coordinates.json`: this site's published coordinate manifest,
 * fetched by other sites that cite its APIs via `apiReferences[]`. Served on
 * every site (an empty manifest without `api`), unless the project serves the
 * path itself.
 */
import { loadCoordinatesManifest } from "./api/load-citation-index.js";

export const prerender = true;

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify(await loadCoordinatesManifest()), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Adapter-dependent for static output; set CDN cache policy at the host.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
