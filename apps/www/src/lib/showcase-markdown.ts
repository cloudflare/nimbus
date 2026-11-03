import type { GeneratedMarkdownComponentTransform } from "@cloudflare/nimbus-docs/types";

/**
 * Markdown for the component pages' `<Showcase>` and `<Example>`: the
 * rendered preview, then the source the page shows under it.
 */

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

/**
 * An attribute's string value: plain text, or a JavaScript string literal
 * (`'…'`, `"…"`, or a template without `${}`) decoded as JavaScript reads it.
 * Anything else is code, with no text to show.
 */
function source(value: string | boolean | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const quote = value[0];
  // A bare name (`code={sample}`) is a variable, not the text itself.
  if (quote !== "'" && quote !== '"' && quote !== "`") return /^[A-Za-z_$][\w$.]*$/.test(value) ? undefined : value;
  if (value.length < 2 || value.at(-1) !== quote) return undefined;
  let out = "";
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i]!;
    if (char === quote || (quote === "`" && char === "$" && value[i + 1] === "{")) return undefined;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[++i]!;
    if (next === "u" || next === "x") {
      const hex = next === "x" ? value.slice(i + 1, i + 3) : value[i + 1] === "{" ? value.slice(i + 2, value.indexOf("}", i)) : value.slice(i + 1, i + 5);
      if (!/^[\da-f]+$/i.test(hex)) return undefined;
      out += String.fromCodePoint(parseInt(hex, 16));
      i += next === "x" ? 2 : value[i + 1] === "{" ? hex.length + 2 : 4;
    } else if (next === "\n") {
      // A line continuation.
    } else out += ESCAPES[next] ?? next;
  }
  return out;
}

function fence(code: string, lang: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((run) => run[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${lang}\n${code}\n${marks}`;
}

const showcase: GeneratedMarkdownComponentTransform = {
  revision: "showcase-v1",
  render: ({ attrs, children }) => {
    const code = source(attrs.code);
    const lang = attrs.mdxTag === true || attrs.mdxTag === "true" ? "mdx" : (typeof attrs.lang === "string" && /^[\w+-]+$/.test(attrs.lang) ? attrs.lang : "tsx");
    return [children.trim(), code ? fence(code, lang) : ""].filter(Boolean).join("\n\n");
  },
};

export const showcaseMarkdown = { Showcase: showcase, Example: showcase };
