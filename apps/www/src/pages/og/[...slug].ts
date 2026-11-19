import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { authorProfiles, postDate } from "@/lib/blog";
import { renderBlogOgCard, renderDocsOgCard } from "./_renderer";

type DocsProps = { section: string; title: string };
type PostProps = { title: string; author: string; date: string; photo?: string };
type OgProps = DocsProps | PostProps;

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
      } satisfies DocsProps,
    };
  });
  // The blog's index shares the docs' card; each post's card adds its
  // author and date. Both at the URLs their pages name.
  const posts = [
    { params: { slug: "blog.png" }, props: { section: "Nimbus", title: "Blog" } satisfies DocsProps },
    ...(await getCollection("blog", (e) => !e.data.draft)).map((entry) => ({
      params: { slug: `blog/${entry.id}.png` },
      props: {
        title: entry.data.title,
        author: entry.data.author,
        date: postDate(entry.data.date),
        photo: authorProfiles(entry.data.author)?.photo,
      } satisfies PostProps,
    })),
  ];
  return [...docs, ...posts];
};

export const GET: APIRoute = async ({ props }) => {
  const og = props as OgProps;
  const png = "author" in og ? await renderBlogOgCard(og) : await renderDocsOgCard(og);
  return new Response(png, {
    headers: { "Content-Type": "image/png" },
  });
};
