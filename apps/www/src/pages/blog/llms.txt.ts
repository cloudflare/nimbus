import type { APIRoute } from "astro";
import { absolute } from "@/lib/changelog-markdown";
import { BLOG, getPosts, postMarkdownHref } from "@/lib/blog";

export const prerender = true;

// The blog's llms.txt, which the site's llms.txt links, as it does the changelog's.
export const GET: APIRoute = async ({ site }) => {
  const posts = await getPosts();
  const body = [
    `# Nimbus ${BLOG.title.toLowerCase()}`,
    "",
    `> ${BLOG.description}`,
    "",
    "## Posts",
    "",
    `- [${BLOG.title}](${absolute(site, "/blog/index.md")}) — Every post, newest first.`,
    ...posts.map((post) => `- [${post.data.title}](${absolute(site, postMarkdownHref(post))}) — ${post.data.description}`),
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
