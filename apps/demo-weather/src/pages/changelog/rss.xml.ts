/**
 * /changelog/rss.xml — the recipe's RSS 2.0 feed. Ticket 8 moves this onto
 * @astrojs/rss.
 */
import { getCollection } from "astro:content";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export async function GET() {
  const site = config.site ?? "http://localhost:4321";
  const feedUrl = new URL(withBase("/changelog/rss.xml", import.meta.env.BASE_URL), site).href;
  const channelLink = new URL(withBase("/changelog/", import.meta.env.BASE_URL), site).href;
  const entries = (await getCollection("changelog", (e) => !e.data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );
  const items = entries.map((entry) => {
    const url = new URL(withBase(`/changelog/${entry.id}/`, import.meta.env.BASE_URL), site).href;
    const { title, description, date, tags } = entry.data;
    return [
      "    <item>",
      `      <title>${esc(title)}</title>`,
      `      <link>${url}</link>`,
      `      <guid isPermaLink="true">${url}</guid>`,
      `      <pubDate>${date.toUTCString()}</pubDate>`,
      ...(description ? [`      <description>${esc(description)}</description>`] : []),
      ...tags.map((t) => `      <category>${esc(t)}</category>`),
      "    </item>",
    ].join("\n");
  });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${esc(config.title)} Changelog</title>`,
    `    <link>${channelLink}</link>`,
    `    <description>${esc(config.description ?? "Changelog")}</description>`,
    "    <language>en</language>",
    `    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />`,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
