/**
 * nimbus/image-ref — image references that don't resolve to a file on
 * disk. Unlike `internal-link` (whose truth is the emergent route set,
 * materialized at build time), image truth is just the filesystem: a
 * site-absolute ref maps to `public/`, a relative ref to the authoring
 * file's directory. No build prerequisite, no silent-skip machinery.
 *
 * Coverage:
 *   - `image` nodes (`![alt](url)`)
 *   - `imageReference` nodes (`![alt][ref]` resolved against `definition`s)
 *   - MDX JSX `<img src="...">`
 *   - Extra JSX components opt-in via `components: [{ name, attr }, …]` —
 *     same shape as `internal-link`'s option, same rationale: component
 *     names belong to the user.
 *
 * Resolution:
 *   - `/foo.png` → `<root>/public/foo.png` (Astro serves `public/` at the
 *     site root).
 *   - `./shot.png` / `../img.png` → relative to the MDX file (Astro's image
 *     pipeline resolves these as imports — they're valid and checkable).
 *   - `aliases: { "~/assets/": "src/assets/" }` maps prefix → root-relative
 *     directory. The framework ships none by default — `~/` is a per-project
 *     tsconfig path, not a framework concept.
 *   - External URLs (any scheme, incl. `data:`, and `//`) are skipped —
 *     remote existence checks are a network concern, not a lint.
 *   - Dynamic JSX attrs (`<img src={x}>`) are skipped — not checkable.
 *
 * A miss whose containing directory exists produces a "did you mean" hint
 * from that directory's entries via Levenshtein distance.
 */

import fs from "node:fs";
import path from "node:path";

import { suggest } from "../../_internal/levenshtein.js";
import { collect, startOf, visit, type MdNode } from "../parse.js";
import type { Rule } from "../rule.js";

export const imageRef: Rule = {
  code: "nimbus/image-ref",
  run(ctx) {
    const root = inferProjectRoot(ctx.file.absPath);
    const aliases = readAliases(ctx.options.aliases);
    const ignore = Array.isArray(ctx.options.ignore)
      ? ctx.options.ignore.filter((s): s is string => typeof s === "string")
      : [];
    const extraComponents = readExtraComponents(ctx.options.components);
    const definitions = collectDefinitions(ctx.file.tree);

    for (const occ of collectImageOccurrences(
      ctx.file.tree,
      definitions,
      extraComponents,
    )) {
      const url = occ.url;
      if (!url) continue;
      if (isExternal(url)) continue;

      const cleaned = cleanUrl(url);
      if (cleaned === "") continue;
      if (matchesAnyIgnore(cleaned, ignore)) continue;

      const resolved = resolveToDisk(cleaned, root, ctx.file.absPath, aliases);
      if (resolved === null) continue; // unrecognised shape — silence beats false-positive
      if (fileExists(resolved.fullPath)) continue;

      const hint = suggestSibling(resolved.fullPath);
      ctx.report({
        message: hint
          ? `missing image "${url}" — expected at ${resolved.display}; did you mean "${hint}"?`
          : `missing image "${url}" — expected at ${resolved.display}.`,
        line: occ.line,
        column: occ.column,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

interface ImageOccurrence {
  url: string;
  line: number;
  column: number;
}

interface ComponentSpec {
  name: string;
  attr: string;
}

/**
 * `<img src>` is always checked — a plain img means the same thing in
 * every MDX file. Extra components come from the `components` option.
 */
function readExtraComponents(value: unknown): ComponentSpec[] {
  if (!Array.isArray(value)) return [];
  const out: ComponentSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { name?: unknown; attr?: unknown };
    if (typeof obj.name === "string" && typeof obj.attr === "string") {
      out.push({ name: obj.name, attr: obj.attr });
    }
  }
  return out;
}

function collectImageOccurrences(
  root: MdNode,
  definitions: Map<string, string>,
  extraComponents: ComponentSpec[],
): ImageOccurrence[] {
  const out: ImageOccurrence[] = [];
  visit(root, (node) => {
    if (node.type === "image") {
      const at = startOf(node);
      out.push({
        url: typeof node.url === "string" ? node.url : "",
        line: at.line,
        column: at.column,
      });
      return;
    }
    if (node.type === "imageReference") {
      const identifier =
        typeof node.identifier === "string" ? node.identifier : "";
      const url = definitions.get(identifier);
      if (!url) return;
      const at = startOf(node);
      out.push({ url, line: at.line, column: at.column });
      return;
    }
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      if (node.name === "img") {
        const src = readJsxStringAttr(node, "src");
        if (src === null) return;
        const at = startOf(node);
        out.push({ url: src, line: at.line, column: at.column });
        return;
      }
      for (const spec of extraComponents) {
        if (node.name !== spec.name) continue;
        const src = readJsxStringAttr(node, spec.attr);
        if (src === null) return;
        const at = startOf(node);
        out.push({ url: src, line: at.line, column: at.column });
        return;
      }
    }
  });
  return out;
}

function collectDefinitions(root: MdNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of collect(root, "definition")) {
    const id = typeof def.identifier === "string" ? def.identifier : "";
    const url = typeof def.url === "string" ? def.url : "";
    if (id && url && !out.has(id)) out.set(id, url);
  }
  return out;
}

/**
 * Read a string-valued JSX attribute. Returns null when the attribute is
 * absent, dynamic (expression form `<img src={x}>`), or boolean.
 * Static-only on purpose — dynamic srcs aren't checkable.
 */
function readJsxStringAttr(node: MdNode, name: string): string | null {
  const attrs = (node as { attributes?: unknown }).attributes;
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    if (!a || typeof a !== "object") continue;
    const attr = a as { name?: unknown; value?: unknown };
    if (attr.name !== name) continue;
    if (typeof attr.value === "string") return attr.value;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL classification + resolution
// ---------------------------------------------------------------------------

function isExternal(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) || // any scheme: http:, data:, …
    url.startsWith("//") // protocol-relative
  );
}

/** Strip query string and hash, then percent-decode. */
function cleanUrl(url: string): string {
  let s = url;
  const q = s.indexOf("?");
  if (q !== -1) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h !== -1) s = s.slice(0, h);
  try {
    s = decodeURI(s);
  } catch {
    // Malformed encoding — leave as-is; the disk lookup will (correctly)
    // fail and surface a diagnostic the author can fix.
  }
  return s;
}

function readAliases(value: unknown): Array<[prefix: string, dir: string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: Array<[string, string]> = [];
  for (const [prefix, dir] of Object.entries(value as Record<string, unknown>)) {
    if (typeof dir === "string" && prefix.length > 0) out.push([prefix, dir]);
  }
  // Longest prefix wins when aliases nest (`~/assets/icons/` over `~/assets/`).
  out.sort((a, b) => b[0].length - a[0].length);
  return out;
}

interface ResolvedRef {
  fullPath: string;
  /** Root-relative form for the diagnostic message. */
  display: string;
}

function resolveToDisk(
  url: string,
  root: string,
  fileAbsPath: string,
  aliases: Array<[string, string]>,
): ResolvedRef | null {
  for (const [prefix, dir] of aliases) {
    if (url.startsWith(prefix)) {
      const rel = path.join(dir, url.slice(prefix.length));
      return { fullPath: path.join(root, rel), display: rel };
    }
  }
  if (url.startsWith("/")) {
    const rel = path.join("public", url.slice(1));
    return { fullPath: path.join(root, rel), display: rel };
  }
  if (url.startsWith("./") || url.startsWith("../")) {
    const fullPath = path.resolve(path.dirname(fileAbsPath), url);
    const rel = path.relative(root, fullPath);
    return { fullPath, display: rel.startsWith("..") ? fullPath : rel };
  }
  return null;
}

function fileExists(fullPath: string): boolean {
  try {
    return fs.statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Did-you-mean from the missing file's own directory — cheap (one
 * `readdir`) and covers the dominant failure (typo or wrong extension in
 * the filename, not the directory).
 */
function suggestSibling(fullPath: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.dirname(fullPath));
  } catch {
    return null;
  }
  return suggest(path.basename(fullPath), new Set(entries), 3);
}

/**
 * Minimal glob matcher — exact match or `prefix/**` suffix, same shape as
 * `internal-link`'s. Patterns are authored against the raw cleaned URL
 * (e.g. `/images/generated/**`).
 */
function matchesAnyIgnore(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  for (const pat of patterns) {
    const stripped =
      pat.length > 1 && pat.endsWith("/") ? pat.slice(0, -1) : pat;
    if (stripped.endsWith("/**")) {
      const prefix = stripped.slice(0, -3);
      if (url === prefix || url.startsWith(`${prefix}/`)) return true;
    } else if (url === stripped) {
      return true;
    }
  }
  return false;
}

/** Find the project root from a content file by walking up to the parent of `src`. */
function inferProjectRoot(absPath: string): string {
  const norm = absPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/src/");
  return idx === -1 ? path.dirname(absPath) : norm.slice(0, idx);
}
