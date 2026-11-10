/**
 * /community-recipes/showcase/index.md: the showcase's Markdown version, from
 * the same listing and copy as the page.
 */
import type { APIRoute } from "astro";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { communityRecipes } from "@/data/community-recipes";
import { SHOWCASE, showcaseMarkdown } from "@/lib/community-recipes-markdown";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const url = (path: string) => new URL(withBase(path, import.meta.env.BASE_URL), site).href;
  const body = [
    "---",
    `title: ${JSON.stringify(SHOWCASE.title)}`,
    `description: ${JSON.stringify(SHOWCASE.description)}`,
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${url("/llms.txt")}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    `# ${SHOWCASE.title}`,
    "",
    showcaseMarkdown(communityRecipes, url),
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
