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

/** The entries of `text` when it's one JSON object, in order; otherwise `null`. */
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
  let i = text.indexOf("{") + 1;
  const skip = () => {
    while (/\s/.test(text[i] ?? "")) i++;
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
    if (text[i] === ",") i++;
    skip();
    const keyStart = i;
    const key = JSON.parse(string()) as string;
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
    entries.push({ key, raw: dedent(text.slice(start, i).trimEnd(), indentAt(text, keyStart)) });
  }
  return entries;
}

/** `entries` as a JSON object, two spaces per level. A value that isn't valid
 *  JSON is written as given, so the text shows what was typed. */
export function jsonObject(entries: readonly JsonEntry[]): string {
  if (entries.length === 0) return "{}";
  return `{\n${entries.map((e) => `  ${JSON.stringify(e.key)}: ${e.raw.replace(/\n/g, "\n  ")}`).join(",\n")}\n}`;
}

// The whitespace a key's line starts with, when the key starts that line.
function indentAt(text: string, at: number): number {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const lead = text.slice(lineStart, at);
  return /^[ \t]*$/.test(lead) ? lead.length : 0;
}

// Continuation lines lose the key's indent, so the value reads as if it stood alone.
function dedent(raw: string, by: number): string {
  if (by === 0 || !raw.includes("\n")) return raw;
  return raw.replace(/\n[ \t]*/g, (lead) => `\n${lead.slice(1 + Math.min(by, lead.length - 1))}`);
}
