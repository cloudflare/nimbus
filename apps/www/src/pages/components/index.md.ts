/**
 * Static markdown alternate for /components/. Mirrors what the dynamic
 * `[...slug]/index.md.ts` route does for content entries, but for the
 * hand-written /components page.
 */
import { config } from "virtual:nimbus/config";

export const prerender = true;

const components = [
  "Aside", "Badge", "Card / CardGrid", "LayerCard", "Frame", "Embed",
  "FileTree", "LinkCard", "LinkButton", "Code", "CodeGroup",
  "PackageManagers", "Steps / Step", "Accordion", "Collapsible", "Tabs",
  "Popover", "Dialog",
];

export function GET() {
  const body = [
    "---",
    `title: "Components"`,
    `description: "Every Nimbus component, rendered with every variant."`,
    "---",
    "",
    "> Documentation Index",
    `> Fetch the complete documentation index at: ${new URL("/llms.txt", config.site).href}`,
    "> Use this file to discover all available pages before exploring further.",
    "",
    "# Components",
    "",
    "Every Nimbus component, rendered with every variant.",
    "",
    ...components.map((c) => `- ${c}`),
    "",
    `Source: ${new URL("/components/index.md", config.site).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
