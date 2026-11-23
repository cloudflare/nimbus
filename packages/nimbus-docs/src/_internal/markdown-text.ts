/**
 * Page text written into a generated Markdown line (`llms.txt` rows, page
 * headings). Readers are mostly agents reading the raw text, so the text
 * stays as the author wrote it except where it would change the line's
 * structure.
 */

/** Text on one line: a line break would end the heading or list item and
 * could start a heading or list of its own. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Text as a link's label, on one line, that can't end early, nest a link,
 * or run past the label. A code span whose backticks close within the label
 * is literal in CommonMark and stays as written; elsewhere `\`, `[`, `]`
 * and `<` are escaped (a link can't end early, nest, or have HTML or an
 * autolink run past it), as are backticks no run closes and backticks after
 * a backslash, which the author's text has as plain characters.
 */
export function linkLabel(text: string): string {
  const flat = oneLine(text);
  // A run after a backslash is plain text: its backticks are escaped below.
  const runs = [...flat.matchAll(/`+/g)].filter((run) => !/(?:^|[^\\])(?:\\\\)*\\$/.test(flat.slice(0, run.index)));
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    const close = runs.findIndex((run, j) => j > i && run[0].length === open[0].length);
    if (close === -1) continue;
    spans.push([open.index, runs[close]!.index + runs[close]![0].length]);
    i = close;
  }
  const escape = (part: string) => part.replace(/[\\[\]`<]/g, "\\$&");
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    out += escape(flat.slice(at, start)) + flat.slice(start, end);
    at = end;
  }
  return out + escape(flat.slice(at));
}
