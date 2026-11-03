import type { APIRoute } from "astro";
import { CHANGELOG_DESCRIPTION, getReleaseIndex } from "@/components/changelog/changelog";
import { CHANGELOG_TITLE, absolute, changelogLine } from "@/lib/changelog-markdown";

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  const { releases } = await getReleaseIndex();
  const body = [
    `# ${CHANGELOG_TITLE}`,
    "",
    `> ${CHANGELOG_DESCRIPTION}`,
    "",
    "## Pages",
    "",
    `- [${CHANGELOG_TITLE}](${absolute(site, "/changelog/index.md")}) — The newest releases in full, and a list of every release.`,
    ...releases.map((entry) => changelogLine(site, entry)),
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
