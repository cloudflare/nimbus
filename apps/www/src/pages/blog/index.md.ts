import type { APIRoute } from "astro";
import { absolute, markdownPage } from "@/lib/changelog-markdown";
import { BLOG, getPosts, postDate, postMarkdownHref } from "@/lib/blog";

export const prerender = true;

// Like /blog/: the lead, then every post, newest first.
export const GET: APIRoute = async ({ site }) => {
  const posts = await getPosts();
  const body = markdownPage(site, { title: BLOG.title, description: BLOG.description }, [
    ...posts.map((post) => `- [${post.data.title}](${absolute(site, postMarkdownHref(post))}) — ${postDate(post.data.date)}. ${post.data.description}`),
    "",
    `New posts also arrive in the feed: ${absolute(site, "/blog/rss.xml")}`,
  ]);
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
