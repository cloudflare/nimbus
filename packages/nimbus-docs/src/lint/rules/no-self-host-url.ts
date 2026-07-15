/**
 * nimbus/no-self-host-url — same-site links should be root-relative
 * (`/page`), not absolute URLs at the site's own host. Absolute self-host
 * links break across environments (preview vs production) and skip the
 * router.
 *
 * The project's `site` URL (from `nimbusConfig.site`, threaded through
 * `ctx.site`) is always banned — the rule infers the deploy host
 * automatically so authors don't have to duplicate it in their lint
 * config. Localhost/loopback hosts are always banned too. Additional
 * hosts go in `hosts?: string[]` (e.g. legacy domains, www subdomains
 * that don't redirect, or staging hostnames).
 */

import { collect, startOf } from "../parse.js";
import type { Rule } from "../rule.js";

const ALWAYS_BANNED = ["localhost", "127.0.0.1", "0.0.0.0"];

export const noSelfHostUrl: Rule = {
  code: "nimbus/no-self-host-url",
  run(ctx) {
    const configured = Array.isArray(ctx.options.hosts)
      ? ctx.options.hosts.filter((h): h is string => typeof h === "string")
      : [];
    const siteHost = hostnameOf(ctx.site);
    const banned = [
      ...ALWAYS_BANNED,
      ...(siteHost ? [siteHost] : []),
      ...configured,
    ];

    for (const link of collect(ctx.file.tree, "link")) {
      const url = typeof link.url === "string" ? link.url : "";
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        continue; // relative or non-URL — fine
      }
      const hit = banned.some(
        (b) => hostname === b || hostname.endsWith(`.${b}`),
      );
      if (!hit) continue;

      const at = startOf(link);
      ctx.report({
        message: `link points at self-host "${hostname}" — use a root-relative path (e.g. /page) for same-site links.`,
        line: at.line,
        column: at.column,
      });
    }
  },
};

/** Extract a bare hostname from a `site`-shaped value, or null if not parseable. */
function hostnameOf(site: string | undefined): string | null {
  if (!site) return null;
  try {
    return new URL(site).hostname;
  } catch {
    return null;
  }
}
