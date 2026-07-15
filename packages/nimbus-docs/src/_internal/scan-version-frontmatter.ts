/**
 * Walk every version-collection directory and extract the frontmatter
 * fields the alternates table needs (`previousSlug`, `draft`).
 *
 * Runs at `astro:config:setup` — before Astro's content layer is
 * initialized, so we can't use `getCollection()`. Walks the filesystem
 * directly, slices the YAML frontmatter from each MDX/MD file, and
 * pulls the two fields we care about. Same "never execute user code"
 * posture as `parse-content-collections.ts` and `parse-components-registry.ts`.
 *
 * Returns one `VersionEntryInput` per visible entry across the
 * versioned-docs collections. Drafts (frontmatter `draft: true`) are
 * filtered. Consumers feed this into `buildVersionAlternates()`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "./fs-walk.js";
import type { ResolvedVersions } from "../types.js";
import type { VersionEntryInput } from "./version-alternates.js";

const PRIMARY_COLLECTION = "docs";
const EXTENSIONS = new Set([".mdx", ".md"]);

export interface ScanOptions {
  /** Absolute path to the project root (`fileURLToPath(astroConfig.root)`). */
  projectRoot: string;
  /** Resolved versioning manifest. */
  versions: ResolvedVersions;
}

export async function scanVersionFrontmatter(
  options: ScanOptions,
): Promise<VersionEntryInput[]> {
  const { projectRoot, versions } = options;
  const out: VersionEntryInput[] = [];

  // Primary collection's directory: src/content/docs/.
  // Version collections: src/content/docs-<slug>/.
  const collectionsToScan: { collection: string; dir: string }[] = [
    { collection: PRIMARY_COLLECTION, dir: path.join(projectRoot, "src/content/docs") },
    ...versions.others.map((slug) => ({
      collection: `docs-${slug}`,
      dir: path.join(projectRoot, `src/content/docs-${slug}`),
    })),
  ];

  for (const { collection, dir } of collectionsToScan) {
    const files = await walk(dir);
    for (const file of files) {
      let source: string;
      try {
        source = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const front = extractFrontmatter(source);
      if (front === null) continue;
      if (parseBoolField(front, "draft") === true) continue;

      const previousSlug = parsePreviousSlugField(front);
      const id = idFromPath(dir, file);
      out.push({ collection, id, previousSlug });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const { abs } of walkFiles(dir, { extensions: [...EXTENSIONS] })) {
    out.push(abs);
  }
  return out;
}

/**
 * Slice the YAML frontmatter block from a source file. Returns the body
 * between the leading `---` and the closing `---` (without the markers),
 * or `null` if no frontmatter is present.
 *
 * Matches the same convention Astro's content layer enforces — leading
 * `---\n`, closing `\n---\n` (or `\n---` at EOF).
 */
function extractFrontmatter(source: string): string | null {
  if (!source.startsWith("---")) return null;
  // First line must be exactly `---` (or `---\r`).
  const afterFirstMarker = source.indexOf("\n");
  if (afterFirstMarker === -1) return null;
  const firstLine = source.slice(0, afterFirstMarker).trim();
  if (firstLine !== "---") return null;

  const rest = source.slice(afterFirstMarker + 1);
  // Look for a line that's just `---` (start-of-line, optional trailing CR).
  const closingMatch = rest.match(/(^|\n)---\s*(\n|$)/);
  if (!closingMatch || closingMatch.index === undefined) return null;
  // closingMatch.index is the start of the `\n---` (or the leading
  // newline before it). Slice up to it.
  return rest.slice(0, closingMatch.index);
}

/**
 * Find a top-level boolean field in YAML frontmatter. Returns the
 * boolean value or `undefined` if the field is absent / malformed.
 *
 * Handles only the shape Nimbus uses: `<field>: true` / `<field>: false`
 * on a single line, no indentation, no quotes.
 */
function parseBoolField(yaml: string, field: string): boolean | undefined {
  const re = new RegExp(`^${escapeRe(field)}\\s*:\\s*(true|false)\\s*$`, "m");
  const m = yaml.match(re);
  if (!m) return undefined;
  return m[1] === "true";
}

/**
 * Find the top-level `previousSlug` field in YAML frontmatter. Accepts:
 *   - scalar: `previousSlug: foo`
 *   - inline array: `previousSlug: [foo, "bar", 'baz']`
 *   - multiline block array:
 *       ```yaml
 *       previousSlug:
 *         - foo
 *         - bar
 *       ```
 *
 * Returns:
 *   - `string` for a scalar
 *   - `string[]` for either array form
 *   - `undefined` if absent
 *
 * All three forms are accepted: scalar, inline array, and the multiline
 * block list (canonical YAML list syntax). The schema validates the
 * post-parse shape; the scanner has to match it.
 */
function parsePreviousSlugField(yaml: string): string | string[] | undefined {
  // First locate the `previousSlug:` line. If the right-hand side is
  // empty (just whitespace), it's the lead-in to a block list — parse
  // the indented `- value` lines that follow.
  const blockHeader = yaml.match(/^previousSlug\s*:\s*$/m);
  if (blockHeader && blockHeader.index !== undefined) {
    const after = yaml.slice(blockHeader.index + blockHeader[0].length + 1);
    return parseBlockList(after);
  }

  // Inline array form: previousSlug: [foo, "bar", 'baz']
  const arr = yaml.match(/^previousSlug\s*:\s*\[([^\]]*)\]\s*$/m);
  if (arr) {
    const inner = arr[1]!;
    return inner
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
  }

  // Scalar form: previousSlug: foo  OR  previousSlug: "foo"
  const scalar = yaml.match(/^previousSlug\s*:\s*(?!\[)(.+?)\s*$/m);
  if (scalar) {
    const raw = scalar[1]!.trim();
    if (raw.length === 0) return undefined;
    return unquote(raw);
  }

  return undefined;
}

/**
 * Parse a YAML block list (one `- value` per line, leading indent).
 * Stops at the first non-list, non-blank line (i.e. the next sibling
 * frontmatter field at the same indentation as the list header).
 *
 *   previousSlug:
 *     - foo
 *     - "bar"
 *     - 'baz'
 *   title: Whatever            ← stops here
 */
function parseBlockList(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const m = line.match(/^\s+-\s+(.+?)\s*$/);
    if (!m) break;
    const value = unquote(m[1]!.trim());
    if (value.length > 0) out.push(value);
  }
  return out;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compute the Astro entry id (the slug) from a file's absolute path,
 * relative to the collection directory.
 *
 * Examples:
 *   - <dir>/index.mdx           → "index"
 *   - <dir>/foo.mdx             → "foo"
 *   - <dir>/guides/setup.mdx    → "guides/setup"
 */
function idFromPath(collectionDir: string, filePath: string): string {
  const rel = path.relative(collectionDir, filePath);
  const noExt = rel.replace(/\.(mdx|md)$/, "");
  // Normalise path separators for cross-platform stability.
  return noExt.split(path.sep).join("/");
}
