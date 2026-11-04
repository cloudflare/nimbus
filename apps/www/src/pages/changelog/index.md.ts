import type { APIRoute } from "astro";
import { CHANGELOG_DESCRIPTION, getReleaseIndex } from "@/components/changelog/changelog";
import { CHANGELOG_TITLE, changelogLine, markdownPage, released } from "@/lib/changelog-markdown";

export const prerender = true;

// Like /changelog/: the newest releases in full, then every release.
export const GET: APIRoute = async ({ site }) => {
  const { releases, pages } = await getReleaseIndex();
  const body = [
    CHANGELOG_DESCRIPTION,
    "",
    ...pages[0]!.flatMap((entry) => [`## ${entry.data.title}`, "", ...(released(entry) ? [released(entry)!, ""] : []), entry.body ?? "", ""]),
    "## Every release",
    "",
    ...releases.map((entry) => changelogLine(site, entry)),
  ];
  return new Response(markdownPage(site, { title: CHANGELOG_TITLE, description: CHANGELOG_DESCRIPTION }, body), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
