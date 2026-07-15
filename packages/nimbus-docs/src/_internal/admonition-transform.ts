/**
 * Rewrites `:::type[title]...:::` fenced directives to `<Aside>` in MDX source,
 * as a Vite content transform that runs before the markdown compiler.
 *
 * Indentation is load-bearing: a directive nested inside indented JSX (e.g.
 * `:::note` inside `<TabItem>`) must emit its `<Aside>` at the same column. A
 * flush-left `<Aside>` dedents out of the enclosing element and `@mdx-js/mdx`
 * rejects the orphaned tag. The body is dedented to a common baseline then
 * re-prefixed with the directive's indent so nested structure survives.
 *
 * Not handled: nested admonitions with extra colons (`::::note … :::sub …`),
 * and bodies indented less than the `:::` opener (the common-baseline dedent
 * keys on the shallowest line, so an under-indented line pushes its siblings
 * into a code block). Author bodies at least as far as the opener.
 */

export interface AdmonitionTransformOptions {
  /** Extra type aliases on top of the built-in set. */
  typeAliases?: Record<string, AsideType>;
}

export type AsideType = "note" | "tip" | "caution" | "danger";

const BUILTIN_TYPES: Record<string, AsideType> = {
  note: "note",
  info: "note",
  tip: "tip",
  caution: "caution",
  warning: "caution",
  important: "caution",
  danger: "danger",
};

/** Transform a single MDX source string. Idempotent. */
export function transformAdmonitions(
  source: string,
  options: AdmonitionTransformOptions = {},
): string {
  const typeMap = { ...BUILTIN_TYPES, ...(options.typeAliases ?? {}) };

  const { frontmatter, body, bodyOffset: _ } = splitFrontmatter(source);

  const { stashed, restore } = stashCodeBlocks(body);

  const rewritten = stashed.replace(
    ADMONITION_PATTERN,
    (match, rawIndent, rawType, rawTitle, rawContent) => {
      const type = String(rawType).toLowerCase();
      const aside = typeMap[type];
      if (!aside) {
        return match;
      }
      const indent = typeof rawIndent === "string" ? rawIndent : "";
      const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
      const titleAttr = title ? ` title=${JSON.stringify(title)}` : "";

      const body = reindentBody(String(rawContent), indent);

      return `\n\n${indent}<Aside type="${aside}"${titleAttr}>\n\n${body}\n\n${indent}</Aside>\n\n`;
    },
  );

  const restored = restore(rewritten);

  return frontmatter + restored;
}

const ADMONITION_PATTERN =
  /^([ \t]*):::([a-zA-Z]+)(?:\[([^\]]*)\])?[ \t]*(?:\n|[ \t]+)([\s\S]*?)\n?[ \t]*:::[ \t]*$/gm;

/** Dedent the body to a common baseline, then re-prefix with the directive's indent. */
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

/** Replace fenced code blocks with placeholders so `:::` inside code is preserved. */
function stashCodeBlocks(body: string): { stashed: string; restore: (src: string) => string } {
  const blocks: string[] = [];
  const PLACEHOLDER = "\x00NIMBUS_CODEBLOCK_";
  const PLACEHOLDER_END = "\x00";

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
