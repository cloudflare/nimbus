import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { markdownToHtml } from "satteri";

/**
 * Render a CommonMark string to a SANITIZED HTML fragment.
 *
 * One-correct-answer plumbing: OpenAPI `description` fields are CommonMark, and
 * the view-model deliberately carries them RAW (the `.md` version re-emits them as
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
 * with the GitHub-flavored `defaultSchema`) before it ever reaches the page. A tag
 * the schema doesn't know, like the `<key>` in `metadata.<key>`, stays as text.
 *
 * Resilient by contract: empty/whitespace input yields `""`, and a renderer
 * failure degrades to the escaped source text rather than aborting the build.
 */
// API pages repeat the same descriptions across many fields and operations,
// and rendering is pure, so each distinct source renders once per process.
const rendered = new Map<string, string>();
let renderedBytes = 0;
const RENDERED_MEMO_BYTES = 16 * 1024 * 1024;

export function renderMarkdown(source: string | undefined | null): string {
  if (!source) return "";
  const trimmed = source.trim();
  if (!trimmed) return "";
  const hit = rendered.get(trimmed);
  if (hit !== undefined) return hit;
  const html = render(trimmed);
  rendered.set(trimmed, html);
  renderedBytes += trimmed.length + html.length;
  for (const [oldest, value] of rendered) {
    if (renderedBytes <= RENDERED_MEMO_BYTES) break;
    rendered.delete(oldest);
    renderedBytes -= oldest.length + value.length;
  }
  return html;
}

function render(trimmed: string): string {
  try {
    const raw = markdownToHtml(trimmed).html;
    const tree = fromHtml(raw, { fragment: true, verbose: true });
    tree.children = unknownTagsAsText(tree.children, raw);
    return toHtml(sanitize(tree, defaultSchema));
  } catch {
    return `<p>${escapeHtml(trimmed)}</p>`;
  }
}

const knownTags = new Set([...(defaultSchema.tagNames ?? []), ...(defaultSchema.strip ?? [])]);

type Node = ReturnType<typeof fromHtml>["children"][number];
type Span = { start: { offset?: number }; end: { offset?: number } };

function unknownTagsAsText(nodes: Node[], raw: string): Node[] {
  return nodes.flatMap((node): Node[] => {
    if (node.type !== "element") return [node];
    if (knownTags.has(node.tagName)) return [{ ...node, children: unknownTagsAsText(node.children, raw) } as Node];
    const children = unknownTagsAsText(node.content?.children ?? node.children, raw);
    const { opening, closing } = (node.data as { position?: { opening?: Span; closing?: Span } } | undefined)
      ?.position ?? {};
    return [...sourceText(raw, opening), ...children, ...sourceText(raw, closing)];
  });
}

function sourceText(raw: string, span: Span | undefined): Node[] {
  if (span?.start.offset === undefined || span.end.offset === undefined) return [];
  return [{ type: "text", value: raw.slice(span.start.offset, span.end.offset) }];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
