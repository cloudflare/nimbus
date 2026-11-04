/**
 * Does this request prefer Markdown over HTML? Markdown wins only when
 * `text/markdown` is acceptable and outranks every HTML and wildcard range;
 * ties and unreadable headers keep HTML, so browsers never see Markdown by
 * accident. The same rule Nimbus applies to its own pages, for the changelog
 * list pages, which are this site's own routes.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  let markdown = 0;
  let html = 0;
  for (const range of accept.split(",")) {
    const [rawType = "", ...params] = range.toLowerCase().split(";");
    const type = rawType.trim();
    if (!/^[\w.+-]+\/[\w.+*-]+$|^\*\/\*$/.test(type)) continue;
    const q = params
      .map((param) => param.trim())
      .find((param) => /^q\s*=/.test(param))
      ?.replace(/^q\s*=\s*/, "");
    if (q !== undefined && !/^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(q)) return false;
    const weight = q === undefined ? 1 : Number(q);
    if (type === "text/markdown") markdown = Math.max(markdown, weight);
    else if (type === "text/html" || type === "text/*" || type === "*/*") html = Math.max(html, weight);
  }
  return markdown > 0 && markdown > html;
}
