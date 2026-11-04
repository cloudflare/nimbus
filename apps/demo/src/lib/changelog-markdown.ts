import { getMarkdownPayload } from "@cloudflare/nimbus-docs/agent-endpoints";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import {
  CHANGELOG_DESCRIPTION,
  CHANGELOG_TITLE,
  dateLabel,
  pageHref,
  releaseHref,
  releaseLabel,
  type ReleaseIndex,
} from "@/components/changelog/changelog";

/**
 * A changelog list page's Markdown version, at `<page>/index.md` and at the
 * page's own URL for `Accept: text/markdown`: what the page shows, each
 * release in full (its own published Markdown, links already absolute), then
 * where the other pages are.
 */

const absolute = (site: URL | undefined, path: string) => new URL(withBase(path, import.meta.env.BASE_URL), site).href;

/** One level deeper, so a release's own `## New` nests under the release's heading. Code stays as it is. */
function demoteHeadings(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
      if (marker && (!fence || marker.startsWith(fence))) fence = fence ? undefined : marker;
      return !fence && !marker && /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

export const listMarkdownHref = (page: number) => `${pageHref(page)}index.md`;

export async function listMarkdown(
  site: URL | undefined,
  request: Request,
  index: ReleaseIndex,
  page: number,
): Promise<string | undefined> {
  const list = index.pages[page - 1];
  if (!list) return undefined;
  const notes = await Promise.all(
    list.map(async (entry) => {
      const reference = { collection: "changelog", id: entry.id, surface: "markdown" as const };
      const payload = await getMarkdownPayload({ ...reference, reference, context: { request } });
      return demoteHeadings((payload?.content ?? entry.body ?? "").trim());
    }),
  );
  const title = page === 1 ? CHANGELOG_TITLE : `${CHANGELOG_TITLE}, page ${page}`;
  const description = page === 1 ? CHANGELOG_DESCRIPTION : `Releases on page ${page} of ${index.pages.length}.`;
  const release = list.flatMap((entry, i) => [
    `## [${releaseLabel(entry)}](${absolute(site, `${releaseHref(entry)}index.md`)})`,
    "",
    [dateLabel(entry.data.date, "long"), ...(entry.data.tags ?? [])].join(" · "),
    "",
    ...(entry.data.version ? [`**${entry.data.title}**`, ""] : []),
    notes[i]!,
    "",
  ]);
  const pages = index.pages.map((_, i) =>
    i + 1 === page ? `- Page ${i + 1} (this page)` : `- [Page ${i + 1}](${absolute(site, listMarkdownHref(i + 1))})`,
  );
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absolute(site, "/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    `# ${title}`,
    "",
    description,
    "",
    ...release,
    "## Pages",
    "",
    ...pages,
    "",
    `RSS: ${absolute(site, "/changelog/rss.xml")}`,
    "",
  ].join("\n");
}

export const markdownResponse = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" } });
