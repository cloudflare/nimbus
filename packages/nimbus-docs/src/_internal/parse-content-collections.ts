/**
 * Extract registered collection names from the user's `src/content.config.ts`.
 *
 * Used by `getIndexedEntries()` and the agent-facing routes (`llms.txt`,
 * per-page `.md` alternates) so they don't have to hardcode `"docs"`.
 * Adding a new collection to `content.config.ts` lights up every
 * indexing surface automatically.
 *
 * Strategy: read the file as text and locate the `export const collections =
 * { ... }` declaration, parse its top-level keys. Same approach used by
 * `parse-components-registry.ts` — we never execute user code at build
 * time.
 *
 * Supported entry shapes inside the object literal:
 *   - shorthand:    `docs,`                         → "docs"
 *   - aliased:      `docs: defineCollection(...),`  → "docs" (the key)
 *   - string key:   `"docs": defineCollection(...)` → "docs"
 *
 * Skipped:
 *   - spread elements (`...other`)
 *   - computed keys (`[expr]: value`)
 *
 * The result is *not* filtered against reserved names here — that's
 * `getIndexedEntries()`'s job, so consumers that want the raw list (e.g.
 * tooling) can still see it.
 *
 * Returns:
 *   - `string[]` of registered names when the file exists and the
 *     pattern matches.
 *   - `null` when the file is missing OR present but doesn't expose a
 *     parseable `export const collections = { ... }`. Callers decide
 *     whether to warn or fall back to `["docs"]`.
 */

import fs from "node:fs/promises";

import {
  findMatchingBrace,
  splitTopLevelCommas,
  stripComments,
} from "./parse-object-literal.js";

// Locate the start of the `export const collections = {` declaration; the
// matching close brace is found by walking braces (the original regex-only
// match stopped at the first nested `\n\s*}` and missed entries declared
// after any deeply nested object literal).
const EXPORT_PREFIX_PATTERN =
  /export\s+const\s+collections\s*(?::\s*[^=]+)?=\s*\{/;

export async function parseContentCollections(
  filePath: string,
): Promise<string[] | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const stripped = stripComments(source);
  const prefixMatch = stripped.match(EXPORT_PREFIX_PATTERN);
  if (!prefixMatch || prefixMatch.index === undefined) return null;
  const objectStart = prefixMatch.index + prefixMatch[0].length;
  const objectEnd = findMatchingBrace(stripped, objectStart - 1);
  if (objectEnd === -1) return null;
  const body = stripped.slice(objectStart, objectEnd);

  const names: string[] = [];
  for (const raw of splitTopLevelCommas(body)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("...")) continue;
    if (entry.startsWith("[")) continue;

    const colonIdx = entry.indexOf(":");
    const rawKey = colonIdx === -1 ? entry : entry.slice(0, colonIdx);
    const key = rawKey.trim().replace(/^['"`]|['"`]$/g, "");

    // Collection names are conventionally lowercase identifiers
    // (`docs`, `blog`, `api`), but Astro accepts any non-empty string as a
    // collection ID and the versioning convention (`docs-v1`, `docs-2025-q1`)
    // relies on hyphens. Accept letters/digits/underscores/hyphens after
    // a leading letter or underscore (the `_*` underscore convention for
    // hidden-from-indexing collections stays intact).
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) names.push(key);
  }

  return names;
}

/**
 * Sibling of `parseContentCollections` that also extracts each entry's
 * `base` option — the folder name under `src/content/` the collection
 * loads from. Returns a `Map<key, folderName>` where the folder defaults
 * to the collection key when no `base:` override is present.
 *
 * Used by the `nimbus/duplicate-slug` validator and any other framework
 * code that needs to walk a collection's actual on-disk location rather
 * than assuming the folder name matches the collection key. Astro's
 * content layer respects the `base` option — `docsCollection({ base:
 * "documentation" })` loads from `src/content/documentation/` while still
 * registering as collection `docs`. Without this map, filesystem-walking
 * code would mis-tag those entries (`collection: "documentation"`) and
 * either flag bogus collisions or silently skip them via the indexable-
 * collections filter.
 *
 * Extraction is regex-based — for each entry's value text, looks for
 * `\bbase:\s*["']([^"']+)["']`. That covers the documented Nimbus pattern
 * (`docsCollection({ base: "..." })`, `partialsCollection({ base: "..." })`,
 * `componentsCollection({ base: "..." })`). Limitations:
 *
 *   - Computed/dynamic bases (`base: someVar`) fall back to the collection
 *     key. A future regression would silently miscount; for now,
 *     accepted as a known v1 limitation.
 *   - Hand-rolled `defineCollection({ loader: glob({ base: "./src/content/x" }) })`
 *     puts a *path* in `base`, not a folder name. The extracted value
 *     starts with `./src/content/` and won't match a folder under
 *     `src/content/` directly. Users who write the loader by hand can
 *     keep folder names matching collection keys, or accept that
 *     `duplicate-slug` won't see their non-conforming collection until
 *     they migrate to the Nimbus helpers.
 *
 * Returns `null` when the file is missing or unparseable, matching
 * `parseContentCollections`'s contract.
 */
export async function parseCollectionBases(
  filePath: string,
): Promise<Map<string, string> | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const stripped = stripComments(source);
  const prefixMatch = stripped.match(EXPORT_PREFIX_PATTERN);
  if (!prefixMatch || prefixMatch.index === undefined) return null;
  const objectStart = prefixMatch.index + prefixMatch[0].length;
  const objectEnd = findMatchingBrace(stripped, objectStart - 1);
  if (objectEnd === -1) return null;
  const body = stripped.slice(objectStart, objectEnd);

  const out = new Map<string, string>();
  for (const raw of splitTopLevelCommas(body)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("...")) continue;
    if (entry.startsWith("[")) continue;

    const colonIdx = entry.indexOf(":");
    const rawKey = colonIdx === -1 ? entry : entry.slice(0, colonIdx);
    const key = rawKey.trim().replace(/^['"`]|['"`]$/g, "");
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;

    // Default the folder to the key name. Override if a literal `base:`
    // appears in the entry's value — or, for shorthand entries (`{ docs }`),
    // in the local `const|let|var docs = …` declaration the shorthand
    // refers to.
    const valueText =
      colonIdx === -1
        ? findLocalDeclarationValue(stripped, key)
        : entry.slice(colonIdx + 1);
    const baseMatch = valueText.match(/\bbase\s*:\s*["']([^"']+)["']/);
    out.set(key, baseMatch ? baseMatch[1]! : key);
  }

  return out;
}

/**
 * Locate `const|let|var <identifier> = <value>` at any depth in the source
 * and return the captured `<value>` text. Used to resolve shorthand
 * collection entries (`{ docs }` in the registration object refers to a
 * `const docs = defineCollection(...)` declared somewhere above).
 *
 * The walker is brace/bracket/paren-aware and string-literal-aware so the
 * captured value spans nested object/function-call expressions without
 * losing depth. It stops at the next top-level `;` or end-of-input.
 *
 * Limitations (false negatives — never false positives):
 *   - Identifiers imported from other modules can't be resolved (we don't
 *     follow imports).
 *   - Type-only annotations using `=>` (`const docs: () => X = …`) would
 *     fool the `=` detection. Realistic collection declarations don't use
 *     this shape; if a user does, the check falls back to the key.
 */
function findLocalDeclarationValue(
  source: string,
  identifier: string,
): string {
  const safeId = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${safeId}\\b`, "g");

  let match: RegExpExecArray | null;
  while ((match = declRe.exec(source)) !== null) {
    const afterId = match.index + match[0].length;
    const eqIdx = findAssignmentEquals(source, afterId);
    if (eqIdx === -1) continue;
    const endIdx = findStatementEnd(source, eqIdx + 1);
    return source.slice(eqIdx + 1, endIdx);
  }
  return "";
}

/**
 * Find the first `=` after `from` that's an assignment operator —
 * skipping `==`, `===`, and `=>`. Used to locate where the assignment
 * value begins in `const id [: Type] = value;`.
 */
function findAssignmentEquals(source: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] !== "=") continue;
    if (source[i + 1] === "=") {
      i++; // skip `==` (and `===` since next iter handles the trailing `=`)
      continue;
    }
    if (source[i + 1] === ">") {
      i++; // skip `=>`
      continue;
    }
    if (source[i - 1] === "!" || source[i - 1] === "<" || source[i - 1] === ">") {
      continue; // `!=`, `<=`, `>=`
    }
    return i;
  }
  return -1;
}

/**
 * Walk forward from `from` tracking brace/bracket/paren depth and string
 * literals; return the index of the statement terminator.
 *
 * Terminates at the first of:
 *   1. A top-level `;`.
 *   2. A top-level newline that occurs *after* the value expression has
 *      produced any non-whitespace content. This is the ASI rule the
 *      walker has to honor for semicolonless code:
 *
 *      ```
 *      const docs = defineCollection(docsCollection())   // ← stop here
 *      export const collections = { … }                  // ← not part of `docs`
 *      ```
 *
 *      Without the ASI rule the walker would swallow the next statement
 *      and the `base:` regex could read an unrelated value.
 *   3. End-of-input.
 *
 * The "after non-whitespace" gate handles the leading-newline case:
 *
 *      ```
 *      const docs =
 *        defineCollection(docsCollection({ base: "x" }))
 *      ```
 *
 *      Here the newline right after `=` doesn't terminate; the walker
 *      keeps scanning until the value starts. Once content has been seen,
 *      the next top-level newline ends the statement.
 *
 * Limitations: method-chain continuations like `defineCollection(…)\n  .extend(…)`
 * stop at the first `)`. That captures the inner call's options (where any
 * `base:` would live), so the result is still correct in practice.
 */
function findStatementEnd(source: string, from: number): number {
  let depth = 0;
  let inString: string | null = null;
  let sawContent = false;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      sawContent = true;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      sawContent = true;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
    } else if (ch === ";" && depth === 0) {
      return i;
    } else if (ch === "\n" && depth === 0 && sawContent) {
      return i;
    } else if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
      sawContent = true;
    }
  }
  return source.length;
}

// ---------------------------------------------------------------------------
// Reserved-name filter
// ---------------------------------------------------------------------------

/**
 * Collection names that should never appear in the agent-facing index,
 * regardless of how they were registered. The rule pair is intentionally
 * minimal so the convention is easy to remember:
 *
 *   - `partials` — Nimbus's built-in factory for `<Render slug=…/>`
 *     snippets. They're component content, not pages.
 *   - any name starting with `_` — author-chosen "loaded but internal"
 *     marker (e.g. `_drafts`, `_archive`, `_legacy`).
 */
const RESERVED_LITERAL = new Set(["partials"]);
const RESERVED_PREFIX = "_";

export function filterIndexableCollections(names: string[]): string[] {
  return names.filter(
    (name) => !RESERVED_LITERAL.has(name) && !name.startsWith(RESERVED_PREFIX),
  );
}
