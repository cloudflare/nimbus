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
import { resolve } from "node:path";
import { bundledLanguagesInfo, isSpecialLang } from "shiki";

import { walkFiles } from "./fs-walk.js";

// Opening backtick fence + language token. CommonMark forbids backticks in a
// backtick fence's info string, so `[^\n`]*$` rejects a line with a later
// backtick — i.e. inline `` ```x``` ``, not a block.
const FENCE_RE = /^[ \t]*```([a-zA-Z][a-zA-Z0-9_+\-]*)[^\n`]*$/gm;

// Grammars Shiki can resolve (bundled ids + aliases). Tokens outside this set
// are dropped before reaching Shiki, which throws on grammars it can't load;
// such code renders as plaintext instead.
const SHIKI_KNOWN = new Set<string>(
  bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])]),
);

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
    // Reset stateful regex iterator across files.
    FENCE_RE.lastIndex = 0;
    for (const m of content.matchAll(FENCE_RE)) {
      const raw = m[1]!.toLowerCase();
      const mapped = langAlias[raw] ?? raw;
      if (SHIKI_KNOWN.has(mapped) || isSpecialLang(mapped)) langs.add(mapped);
    }
  }

  return Array.from(langs).sort();
}
