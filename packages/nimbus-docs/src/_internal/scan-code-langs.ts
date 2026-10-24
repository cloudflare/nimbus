/**
 * Walk `src/content/` and collect every language used in fenced code blocks
 * inside `.md` / `.mdx` files. Output feeds `shikiConfig.langs` so Shiki
 * eager-loads every grammar at startup instead of lazy-loading on first use.
 *
 * Eager loading keeps highlighting independent of which file is processed
 * first — Shiki's lazy load otherwise depends on the order files hit a
 * grammar, which makes cold-build output non-deterministic.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { isSpecialLang } from "shiki";
import { SHIKI_KNOWN } from "./shiki-langs.js";
import { walkFiles } from "./fs-walk.js";
import { parseMarkdownSource } from "./markdown-source.js";

function fencedCodeBlocks(content: string, extension: string): ScannedCodeBlock[] {
  const blocks: ScannedCodeBlock[] = [];
  const tree = parseMarkdownSource(content, extension === ".mdx" ? "mdx" : "markdown") as {
    type: string;
    lang?: string | null;
    value?: string;
    children?: unknown[];
  };
  const visit = (node: typeof tree) => {
    if (node.type === "code" && node.lang && typeof node.value === "string") {
      blocks.push({ lang: node.lang.toLowerCase(), code: `${node.value}\n` });
    }
    for (const child of node.children ?? []) visit(child as typeof tree);
  };
  visit(tree);

  return blocks;
}

/**
 * Scan a project's content directories for code-fence languages.
 *
 * `langAlias` maps shorthand fence names (e.g. `curl`, `console`) to the
 * underlying highlighter Shiki actually knows. The mapping is applied
 * before deduping so the returned set is what Shiki should load.
 */
export async function scanCodeBlockLanguages(
  projectRoot: string,
  langAlias: Record<string, string> = {},
): Promise<string[]> {
  const langs = new Set<string>();
  const contentRoot = resolve(projectRoot, "src/content");

  // lenient: a scan failure yields fewer detected languages, not a build abort.
  for await (const { abs } of walkFiles(contentRoot, {
    extensions: [".mdx", ".md"],
    onReadError: "lenient",
  })) {
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    let parsed: ScannedCodeBlock[];
    try {
      parsed = fencedCodeBlocks(content, extname(abs));
    } catch {
      continue;
    }
    for (const block of parsed) {
      const raw = block.lang;
      const mapped = langAlias[raw] ?? raw;
      if (SHIKI_KNOWN.has(mapped) || isSpecialLang(mapped)) langs.add(mapped);
    }
  }

  return Array.from(langs).sort();
}

export interface ScannedCodeBlock {
  lang: string;
  code: string;
}

export async function scanCodeBlocks(
  projectRoot: string,
  langAlias: Record<string, string> = {},
  extraDirs: readonly string[] = [],
): Promise<ScannedCodeBlock[]> {
  const blocks: ScannedCodeBlock[] = [];
  const roots = [resolve(projectRoot, "src/content"), ...extraDirs];
  const files: string[] = [];
  for (const root of roots) {
    for await (const { abs } of walkFiles(root, {
      extensions: [".mdx", ".md"],
      onReadError: "lenient",
    })) {
      files.push(abs);
    }
  }

  for (const abs of files) {
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    let parsed: ScannedCodeBlock[];
    try {
      parsed = fencedCodeBlocks(content, extname(abs));
    } catch {
      continue;
    }
    for (const block of parsed) {
      const raw = block.lang;
      const lang = langAlias[raw] ?? raw;
      if (!SHIKI_KNOWN.has(lang) && !isSpecialLang(lang)) continue;
      blocks.push({ lang, code: block.code });
    }
  }

  return blocks;
}
