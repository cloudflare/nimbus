import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { CHANGELOG_TITLE, dateLabel, releaseHref, type Release } from "@/components/changelog/changelog";

/**
 * Markdown for the changelog: each release's notes at
 * `/changelog/<release>/index.md`, the list at `/changelog/index.md`, and a
 * `/changelog/llms.txt` index that the site's `llms.txt` links.
 */

export const absolute = (site: URL | undefined, path: string) =>
  new URL(withBase(path, import.meta.env.BASE_URL), site).href;

export const releaseMarkdownHref = (entry: Release) => `${releaseHref(entry)}index.md`;

export function markdownPage(site: URL | undefined, fields: { title: string; description?: string }, body: string[]): string {
  return [
    "---",
    `title: ${JSON.stringify(fields.title)}`,
    ...(fields.description ? [`description: ${JSON.stringify(fields.description)}`] : []),
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absolute(site, "/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    `# ${fields.title}`,
    "",
    ...body,
    "",
  ].join("\n");
}

export const released = (entry: Release) => (entry.data.date ? `Released ${dateLabel(entry.data.date, "long")}.` : undefined);

export const changelogLine = (site: URL | undefined, entry: Release) =>
  `- [${entry.data.title}](${absolute(site, releaseMarkdownHref(entry))})${entry.data.date ? ` — ${dateLabel(entry.data.date, "long")}` : ""}`;

export { CHANGELOG_TITLE };
