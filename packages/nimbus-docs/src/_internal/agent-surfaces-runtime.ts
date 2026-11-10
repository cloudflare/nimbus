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
        // Only a runtime with no resolver for the virtual module (Node outside
        // Vite) falls back; a module that resolved and failed is a real error.
        if (!unresolvableModule(error)) throw error;
        return () => true;
      });
  // Dev re-resolves routes when a page file is added or removed; read them each time.
  if (import.meta.env?.DEV) return load();
  predicate ??= load();
  return predicate;
}

function unresolvableModule(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME" || code === "ERR_UNKNOWN_FILE_EXTENSION")
    return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot find (?:module|package)|Failed to (?:resolve|load)|Unknown (?:file extension|scheme)|Only URLs with a scheme/iu.test(message);
}

/** Dev only: forget the routes after they change. */
export function resetPublishedAgentUrls(): void {
  predicate = undefined;
}
