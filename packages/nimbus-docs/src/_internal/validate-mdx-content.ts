/**
 * MDX PascalCase tag validator — runs as a content pass, not a remark
 * plugin, so it works regardless of which markdown processor the user
 * has wired into `markdown.processor` (Sätteri replaces unified's
 * pipeline, which silently disables remark plugins attached via
 * `mdx({ remarkPlugins })`).
 *
 * Strategy:
 *
 *   1. Walk the configured content directories for `.mdx` files.
 *   2. For each file: split frontmatter, parse imports + JSX tags from
 *      the body, validate every PascalCase tag against globals + per-file
 *      imports.
 *   3. Collect every failure across every file (don't fail-fast), then
 *      throw one error with all locations and "did you mean" hints.
 *
 * Parsing approach is intentionally regex-based and not a full MDX
 * parser. Tradeoffs:
 *
 *   - Pro: zero MDX/remark deps, runs in milliseconds, no pipeline
 *     coupling. Survives processor swaps (satteri / unified / future).
 *   - Pro: tolerates malformed MDX — the validator's job is to find
 *     unknown tags, not to be the parser of record.
 *   - Con: a few edge cases (JSX inside string literals inside expression
 *     children, deeply nested fenced code with `~~~`) can produce false
 *     positives. Code blocks (``` and indented) are stripped before
 *     scanning to keep the common case clean.
 *
 * Catches the silent-failure case where MDX renders unknown PascalCase
 * tags as literal text on the deployed page — the bug appears in
 * production, not in the build log.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "./fs-walk.js";
import { suggest } from "./levenshtein.js";

export interface ValidateMdxContentOptions {
  /** Names available globally (from `src/components.ts`). */
  globals: ReadonlyArray<string>;
  /**
   * Absolute paths to scan. Typically `[<projectRoot>/src/content]`.
   * Each path is walked recursively for `.mdx` files.
   */
  contentDirs: ReadonlyArray<string>;
  /**
   * Optional filter to skip files (e.g. vendored MDX). Receives the
   * absolute path; return `true` to skip validation.
   */
  skip?: (filePath: string) => boolean;
  /**
   * Project root, used to print file paths relative to it in error
   * messages. Falls back to the absolute path when not provided.
   */
  projectRoot?: string;
}

export interface ValidationFailure {
  filePath: string;
  tag: string;
  line: number;
  column: number;
  hint: string | null;
}

export async function validateMdxContent(
  options: ValidateMdxContentOptions,
): Promise<ValidationFailure[]> {
  const globalsSet = new Set(options.globals);
  const failures: ValidationFailure[] = [];

  for (const dir of options.contentDirs) {
    const files = await walkMdx(dir);
    for (const file of files) {
      if (options.skip?.(file)) continue;
      const source = await fs.readFile(file, "utf8");
      const fileFailures = scanFile(source, globalsSet);
      for (const f of fileFailures) {
        const knownNames = [...globalsSet, ...f.imports];
        failures.push({
          filePath: options.projectRoot
            ? path.relative(options.projectRoot, file)
            : file,
          tag: f.tag,
          line: f.line,
          column: f.column,
          hint: suggest(f.tag, knownNames),
        });
      }
    }
  }

  return failures;
}

/**
 * Format a list of failures into a single multi-line error message
 * suitable for `throw new Error(...)`.
 */
export function formatFailures(
  failures: ReadonlyArray<ValidationFailure>,
): string {
  const lines = failures.map((f) => {
    const fix = f.hint
      ? `Did you mean <${f.hint} />?`
      : `Register it in src/components.ts, or add an explicit \`import\` at the top of this file.`;
    return `  ${f.filePath}:${f.line}:${f.column}  <${f.tag} />  →  ${fix}`;
  });

  const noun = failures.length === 1 ? "tag" : "tags";
  return (
    `[nimbus-docs] Unknown MDX component ${noun}:\n` +
    lines.join("\n") +
    `\n\nA PascalCase tag in MDX must either be registered in src/components.ts (the global registry) or imported at the top of the file. ` +
    `Without either, MDX renders the tag as literal text on the page — a silent failure this validator turns into a build error.`
  );
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

async function walkMdx(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const { abs } of walkFiles(dir, { extensions: [".mdx"] })) {
    out.push(abs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-file scanner
// ---------------------------------------------------------------------------

interface RawFailure {
  tag: string;
  line: number;
  column: number;
  imports: Set<string>;
}

function scanFile(
  source: string,
  globalsSet: ReadonlySet<string>,
): RawFailure[] {
  const { body, bodyOffset } = stripFrontmatter(source);
  const imports = parseImports(body);
  const stripped = stripCodeBlocks(body);
  const tags = findPascalCaseTags(stripped);

  const failures: RawFailure[] = [];
  for (const tag of tags) {
    if (globalsSet.has(tag.name) || imports.has(tag.name)) continue;
    const position = absolutePosition(source, bodyOffset + tag.offset);
    failures.push({
      tag: tag.name,
      line: position.line,
      column: position.column,
      imports,
    });
  }
  return failures;
}

function stripFrontmatter(source: string): { body: string; bodyOffset: number } {
  const match = source.match(/^---\n[\s\S]*?\n---\n?/);
  if (!match) return { body: source, bodyOffset: 0 };
  return { body: source.slice(match[0].length), bodyOffset: match[0].length };
}

/**
 * Extract names introduced by top-level `import` statements. Handles
 * default, named (with optional aliases), and namespace imports.
 */
function parseImports(body: string): Set<string> {
  const names = new Set<string>();
  // Match `import ... from "..."` and side-effect `import "..."` (no names).
  const importPattern = /^\s*import\s+([^"';]+?)\s+from\s+["'][^"']+["']\s*;?/gm;
  // `!` on every regex capture-group access: the `import…from` pattern's
  // group is *required* (not optional), so it's defined whenever `match`
  // succeeded. Same logic applies to `namespaceMatch[1]`, `braceMatch[1]`,
  // `aliasMatch[1]` — all required groups. `.split("{")[0]!` is safe
  // because `String.split` always returns ≥1 element.
  for (const match of body.matchAll(importPattern)) {
    const clause = match[1]!;
    // Namespace: `import * as Foo from "..."`
    const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceMatch) {
      names.add(namespaceMatch[1]!);
      continue;
    }
    // Strip and split: `Default, { Named, Aliased as Local }`
    const beforeBrace = clause.split("{")[0]!.trim().replace(/,\s*$/, "");
    if (beforeBrace && /^[A-Za-z_$][\w$]*$/.test(beforeBrace)) {
      names.add(beforeBrace);
    }
    const braceMatch = clause.match(/\{([^}]*)\}/);
    if (braceMatch) {
      for (const raw of braceMatch[1]!.split(",")) {
        const spec = raw.trim();
        if (!spec) continue;
        const aliasMatch = spec.match(/^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (aliasMatch) {
          names.add(aliasMatch[1]!);
        } else if (/^[A-Za-z_$][\w$]*$/.test(spec)) {
          names.add(spec);
        }
      }
    }
  }
  return names;
}

/**
 * Remove fenced code blocks and inline code spans so JSX-looking text
 * inside code samples doesn't trip the validator.
 */
function stripCodeBlocks(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, (m) => " ".repeat(m.length))
    // Inline code spans. Kept line-bounded on purpose: matching across
    // newlines makes backtick pairing global, so a single stray/odd
    // backtick anywhere cascades and exposes later inline code. Generics
    // that wrap across lines (`Promise<Map<…>>`) are instead handled in
    // findPascalCaseTags, which ignores `<Identifier<` (a TS generic, not
    // a JSX tag).
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))
    // Attribute-shaped string values (`text="Promise<QueueSendResult>"`).
    // JSX inside a quoted attribute is plain text to MDX, not a tag —
    // without this strip the scanner false-positives on generics like
    // `<Type text="Promise<Foo>" />`. Length-preserving for offsets.
    .replace(/=\s*"[^"\n]*"/g, (m) => "=" + " ".repeat(m.length - 1))
    .replace(/=\s*'[^'\n]*'/g, (m) => "=" + " ".repeat(m.length - 1))
    // String literals inside JSX expressions (`json={{ id: "<IDP_UUID>" }}`).
    // These aren't attribute-shaped, so the rules above miss them; a quoted
    // placeholder like "<IDP_UUID>" is a string value, never a component.
    // Real `<Component>` usage is never written inside a quoted string, so
    // stripping all single-line quoted spans can't hide a genuine tag.
    .replace(/"[^"\n]*"/g, (m) => " ".repeat(m.length))
    .replace(/'[^'\n]*'/g, (m) => " ".repeat(m.length));
}

interface FoundTag {
  name: string;
  offset: number;
}

/**
 * Find PascalCase JSX-like tags. Matches `<Capital...` at the start of
 * an element (opening or self-closing). Closing tags `</Capital>` and
 * JSX fragments `<>` are not counted (the opener already covers
 * registration; counting closers would double-report).
 */
function findPascalCaseTags(body: string): FoundTag[] {
  const out: FoundTag[] = [];
  const pattern = /<([A-Z][A-Za-z0-9_]*)/g;
  for (const match of body.matchAll(pattern)) {
    const offset = match.index ?? 0;
    // A `<` immediately after the identifier is a TypeScript generic
    // (`Promise<Map<string, …>>`), not a JSX element. These show up in
    // inline code / type signatures and must not be flagged as tags.
    if (body[offset + match[0].length] === "<") continue;
    // `match[1]!`: required capture group, defined whenever match succeeded.
    out.push({ name: match[1]!, offset });
  }
  return out;
}

/**
 * Compute 1-based line + column for an absolute character offset in the
 * original source.
 */
function absolutePosition(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
