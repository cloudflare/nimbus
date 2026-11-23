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
 * is literal in CommonMark and stays as written; elsewhere `\`, `[` and `]`
 * are escaped, as are backticks no run closes (they'd open a span that
 * swallows `](url)`) and a `<` that could open HTML or an autolink.
 */
export function linkLabel(text: string): string {
  const flat = oneLine(text);
  const runs = [...flat.matchAll(/`+/g)];
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    const close = runs.findIndex((run, j) => j > i && run[0].length === open[0].length);
    if (close === -1) continue;
    spans.push([open.index, runs[close]!.index + runs[close]![0].length]);
    i = close;
  }
  const escape = (part: string) => part.replace(/[\\[\]`]|<(?=[A-Za-z/!?])/g, "\\$&");
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    out += escape(flat.slice(at, start)) + flat.slice(start, end);
    at = end;
  }
  return out + escape(flat.slice(at));
}
