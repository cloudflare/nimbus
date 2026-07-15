/**
 * Extract registered MDX global names from the user's `src/components.ts`.
 *
 * The framework needs this list to validate PascalCase tags in MDX at
 * build time, but it must not execute user code at build time. Strategy:
 * read the file as text, locate the `export const components = { ... }`
 * declaration, and parse its top-level keys.
 *
 * Supported entry shapes inside the object literal:
 *   - shorthand:   `Foo,`            → "Foo"
 *   - aliased:     `Foo: Other,`     → "Foo" (the key)
 *   - string key:  `"Foo": Other,`   → "Foo"
 *
 * Skipped (no false-positive failures):
 *   - spread elements (`...other`)
 *   - computed keys (`[expr]: value`)
 *   - lowercase keys (not PascalCase, so not validator-relevant)
 *
 * Returns:
 *   - `string[]` of registered names when the file exists and the pattern
 *     matches.
 *   - `null` when the file is missing OR present but doesn't expose a
 *     parseable `export const components = { ... }`. The caller decides
 *     whether to warn or skip validation.
 */

import fs from "node:fs/promises";

import {
  findMatchingBrace,
  splitTopLevelCommas,
  stripComments,
} from "./parse-object-literal.js";

// Locate the start of the `export const components = {` declaration; the
// matching close brace is found by walking braces.
const EXPORT_PREFIX_PATTERN =
  /export\s+const\s+components\s*(?::\s*[^=]+)?=\s*\{/;

export async function parseComponentsRegistry(
  filePath: string,
): Promise<string[] | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  // Zero out comments before locating the object so offsets stay aligned for
  // the brace walk and commas inside `// foo, bar` don't split entries.
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

    if (/^[A-Z][A-Za-z0-9_]*$/.test(key)) names.push(key);
  }

  return names;
}
