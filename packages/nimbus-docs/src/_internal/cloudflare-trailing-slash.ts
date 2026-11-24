import fs from "node:fs";
import path from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

/**
 * Cloudflare's default `html_handling` serves `/page.html` at `/page` and
 * redirects `/page/` there. A static site that writes `page.html` files but
 * links `/page/` (`trailingSlash: "always"`) then redirects every link.
 * Returns the warning, or `null` when the site isn't in that state.
 */
export function cloudflareTrailingSlashWarning(
  root: string,
  config: { output: string; trailingSlash: string; format: string | undefined },
): string | null {
  if (config.output !== "static" || config.trailingSlash !== "always" || config.format !== "file") {
    return null;
  }
  const file = ["wrangler.jsonc", "wrangler.json"].find((name) => fs.existsSync(path.join(root, name)));
  if (!file) return null;
  let parsed: { assets?: { html_handling?: unknown } } | undefined;
  try {
    parsed = parseJsonc(fs.readFileSync(path.join(root, file), "utf8")) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed?.assets?.html_handling === "force-trailing-slash") return null;
  return (
    `With trailingSlash: "always" and build.format: "file", Cloudflare redirects every /page/ link to /page (a 307). ` +
    `Set "assets": { "html_handling": "force-trailing-slash" } in ${file}.`
  );
}

/** The compatibility date from which Workers pass the request's abort signal by default. */
export const REQUEST_SIGNAL_DATE = "2026-11-17";

/**
 * Try it's proxy cancels the API request when the reader stops or leaves, but
 * only where the runtime passes the incoming request's abort signal: on
 * Workers, from the compatibility date above or with `enable_request_signal`,
 * and not with `disable_request_signal`. Returns the warning, or `null`.
 */
export function cloudflareRequestSignalWarning(root: string): string | null {
  const file = ["wrangler.jsonc", "wrangler.json"].find((name) => fs.existsSync(path.join(root, name)));
  if (!file) return null;
  let parsed: { compatibility_date?: unknown; compatibility_flags?: unknown } | undefined;
  try {
    parsed = parseJsonc(fs.readFileSync(path.join(root, file), "utf8")) as typeof parsed;
  } catch {
    return null;
  }
  const flags = Array.isArray(parsed?.compatibility_flags) ? parsed.compatibility_flags : [];
  const date = typeof parsed?.compatibility_date === "string" ? parsed.compatibility_date : "";
  const passes = !flags.includes("disable_request_signal") && (flags.includes("enable_request_signal") || date >= REQUEST_SIGNAL_DATE);
  if (passes) return null;
  return (
    `Try it's proxy can't cancel a request to the API when a reader stops or leaves: Workers don't pass it the request's abort signal. ` +
    `Add "enable_request_signal" to compatibility_flags in ${file} (and remove "disable_request_signal" if it's there), ` +
    `or set compatibility_date to ${REQUEST_SIGNAL_DATE} or later. Until then the API request runs until the proxy's deadline.`
  );
}
