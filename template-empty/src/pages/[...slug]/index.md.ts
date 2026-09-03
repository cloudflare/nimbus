/**
 * Per-page `/<slug>/index.md` — the clean-markdown alternate for every
 * indexable entry of the primary `docs` collection.
 *
 * Non-primary collections (`api`, `blog`, …) mount under their own
 * URL namespace by convention; their `.md` alternates live at the
 * sibling route `pages/<collection>/[...slug]/index.md.ts`. This route
 * filters to the primary collection so multi-collection sites don't
 * generate conflicting `[...slug]` paths at root.
 */

import {
  getEntryMarkdown,
  getIndexedEntries,
  type IndexedEntry,
  withBase,
} from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";

export const prerender = true;

const PRIMARY_COLLECTION = "docs";
const absoluteUrl = (path: string) =>
  new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;

interface SlugProps {
  item: IndexedEntry;
}

export async function getStaticPaths() {
  const indexed = await getIndexedEntries();
  return indexed
    .filter((item) => item.collection === PRIMARY_COLLECTION)
    .map((item) => ({
      // Root index (`entry.id === "index"`) emits at `/index.md`; Astro's
      // rest-segment treats `undefined` as "no segment" so the URL is
      // `/index.md` rather than `/index/index.md`. Every other entry emits
      // at `/<entry.id>/index.md` — the convention `<page>/index.md`.
      params: {
        slug: item.entry.id === "index" ? undefined : item.entry.id,
      },
      props: { item } as SlugProps,
    }));
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props;
  const { entry, title, description, markdownUrl, sourceUrl, version } = item;
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const rawImage = data.socialImage;
  const socialImage =
    typeof rawImage === "string" && rawImage.length > 0
      ? rawImage
      : config.socialImage;

  const markdown = await getEntryMarkdown(entry);

  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(socialImage
      ? [`image: ${JSON.stringify(absoluteUrl(socialImage))}`]
      : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${absoluteUrl("/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    `# ${title}`,
    "",
    markdown,
    "",
    // Point at the authored source (`.mdx` twin) when it exists — the
    // `.md` alternate referencing itself was a placeholder.
    `Source: ${absoluteUrl(sourceUrl ?? markdownUrl)}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
