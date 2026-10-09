/**
 * `true` when an entry belongs on machine discovery surfaces. `noindex: true`
 * drops a page from `/llms.txt`, per-section `llms.txt`, the `/llms-full.txt`
 * full documentation, on-site search, and the sitemap while keeping it addressable
 * (`.md`/HTML resolve) and navigable (sidebar, breadcrumbs, prev/next).
 */
export function isDiscoverable(entry: { data?: unknown }): boolean {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  return data.noindex !== true;
}
