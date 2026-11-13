import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { renderDocsOgCard } from "./_renderer";

type OgProps = { section: string; title: string };

// Prerender every card as a static asset: image generation needs Node.
export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection("docs", (e) => !e.data.draft);
  // A page's section names its top-level folder the way the site does
  // elsewhere: the folder index's group label, else its title, else the
  // folder. Pages at the root are "Docs".
  const groups = new Map<string, string>();
  for (const entry of entries) {
    // Only a folder's own index names its section (a root index isn't one).
    if (entry.id === "index" || entry.id.includes("/") || !/\/index\.mdx?$/.test(entry.filePath ?? "")) continue;
    const sidebar = entry.data.sidebar;
    groups.set(entry.id, (sidebar ? sidebar.group?.label : undefined) ?? entry.data.title);
  }
  const docs = entries.map((entry) => {
    const top = entry.id.split("/")[0]!;
    return {
      params: { slug: `${entry.id}.png` },
      props: {
        section: groups.get(top) ?? (entry.id.includes("/") ? top : "Docs"),
        title: entry.data.title,
      } satisfies OgProps,
    };
  });
  // Blog posts share the docs' card, under "Blog", at the URL their pages name.
  const posts = (await getCollection("blog", (e) => !e.data.draft)).map((entry) => ({
    params: { slug: `blog/${entry.id}.png` },
    props: { section: "Blog", title: entry.data.title } satisfies OgProps,
  }));
  return [...docs, ...posts];
};

export const GET: APIRoute = async ({ props }) => {
  const png = await renderDocsOgCard(props as OgProps);
  return new Response(png, {
    headers: { "Content-Type": "image/png" },
  });
};
