import type { APIRoute, GetStaticPaths } from "astro";
import { markdownPage } from "@/lib/changelog-markdown";
import { authorProfiles, getPosts, postBodyMarkdown, postDate, type Post } from "@/lib/blog";

export const prerender = true;

export const getStaticPaths = (async () =>
  (await getPosts()).map((post) => ({ params: { slug: post.id }, props: { post } }))) satisfies GetStaticPaths;

// The post as Markdown, for agents: who wrote it and when, then the post.
export const GET: APIRoute = ({ props, site }) => {
  const { post } = props as { post: Post };
  const profiles = authorProfiles(post.data.author);
  const byline = `By ${post.data.author}${profiles ? ` ([${profiles.handle}](${profiles.x}), [LinkedIn](${profiles.linkedin}))` : ""}, ${postDate(post.data.date)}.`;
  const body = markdownPage(site, { title: post.data.title, description: post.data.description }, [
    `> ${post.data.description}`,
    "",
    byline,
    "",
    postBodyMarkdown(post),
  ]);
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
