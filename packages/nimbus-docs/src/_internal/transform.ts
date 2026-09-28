/**
 * MDX → Markdown transform for generated static routes.
 *
 * This intentionally starts small and dependency-free: it operates on the
 * raw MDX body that Astro's content layer exposes and maps the starter's
 * default components to plain markdown equivalents. The route that calls this
 * lives in user code, so replacing or bypassing this transformer is a one-line
 * edit.
 */

import {
  hasCitation,
  resolveCitations,
  type CitationIndex,
} from "./api/citations.js";
import { getTabs, type CommandType } from "../lib/pkgm.js";

export interface MarkdownComponentRenderContext {
  name: string;
  attrs: Record<string, string | boolean>;
  children: string;
  base: string;
}

export type MarkdownComponentRenderer = (
  context: MarkdownComponentRenderContext,
) => string;

export interface RenderEntryAsMarkdownOptions {
  /**
   * Override how specific MDX components are rendered. Keys are component
   * names (e.g. `Aside`, `Tabs`, `PackageManagers`).
   */
  componentMap?: Record<string, MarkdownComponentRenderer>;
  /** Strip YAML frontmatter if the raw body includes it. Default: true. */
  stripFrontmatter?: boolean;
  /**
   * Coordinate-citation index. Required when the body contains `api.ref:`
   * citations, else rendering throws rather than emitting a raw sentinel.
   */
  citationIndex?: CitationIndex;
  /** Active Astro base path for build-time component renderers. */
  base?: string;
}

interface MarkdownEntry {
  body?: string;
  filePath?: string;
}

const FENCE_OPEN = /^([ \t]*(?:>[ \t]?)*)(`{3,}|~{3,})([^\r]*)/;
const QUOTE_PREFIX = /^[ \t]*(?:>[ \t]*)+$/;

// Remove the opening fence's container prefix (indentation, `>` markers)
// from a content line, as CommonMark does for an indented fence.
function stripPrefix(line: string, prefix: string): string {
  let i = 0;
  while (
    i < prefix.length &&
    i < line.length &&
    /[ \t>]/.test(line[i]!) &&
    (line[i] === ">") === (prefix[i] === ">")
  ) {
    i++;
  }
  return line.slice(i);
}

function protectFences(
  markdown: string,
  store: (chunk: string) => string,
): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!);
    const [, prefix = "", fence = "", info = ""] = open ?? [];
    if (!open || (fence[0] === "`" && info.includes("`"))) {
      out.push(lines[i]!);
      continue;
    }
    const close = new RegExp(`^${fence[0]}{${fence.length},}[ \\t]*\\r?$`);
    let end = i + 1;
    while (end < lines.length && !close.test(stripPrefix(lines[end]!, prefix))) {
      end++;
    }
    if (end === lines.length) {
      out.push(lines[i]!);
      continue;
    }
    const body = lines
      .slice(i + 1, end + 1)
      .map((line) => stripPrefix(line, prefix));
    out.push(prefix + store([lines[i]!.slice(prefix.length), ...body].join("\n")));
    i = end;
  }
  return out.join("\n");
}

function protectCode(markdown: string): {
  markdown: string;
  restore: (value: string) => string;
} {
  const protectedChunks: string[] = [];
  const store = (kind: "FENCE" | "CODE") => (chunk: string) => {
    const token = `@@NIMBUS_MD_${kind}_${protectedChunks.length}@@`;
    protectedChunks.push(chunk);
    return token;
  };

  // Fenced blocks first so inline-code protection doesn't touch backticks inside.
  let next = protectFences(markdown, store("FENCE"));
  next = next.replace(/`[^`\n]+`/g, store("CODE"));

  return {
    markdown: next,
    restore(value: string): string {
      return value.replace(
        /@@NIMBUS_MD_(?:FENCE|CODE)_(\d+)@@/g,
        (_match, index: string, offset: number, whole: string) => {
          const chunk = protectedChunks[Number(index)] ?? "";
          const before = whole.slice(whole.lastIndexOf("\n", offset) + 1, offset);
          if (!QUOTE_PREFIX.test(before)) return chunk;
          const blank = before.trimEnd();
          return chunk.replace(/\n([^\n\r]*)/g, (_line, text: string) =>
            text ? `\n${before}${text}` : `\n${blank}`,
          );
        },
      );
    },
  };
}

function parseAttrs(raw = ""): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  const re =
    /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g;
  for (const match of raw.matchAll(re)) {
    const [, name, dq, sq, expr, bare] = match;
    if (!name) continue;
    attrs[name] = dq ?? sq ?? expr?.trim() ?? bare ?? true;
  }
  return attrs;
}

function cleanChildren(children: string): string {
  return children
    .replace(/^\s+/g, "")
    .replace(/\s+$/g, "")
    .replace(/\n[ \t]+/g, "\n");
}

function blockquote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function asTitle(
  value: string | boolean | undefined,
  fallback: string,
): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function renderPackageManagers(
  attrs: Record<string, string | boolean>,
): string {
  const string = (value: string | boolean | undefined) =>
    typeof value === "string" ? value : undefined;
  const comment = string(attrs.comment);
  const commands = getTabs(
    (string(attrs.type) ?? "add") as CommandType,
    string(attrs.pkg),
    { args: string(attrs.args), dev: attrs.dev === true || attrs.dev === "true" },
  ).map((tab) => tab.cmd);
  if (commands.length === 0) return "";
  return [
    "```sh",
    ...(comment ? [`# ${comment}`] : []),
    ...commands,
    "```",
  ].join("\n");
}

function applyDefaultComponentTransforms(markdown: string): string {
  let out = markdown;

  out = out.replace(
    /<PackageManagers\b([^>]*)\/>/g,
    (_match, rawAttrs: string) => renderPackageManagers(parseAttrs(rawAttrs)),
  );

  out = out.replace(
    /<Aside\b([^>]*)>([\s\S]*?)<\/Aside>/g,
    (_match, rawAttrs: string, children: string) => {
      const attrs = parseAttrs(rawAttrs);
      const type = asTitle(attrs.type, "note").toUpperCase();
      const title = asTitle(
        attrs.title,
        type.charAt(0) + type.slice(1).toLowerCase(),
      );
      const body = cleanChildren(children);
      return blockquote(`**${title}**\n\n${body}`);
    },
  );

  out = out.replace(
    /<Card\b([^>]*)>([\s\S]*?)<\/Card>/g,
    (_match, rawAttrs: string, children: string) => {
      const attrs = parseAttrs(rawAttrs);
      const title = asTitle(attrs.title, "Card");
      const body = cleanChildren(children);
      return `- **${title}**${body ? ` — ${body}` : ""}`;
    },
  );
  out = out.replace(/<\/?CardGrid\b[^>]*>/g, "");

  out = out.replace(
    /<LinkCard\b([^>]*?)\s*\/>/g,
    (_match, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      const title = asTitle(attrs.title, "Link");
      const href = typeof attrs.href === "string" ? attrs.href : "";
      const description =
        typeof attrs.description === "string" ? attrs.description : "";
      const label = href ? `[${title}](${href})` : `**${title}**`;
      return `- ${label}${description ? ` — ${description}` : ""}`;
    },
  );

  out = out.replace(
    /<Steps\b[^>]*>([\s\S]*?)<\/Steps>/g,
    (_match, children: string) => {
      let index = 0;
      return children.replace(
        /<Step\b([^>]*)>([\s\S]*?)<\/Step>/g,
        (_stepMatch, rawAttrs: string, stepChildren: string) => {
          index += 1;
          const attrs = parseAttrs(rawAttrs);
          const title = asTitle(attrs.title, `Step ${index}`);
          const body = cleanChildren(stepChildren);
          return `${index}. **${title}**${body ? `\n\n   ${body.replace(/\n/g, "\n   ")}` : ""}`;
        },
      );
    },
  );

  out = out.replace(
    /<Tabs\b[^>]*>([\s\S]*?)<\/Tabs>/g,
    (_match, children: string) =>
      children.replace(
        /<TabItem\b([^>]*)>([\s\S]*?)<\/TabItem>/g,
        (_tabMatch, rawAttrs: string, tabChildren: string) => {
          const attrs = parseAttrs(rawAttrs);
          const label = asTitle(attrs.label, "Option");
          return `### ${label}\n\n${cleanChildren(tabChildren)}`;
        },
      ),
  );

  // If user content includes raw component wrappers we don't know about,
  // preserve their children rather than leaking JSX into the markdown.
  out = out.replace(/<([A-Z][A-Za-z0-9]*)\b[^>]*>([\s\S]*?)<\/\1>/g, "$2");
  out = out.replace(/<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g, "");

  return out;
}

function applyCustomComponentTransforms(
  markdown: string,
  componentMap: Record<string, MarkdownComponentRenderer>,
  base: string,
): string {
  let out = markdown;
  for (const [name, render] of Object.entries(componentMap)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const paired = new RegExp(
      `<${escapedName}(?=[\\s/>])([^>]*)>([\\s\\S]*?)<\\/${escapedName}>`,
      "g",
    );
    out = out.replace(paired, (_match, rawAttrs: string, children: string) =>
      render({
        name,
        attrs: parseAttrs(rawAttrs),
        children: cleanChildren(children),
        base,
      }),
    );

    const selfClosing = new RegExp(
      `<${escapedName}(?=[\\s/>])([^>]*)\\/>`,
      "g",
    );
    out = out.replace(selfClosing, (_match, rawAttrs: string) =>
      render({ name, attrs: parseAttrs(rawAttrs), children: "", base }),
    );
  }
  return out;
}

/**
 * Render an Astro content entry's raw MDX body as plain markdown.
 *
 * This handles the starter's default MDX components. Users can pass a
 * `componentMap` to override individual component renderers or replace this
 * function entirely from their user-owned `.md` route.
 */
export function renderEntryAsMarkdown(
  entry: MarkdownEntry,
  options: RenderEntryAsMarkdownOptions = {},
): string {
  const stripFrontmatter = options.stripFrontmatter ?? true;
  let markdown = entry.body ?? "";

  const isMdx = !entry.filePath?.endsWith(".md");
  if (isMdx && /<Render(?=[\s/>])/.test(protectCode(markdown).markdown)) {
    throw new Error(
      "nimbus-docs: renderEntryAsMarkdown no longer expands <Render> partials at runtime. " +
        "Serve it with getMarkdownPayload from @cloudflare/nimbus-docs/agent-endpoints.",
    );
  }

  if (stripFrontmatter) {
    markdown = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  }

  if (hasCitation(markdown)) {
    if (!options.citationIndex) {
      throw new Error(
        "nimbus-docs: renderEntryAsMarkdown received a body with api.ref: " +
          "citations but no citation index. Use getEntryMarkdown, or pass " +
          "`{ citationIndex: await loadCitationIndex() }`.",
      );
    }
    markdown = resolveCitations(markdown, {
      mode: "derived",
      citationIndex: options.citationIndex,
    }).code;
  }

  if (!isMdx) return markdown.trim();

  const protectedCode = protectCode(markdown);
  markdown = protectedCode.markdown;

  if (options.componentMap) {
    markdown = applyCustomComponentTransforms(
      markdown,
      options.componentMap,
      options.base ?? "/",
    );
  }
  markdown = applyDefaultComponentTransforms(markdown);

  // Normalize layout before restoring code so code blocks stay byte-identical.
  markdown = markdown
    .replace(/^[ \t]+(- (?:\*\*|\[))/gm, "$1")
    .replace(/^[ \t]+(\d+\. \*\*)/gm, "$1")
    .replace(/^[ \t]+(### )/gm, "$1")
    .replace(/^[ \t]+(```|@@NIMBUS_MD_FENCE_)/gm, "$1")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return protectedCode.restore(markdown);
}
