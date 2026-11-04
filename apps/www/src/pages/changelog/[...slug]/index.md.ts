import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { entryRouteKey } from "@cloudflare/nimbus-docs/runtime";
import type { Release } from "@/components/changelog/changelog";
import { markdownPage, released } from "@/lib/changelog-markdown";

export const prerender = true;

export const getStaticPaths = (async () =>
  (await getCollection("releases")).map((entry) => ({ params: { slug: entryRouteKey(entry.id) }, props: { entry } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props, site }) => {
  const { entry } = props as { entry: Release };
  return new Response(markdownPage(site, { title: entry.data.title, description: released(entry) }, [entry.body ?? ""]), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
