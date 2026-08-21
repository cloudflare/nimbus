import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { markdownToHtml } from "satteri";

/**
 * Render a CommonMark string to a SANITIZED HTML fragment.
 *
 * One-correct-answer plumbing: OpenAPI `description` fields are CommonMark, and
 * the view-model deliberately carries them RAW (the `.md` twin re-emits them as
 * markdown). The HTML page therefore renders them here, at the taste layer, via
 * `set:html`. This lives in the framework because turning CommonMark into HTML —
 * safely — has exactly one right answer; where and how the result is styled does
 * not.
 *
 * Security by contract: `set:html` bypasses Astro's auto-escaping, and OpenAPI
 * specs are untrusted third-party input (we render docs for APIs we do not own).
 * Sätteri emits raw HTML verbatim, so a hostile description could otherwise bake
 * `<script>`/`onerror`/`javascript:` into the static site (stored XSS). The
 * markdown output is passed through a parser-based allowlist (`hast-util-sanitize`
 * with the GitHub-flavored `defaultSchema`) before it ever reaches the page.
 *
 * Resilient by contract: empty/whitespace input yields `""`, and a renderer
 * failure degrades to the escaped source text rather than aborting the build.
 */
export function renderMarkdown(source: string | undefined | null): string {
  if (!source) return "";
  const trimmed = source.trim();
  if (!trimmed) return "";
  try {
    const raw = markdownToHtml(trimmed).html;
    return toHtml(sanitize(fromHtml(raw, { fragment: true }), defaultSchema));
  } catch {
    return `<p>${escapeHtml(trimmed)}</p>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
