/**
 * Per-page `/api/<slug>/index.md` - the clean-markdown alternate for every
 * entry of the `api` reference collection. Sibling to the primary-collection
 * twin at `pages/[...slug]/index.md.ts`; filtering to `api` keeps the two
 * rest routes from generating conflicting paths.
 */

import {
  getIndexedEntries,
  renderIndexedEntryMarkdown,
  type IndexedEntry,
  withBase,
} from "@cloudflare/nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const API_COLLECTION = "api";
const absoluteUrl = (path: string) =>
  new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;

interface SlugProps {
  item: IndexedEntry;
}

export async function getStaticPaths() {
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => item.collection === API_COLLECTION)
    .map((item) => ({
      // The root overview has entry id "index" -> emit at `/api/index.md`
      // (undefined rest segment). Every other page emits at
      // `/api/<id>/index.md`.
      params: {
        slug: item.entry.id === "index" ? undefined : item.entry.id,
      },
      props: { item } as SlugProps,
    }));
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props;
  const { title, description, markdownUrl, sourceUrl, version } = item;

  const markdown = await renderIndexedEntryMarkdown(item, {
    base: import.meta.env.BASE_URL,
  });

  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(config.socialImage
      ? [`image: ${JSON.stringify(absoluteUrl(config.socialImage))}`]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absoluteUrl("/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    markdown,
    "",
    // API pages have no authored `.mdx` source, so `sourceUrl` is undefined -
    // fall back to the `.md` twin's own URL.
    `Source: ${absoluteUrl(sourceUrl ?? markdownUrl)}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
