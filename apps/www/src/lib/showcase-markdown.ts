import { readdirSync, readFileSync } from "node:fs";
import { getTabs } from "@cloudflare/nimbus-docs/lib/pkgm";
import type { GeneratedMarkdownComponentTransform } from "@cloudflare/nimbus-docs/types";
import { parse } from "yaml";
import { componentName, installState } from "./component-install";

/**
 * Markdown for the component pages' own MDX components, so the page, its
 * `.md`, MCP, `llms-full.txt` and search all read the same content:
 * `<Showcase>`/`<Example>` (the preview, then the source the page shows under
 * it), `<ComponentInstall>`, `<ComponentProps>` and `<ComponentList>`.
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

interface ComponentFrontmatter {
  title: string;
  tagline: string;
  props?: Array<{ name: string; type: string; defaultValue?: string; required?: boolean; description?: string }>;
}

const COMPONENTS = new URL("../content/components/", import.meta.url);

/** A component entry's frontmatter, read from its MDX file at build time. */
function frontmatterOf(slug: string): ComponentFrontmatter {
  const source = readFileSync(new URL(`${slug}.mdx`, COMPONENTS), "utf8");
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!block) throw new Error(`src/content/components/${slug}.mdx has no frontmatter`);
  // `merge: true` reads `<<:` keys as Astro's frontmatter parser does.
  const data = parse(block[1]!, { merge: true }) as ComponentFrontmatter;
  for (const prop of data.props ?? []) {
    if (typeof prop?.name !== "string" || typeof prop.type !== "string" || !prop.name || !prop.type) {
      throw new Error(`src/content/components/${slug}.mdx: every prop needs a name and a type`);
    }
  }
  return data;
}

const slugOf = (attrs: Record<string, string | boolean>, name: string) => {
  const slug = attrs.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) throw new Error(`<${name}> needs a slug="…" naming a component`);
  return slug;
};

/** On one line: GFM ends a line at LF, CR or CRLF. */
const oneLine = (text: string) => text.replace(/\s*(?:\r\n|\r|\n)\s*/g, " ");

/**
 * A code span: the fence outlasts any backtick run inside, and a space pads a
 * value that starts or ends with a backtick or a space, so the span reads back
 * exactly. Outside a table, nothing else needs escaping.
 */
const code = (text: string) => {
  const value = oneLine(text);
  const marks = "`".repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length)) + 1);
  const pad = /^[` ]|[` ]$/.test(value) && /[^ ]/.test(value) ? " " : "";
  return `${marks}${pad}${value}${pad}${marks}`;
};

const install: GeneratedMarkdownComponentTransform = {
  revision: "component-install-v1",
  render: ({ attrs }) => {
    const slug = slugOf(attrs, "ComponentInstall");
    const commands = fence(getTabs("exec", "@cloudflare/nimbus-docs", { args: `add ${slug}` }).map((tab) => tab.cmd).join("\n"), "sh");
    switch (installState(slug)) {
      case "builtin":
        return `**Built into nimbus-docs.** Import it from the package.\n\n${fence('import Icon from "@cloudflare/nimbus-docs/components/Icon.astro";', "ts")}`;
      case "included":
        return `**Included in the starter.** Every new site has it in \`src/components/ui/${slug}/\`. Import it where you need it, or register it in \`src/components.ts\` to use it on every page. If your site predates it, install it:\n\n${commands}`;
      case "install":
        return `**Install with \`nimbus-docs add ${slug}\`.** It lands in \`src/components/ui/${slug}/\`, yours to edit.\n\n${commands}`;
    }
  },
};

const props: GeneratedMarkdownComponentTransform = {
  revision: "component-props-v2",
  render: ({ attrs }) => {
    // A list rather than a table: types are full of pipes, which a table cell
    // would have to escape.
    const rows = frontmatterOf(slugOf(attrs, "ComponentProps")).props ?? [];
    return rows
      .map((p) => {
        const meta = [code(p.type), ...(p.defaultValue ? [`default ${code(p.defaultValue)}`] : [])].join(", ");
        const description = p.description ? ` — ${oneLine(p.description)}` : "";
        return `- ${code(p.name)}${p.required ? " (required)" : ""}: ${meta}${description}`;
      })
      .join("\n");
  },
};

/** `/components`: its page is a gallery; its Markdown lists every component. */
const list: GeneratedMarkdownComponentTransform = {
  revision: "component-list-v1",
  render: ({ base }) =>
    readdirSync(COMPONENTS)
      .filter((file) => file.endsWith(".mdx") && file !== "index.mdx")
      .map((file) => {
        const slug = file.slice(0, -".mdx".length);
        const data = frontmatterOf(slug);
        return { slug, name: componentName(slug, data.title), tagline: data.tagline };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ slug, name, tagline }) => `- [${name}](${base.replace(/\/$/, "")}/components/${slug}/) — ${tagline}`)
      .join("\n"),
};

export const showcaseMarkdown = {
  Showcase: showcase,
  Example: showcase,
  ComponentInstall: install,
  ComponentProps: props,
  ComponentList: list,
};
