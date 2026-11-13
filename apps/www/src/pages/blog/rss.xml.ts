// The blog's feed, newest first; a post without a date is left out.
import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";

export const prerender = true;

export async function GET() {
  const url = (path: string) => new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;
  const posts = (await getCollection("blog", (e) => e.id !== "index" && !e.data.draft && e.data.date))
    .sort((a, b) => b.data.date!.getTime() - a.data.date!.getTime());
  return rss({
    title: `${config.title} blog`,
    description: "Posts on writing and publishing documentation for people and coding agents.",
    site: url("/blog/"),
    xmlns: { atom: "http://www.w3.org/2005/Atom" },
    customData:
      `<language>${config.locale ?? "en"}</language>` +
      `<atom:link href="${url("/blog/rss.xml")}" rel="self" type="application/rss+xml"/>`,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      link: url(`/blog/${post.id}/`),
      pubDate: post.data.date,
    })),
  });
}
