import {
  getIndexedEntries,
  renderIndexedEntryMarkdown,
  type IndexedEntry,
  withBase,
} from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";

export const prerender = true;

interface SlugProps {
  item: IndexedEntry;
}

const absoluteUrl = (path: string) =>
  new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;

export async function getStaticPaths() {
  return (await getIndexedEntries())
    .filter((item) => item.collection === "api")
    .map((item) => ({
      params: { slug: item.entry.id === "index" ? undefined : item.entry.id },
      props: { item } as SlugProps,
    }));
}

export async function GET({ props }: { props: SlugProps }) {
  const { item } = props;
  const markdown = await renderIndexedEntryMarkdown(item, {
    base: import.meta.env.BASE_URL,
  });
  return new Response(
    [
      "---",
      `title: ${JSON.stringify(item.title)}`,
      ...(item.description
        ? [`description: ${JSON.stringify(item.description)}`]
        : []),
      "---",
      "",
      markdown,
      "",
      `Source: ${absoluteUrl(item.markdownUrl)}`,
      "",
    ].join("\n"),
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
}
