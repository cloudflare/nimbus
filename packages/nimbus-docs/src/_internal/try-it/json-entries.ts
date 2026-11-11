/**
 * A JSON object body as its top-level entries, each value kept as the text it
 * was written as: a form over the body edits one entry and leaves the others,
 * numbers included, exactly as typed.
 */
export interface JsonEntry {
  key: string;
  /** The value's JSON text, indented as if it stood alone. */
  raw: string;
}

/** The entries of `text` when it's one JSON object, each key once, in order;
 *  otherwise `null`. A repeated key has no one value to edit. */
export function jsonEntries(text: string): JsonEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Valid JSON from here: the scan only has to find where each value ends.
  const entries: JsonEntry[] = [];
  const seen = new Set<string>();
  let i = text.indexOf("{") + 1;
  // Where the scan's line starts, and whether only whitespace precedes it: a key's indent.
  let lineStart = 0;
  let blank = false;
  const skip = () => {
    while (/\s/.test(text[i] ?? "")) {
      if (text[i] === "\n") {
        lineStart = i + 1;
        blank = true;
      }
      i++;
    }
  };
  const string = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return text.slice(start, i);
  };
  for (;;) {
    skip();
    if (text[i] === "}") break;
    if (text[i] === ",") {
      i++;
      blank = false;
    }
    skip();
    const indent = blank ? i - lineStart : 0;
    const key = JSON.parse(string()) as string;
    if (seen.has(key)) return null;
    seen.add(key);
    skip();
    i++; // the colon
    skip();
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        string();
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      i++;
    }
    entries.push({ key, raw: dedent(text.slice(start, i).trimEnd(), indent) });
    blank = false;
  }
  return entries;
}

/** `entries` as a JSON object, two spaces per level. A value that isn't valid
 *  JSON is written as given, so the text shows what was typed. */
export function jsonObject(entries: readonly JsonEntry[]): string {
  if (entries.length === 0) return "{}";
  return `{\n${entries.map((e) => `  ${JSON.stringify(e.key)}: ${e.raw.replace(/\n/g, "\n  ")}`).join(",\n")}\n}`;
}

// Continuation lines lose the key's indent, so the value reads as if it stood alone.
function dedent(raw: string, by: number): string {
  if (by === 0 || !raw.includes("\n")) return raw;
  return raw.replace(/\n[ \t]*/g, (lead) => `\n${lead.slice(1 + Math.min(by, lead.length - 1))}`);
}
