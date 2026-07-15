import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { renderOgCard } from "./_renderer";

type OgProps = { title: string; description: string };

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection("docs", (e) => !e.data.draft);
  return entries.map((entry) => ({
    params: { slug: `${entry.id}.png` },
    props: {
      title: entry.data.title,
      description: entry.data.description ?? "",
    } satisfies OgProps,
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOgCard(props as OgProps);
  return new Response(png, {
    headers: { "Content-Type": "image/png" },
  });
};
