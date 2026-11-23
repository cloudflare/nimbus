/**
 * Page text written into a generated Markdown line (`llms.txt` rows, page
 * headings). Readers are mostly agents reading the raw text, so the text
 * stays as the author wrote it except where it would change the line's
 * structure.
 */

/** Text on one line: a newline would end the heading or list item and could
 * start a heading or list of its own. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Text as a link's label: one line, with `\`, `[` and `]` escaped so the
 * label can't end early, nest a link, or escape the closing bracket. */
export function linkLabel(text: string): string {
  return oneLine(text).replace(/[\\[\]]/g, "\\$&");
}
