/**
 * MDX → markdown transform for AI-readable static routes.
 *
 * This intentionally starts small and dependency-free: it operates on the
 * raw MDX body that Astro's content layer exposes and maps the starter's
 * default components to plain markdown equivalents. The route that calls this
 * lives in user code, so replacing or bypassing this transformer is a one-line
 * edit.
 */

export interface MarkdownComponentRenderContext {
  name: string;
  attrs: Record<string, string | boolean>;
  children: string;
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
}

interface MarkdownEntry {
  body?: string;
}

function protectCode(markdown: string): { markdown: string; restore: (value: string) => string } {
  const protectedChunks: string[] = [];
  function store(chunk: string): string {
    const token = `@@NIMBUS_MD_CODE_${protectedChunks.length}@@`;
    protectedChunks.push(chunk.startsWith("```") ? chunk.replace(/\n[ \t]{4}/g, "\n") : chunk);
    return token;
  }

  // Fenced blocks first so inline-code protection doesn't touch backticks inside.
  let next = markdown.replace(/```[\s\S]*?```/g, store);
  next = next.replace(/`[^`\n]+`/g, store);

  return {
    markdown: next,
    restore(value: string): string {
      return value.replace(/@@NIMBUS_MD_CODE_(\d+)@@/g, (_match, index: string) =>
        protectedChunks[Number(index)] ?? "",
      );
    },
  };
}

function parseAttrs(raw = ""): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  const re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g;
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

function asTitle(value: string | boolean | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function renderPackageManagers(attrs: Record<string, string | boolean>): string {
  const pkg = typeof attrs.pkg === "string" ? attrs.pkg : undefined;
  const args = typeof attrs.args === "string" ? attrs.args : undefined;
  const type = typeof attrs.type === "string" ? attrs.type : "install";
  const dev = attrs.dev === true || attrs.dev === "true";

  let commands: string[];
  if (type === "run") {
    const command = args ?? "dev";
    commands = [
      `npm run ${command}`,
      `pnpm ${command}`,
      `yarn ${command}`,
      `bun run ${command}`,
    ];
  } else if (type === "exec") {
    const command = args ?? pkg ?? "";
    commands = [
      `npx ${command}`,
      `pnpm exec ${command}`,
      `yarn exec ${command}`,
      `bunx ${command}`,
    ];
  } else if (type === "dlx") {
    const command = args ?? pkg ?? "";
    commands = [
      `npx ${command}`,
      `pnpm dlx ${command}`,
      `yarn dlx ${command}`,
      `bunx ${command}`,
    ];
  } else if (pkg) {
    commands = [
      `npm install ${dev ? "--save-dev " : ""}${pkg}`,
      `pnpm add ${dev ? "-D " : ""}${pkg}`,
      `yarn add ${dev ? "-D " : ""}${pkg}`,
      `bun add ${dev ? "-d " : ""}${pkg}`,
    ];
  } else {
    return "";
  }

  return ["```sh", ...commands, "```"].join("\n");
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
      const title = asTitle(attrs.title, type.charAt(0) + type.slice(1).toLowerCase());
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
      const description = typeof attrs.description === "string" ? attrs.description : "";
      const label = href ? `[${title}](${href})` : `**${title}**`;
      return `- ${label}${description ? ` — ${description}` : ""}`;
    },
  );

  out = out.replace(/<Steps\b[^>]*>([\s\S]*?)<\/Steps>/g, (_match, children: string) => {
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
  });

  out = out.replace(/<Tabs\b[^>]*>([\s\S]*?)<\/Tabs>/g, (_match, children: string) =>
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
): string {
  let out = markdown;
  for (const [name, render] of Object.entries(componentMap)) {
    const paired = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, "g");
    out = out.replace(paired, (_match, rawAttrs: string, children: string) =>
      render({ name, attrs: parseAttrs(rawAttrs), children: cleanChildren(children) }),
    );

    const selfClosing = new RegExp(`<${name}\\b([^>]*)\\/>`, "g");
    out = out.replace(selfClosing, (_match, rawAttrs: string) =>
      render({ name, attrs: parseAttrs(rawAttrs), children: "" }),
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

  if (stripFrontmatter) {
    markdown = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  }

  const protectedCode = protectCode(markdown);
  markdown = protectedCode.markdown;

  if (options.componentMap) {
    markdown = applyCustomComponentTransforms(markdown, options.componentMap);
  }
  markdown = applyDefaultComponentTransforms(markdown);
  markdown = protectedCode.restore(markdown);

  return markdown
    .replace(/^[ \t]+(- (?:\*\*|\[))/gm, "$1")
    .replace(/^[ \t]+(\d+\. \*\*)/gm, "$1")
    .replace(/^[ \t]+(### )/gm, "$1")
    .replace(/^[ \t]+(```)/gm, "$1")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
