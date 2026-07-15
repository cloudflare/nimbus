/**
 * Admonition transform — rewrites `:::type[title]\n...\n:::` fenced
 * directives to `<Aside type="..." title="...">...</Aside>` in MDX source
 * before the markdown compiler sees the file.
 *
 * Runs as a Vite plugin transform (a content pass) rather than a remark
 * plugin so it survives the `markdown.processor` swap that disables
 * remark plugins under Sätteri. Same architectural reason as
 * `validate-mdx-content.ts` — see that file's header for the long form.
 *
 * Recognised syntaxes (MyST / Docusaurus parity):
 *
 *   Block, no title:
 *     :::note
 *     Body paragraph one.
 *
 *     Body paragraph two.
 *     :::
 *
 *   Block with bracketed title:
 *     :::warning[Be careful]
 *     Body text.
 *     :::
 *
 *   Inline (single line):
 *     :::note If you already have a Worker, skip to step 3. :::
 *     :::note[Tip: …] To simulate latency, set your DB region. :::
 *
 * Type mapping (MyST extra types fold into Nimbus's 4 Aside slots):
 *   note, info             → note
 *   tip                    → tip
 *   caution, warning, important → caution
 *   danger                 → danger
 *
 * Aside availability: the user's `src/components.ts` must expose `Aside`
 * (the default starter does). If it doesn't, the post-transform MDX
 * compile will fail with "unknown component Aside" — which the existing
 * `validate-mdx-content.ts` validator already surfaces as a clean build
 * error pointing the user at the registry file.
 *
 * Indentation: a directive nested inside indented JSX (e.g. `:::note` inside
 * a `<TabItem>`) emits an `<Aside>` re-indented to the directive's own column,
 * and its body is dedented to a common baseline then re-prefixed with that
 * indent (so nested structure survives without becoming a code block). This is
 * load-bearing — a flush-left `<Aside>` dedents out of the enclosing element
 * and `@mdx-js/mdx` rejects the orphaned tag ("Expected a closing tag").
 *
 * What this does NOT handle:
 *   - Nested admonitions with extra colons (`::::note … :::sub … ::: ::::`).
 *     Rare in practice; would need a counted-colon parser.
 *   - Admonitions inside fenced code blocks. Code blocks are stashed
 *     before the regex runs, so `\`\`\` :::note … ::: \`\`\`` is preserved
 *     verbatim.
 *   - Malformed bodies where a line is indented *less* than the directive
 *     itself. The common-baseline dedent keys on the shallowest body line, so
 *     a body line dedented past the opener pushes its siblings into extra
 *     relative indentation (possibly a code block). Author content with the
 *     body indented at least as far as the `:::` opener.
 */

export interface AdmonitionTransformOptions {
  /**
   * Extra type aliases on top of the built-in MyST set. Useful if the
   * upstream content uses product-specific synonyms — `{ heads: "tip" }`
   * would map `:::heads` → `<Aside type="tip">`.
   */
  typeAliases?: Record<string, AsideType>;
}

export type AsideType = "note" | "tip" | "caution" | "danger";

/** Built-in MyST / Docusaurus admonition types and their Aside mapping. */
const BUILTIN_TYPES: Record<string, AsideType> = {
  note: "note",
  info: "note",
  tip: "tip",
  caution: "caution",
  warning: "caution",
  important: "caution",
  danger: "danger",
};

/**
 * Transform a single MDX source string. Idempotent — running the
 * transform twice produces the same output as running it once.
 */
export function transformAdmonitions(
  source: string,
  options: AdmonitionTransformOptions = {},
): string {
  const typeMap = { ...BUILTIN_TYPES, ...(options.typeAliases ?? {}) };

  // 1. Split frontmatter so we never rewrite YAML keys (e.g. `tip: …`).
  const { frontmatter, body, bodyOffset: _ } = splitFrontmatter(source);

  // 2. Stash fenced code blocks (``` and ~~~) so `:::` inside code samples
  //    is preserved verbatim. Indented code blocks are rare in MDX; we
  //    leave them alone (the `:::` token has to be flush-left to match
  //    anyway, and indented code requires a 4-space prefix).
  const { stashed, restore } = stashCodeBlocks(body);

  // 3. Run the rewrite.
  const rewritten = stashed.replace(
    ADMONITION_PATTERN,
    (match, rawIndent, rawType, rawTitle, rawContent) => {
      const type = String(rawType).toLowerCase();
      const aside = typeMap[type];
      if (!aside) {
        // Unknown directive — leave it alone. Users may have other `:::foo`
        // patterns (custom containers, etc.); silently swallowing them
        // would be worse than the existing literal-text rendering.
        return match;
      }
      const indent = typeof rawIndent === "string" ? rawIndent : "";
      const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
      const titleAttr = title ? ` title=${JSON.stringify(title)}` : "";

      // Re-indent the body to the directive's own indentation. A directive
      // nested inside indented JSX (e.g. `:::note` inside a `<TabItem>`)
      // must emit an `<Aside>` at the SAME indentation — emitting it
      // flush-left dedents out of the enclosing element and orphans its
      // closing tag, which the stricter Sätteri MDX parser rejects
      // ("Expected a closing tag for <TabItem>"). Content is dedented to a
      // common baseline first so relative structure (lists, nested JSX) is
      // preserved, then re-prefixed with the directive's indent.
      const body = reindentBody(String(rawContent), indent);

      // MDX requires blank lines around block components so the markdown
      // parser doesn't pull surrounding paragraphs inside the JSX.
      return `\n\n${indent}<Aside type="${aside}"${titleAttr}>\n\n${body}\n\n${indent}</Aside>\n\n`;
    },
  );

  // 4. Restore the stashed code blocks.
  const restored = restore(rewritten);

  return frontmatter + restored;
}

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

/**
 * Match `:::type[optional title] body :::` with non-greedy body.
 *
 * Components:
 *   - `^([ \t]*)`     leading indentation of the opener line (captured) so the
 *                      emitted `<Aside>` can be re-indented to the same depth —
 *                      load-bearing for directives nested inside indented JSX
 *                      (e.g. `:::note` inside a `<TabItem>`). The `m` flag makes
 *                      `^`/`$` match line boundaries. Line-anchoring also stops
 *                      a stray mid-line `:::` from being treated as an opener.
 *   - `:::`           literal opener
 *   - `([a-zA-Z]+)`   type token (captured, case-insensitive lookup at use site)
 *   - `(?:\[(...)\])?` optional bracketed title; brackets stripped from capture
 *   - `\n|[ \t]+`     at least one whitespace before content (avoids matching
 *                      `:::foo:::` directly)
 *   - `([\s\S]*?)`    non-greedy body, may span newlines
 *   - `\n?[ \t]*:::[ \t]*$`  closer, possibly indented, at end of its line
 *
 * Non-greedy body + global flag means adjacent admonitions don't merge
 * (the engine finds the *nearest* `:::` closer for each opener).
 */
const ADMONITION_PATTERN =
  /^([ \t]*):::([a-zA-Z]+)(?:\[([^\]]*)\])?[ \t]*(?:\n|[ \t]+)([\s\S]*?)\n?[ \t]*:::[ \t]*$/gm;

/**
 * Dedent the captured admonition body to a common baseline (preserving
 * relative structure like nested lists / JSX), then re-prefix every
 * non-blank line with the directive's own indentation so the emitted
 * `<Aside>…</Aside>` block sits at the same depth as the directive.
 */
function reindentBody(content: string, indent: string): string {
  const lines = content.replace(/^\n+/, "").replace(/\n+$/, "").split("\n");
  const widths = lines
    .filter((l) => l.trim() !== "")
    .map((l) => (l.match(/^[ \t]*/)?.[0].length ?? 0));
  const common = widths.length ? Math.min(...widths) : 0;
  return lines
    .map((l) => (l.trim() === "" ? "" : indent + l.slice(common)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

interface FrontmatterSplit {
  frontmatter: string;
  body: string;
  bodyOffset: number;
}

function splitFrontmatter(source: string): FrontmatterSplit {
  const match = source.match(/^---\n[\s\S]*?\n---\n?/);
  if (!match) return { frontmatter: "", body: source, bodyOffset: 0 };
  return {
    frontmatter: match[0],
    body: source.slice(match[0].length),
    bodyOffset: match[0].length,
  };
}

// ---------------------------------------------------------------------------
// Code-block stashing
// ---------------------------------------------------------------------------

/**
 * Replace fenced code blocks with opaque placeholders so the admonition
 * regex doesn't reach `:::` tokens inside code samples. The `restore()`
 * function reinstates the originals after the transform.
 *
 * Order matters: stash the longest fence flavors first (``` and ~~~)
 * so the placeholders themselves don't get re-stashed. Inline backtick
 * code spans are NOT stashed — a `:::` inside a single-line `code` span
 * is rare and would have to be on the same line as both fences anyway.
 */
function stashCodeBlocks(body: string): { stashed: string; restore: (src: string) => string } {
  const blocks: string[] = [];
  const PLACEHOLDER = "\x00NIMBUS_CODEBLOCK_";
  const PLACEHOLDER_END = "\x00";

  // Match ``` and ~~~ fenced blocks with optional language tags.
  const stashed = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (match) => {
    const index = blocks.length;
    blocks.push(match);
    return `${PLACEHOLDER}${index}${PLACEHOLDER_END}`;
  });

  function restore(src: string): string {
    return src.replace(
      new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER_END}`, "g"),
      (_match, index) => blocks[Number(index)] ?? "",
    );
  }

  return { stashed, restore };
}
