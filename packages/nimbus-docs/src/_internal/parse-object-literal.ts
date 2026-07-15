/**
 * Text-level primitives for reading a top-level `export const <name> = { … }`
 * object literal out of a user's config file *without executing it*.
 *
 * Shared by `parse-components-registry.ts` (reads `src/components.ts`) and
 * `parse-content-collections.ts` (reads `src/content.config.ts`). Both need
 * the same three operations — strip comments, find a matching brace, split
 * top-level commas — so the primitives live here to keep the two parsers in
 * lockstep.
 */

/**
 * Zero out JS line + block comments, replacing each comment's non-newline
 * characters with spaces so character offsets stay aligned with the original
 * source. Offset alignment is load-bearing: callers match a prefix regex and
 * then brace-walk from the match index into this same string.
 *
 * It also defends the walker and the splitter from comment content — an
 * apostrophe in `// the user's content` would otherwise flip the brace walker
 * into "inside a string" mode for the rest of the file, and a comma in
 * `// foo, bar` would split an entry that doesn't exist.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}

/**
 * Starting from an opening brace at `openIdx`, walk forward tracking brace
 * depth (skipping string literals) and return the index of the matching close
 * brace. Returns `-1` if none is found — which only happens on a syntactically
 * broken file. Strip comments first so quotes/braces inside them don't fool it.
 */
export function findMatchingBrace(input: string, openIdx: number): number {
  if (input[openIdx] !== "{") return -1;
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIdx; i < input.length; i++) {
    const ch = input[i];
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
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a string on commas at depth 0 (not inside `{}`, `[]`, `()`, or a
 * string literal). Required because object entries can themselves contain
 * commas, e.g. `docs: defineCollection(docsCollection({ a: 1, b: 2 }))`.
 */
export function splitTopLevelCommas(input: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  let inString: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      result.push(input.slice(start, i));
      start = i + 1;
    }
  }
  result.push(input.slice(start));
  return result;
}
