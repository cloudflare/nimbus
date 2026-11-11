/**
 * The runtime's view of which agent URLs the site's routes serve, read from
 * `virtual:nimbus/markdown-routes`. Where that module isn't available (a
 * test importing the runtime outside Vite), every URL counts as served, which
 * is what a site with every starter route gets.
 */

import { publishesAgentUrl } from "./agent-surfaces.js";

let predicate: Promise<(url: string) => boolean> | undefined;

/**
 * Whether a route of the site serves an agent URL: a page's `.md` or `.mdx`,
 * an `llms.txt`, `llms-full.txt` (site-relative, base-free).
 */
export function publishedAgentUrls(): Promise<(url: string) => boolean> {
  const load = () =>
    import("virtual:nimbus/markdown-routes")
      .then(({ routes }) => (url: string) => publishesAgentUrl(routes, url))
      .catch((error: unknown) => {
        // Only Node's own loader refusing the `virtual:` scheme (a runtime
        // outside Vite) falls back; any other failure is the site's to see.
        if (!unresolvableVirtualModule(error)) throw error;
        return () => true;
      });
  // Dev re-resolves routes when a page file is added or removed; read them each time.
  if (import.meta.env?.DEV) return load();
  predicate ??= load();
  return predicate;
}

/**
 * Node's default ESM loader rejecting the `virtual:` scheme: the one failure
 * that means the runtime runs outside the integration (a test on Node).
 */
export function unresolvableVirtualModule(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === "ERR_UNSUPPORTED_ESM_URL_SCHEME" && typeof message === "string" && message.includes("'virtual:'");
}

/** Dev only: forget the routes after they change. */
export function resetPublishedAgentUrls(): void {
  predicate = undefined;
}
