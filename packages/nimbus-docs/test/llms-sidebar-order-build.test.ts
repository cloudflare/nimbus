// `llms.txt`, the section indexes and `llms-full.txt` list pages as the sidebar
// reads them (`sidebar.order`, then label), not by URL. A page the sidebar
// hides follows the ones it shows, by URL.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const endpoints = JSON.stringify("@cloudflare/nimbus-docs/agent-endpoints");
const page = (title: string, order?: number, extra = "") =>
  `---\ntitle: ${title}\n${order === undefined ? "" : `sidebar:\n  order: ${order}\n`}${extra}---\n\n${title} body.\n`;

test("indexes and llms-full.txt follow the sidebar's order", { timeout: 300_000 }, async () => {
  const site = await sites.buildSite(
    {
      "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = { docs: defineCollection(docsCollection()) };`,
      "src/pages/[...slug].astro": `---
import { getDocsStaticPaths, getDocsPageProps, getSidebar } from ${runtime};
export const getStaticPaths = getDocsStaticPaths;
const { entry, Content } = await getDocsPageProps(Astro);
const labels = (items) => items.flatMap((item) => [item.label, ...(item.type === "group" ? labels(item.children) : [])]);
---
<html><body><nav>{labels(await getSidebar("/")).join("|")}</nav><Content /></body></html>
`,
      "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
      "src/pages/llms.txt.ts": `import { llmsRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`,
      "src/pages/llms-full.txt.ts": `import { llmsFullRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`,
      "src/pages/[...section]/llms.txt.ts": `import { llmsSectionRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`,
      "src/content/docs/index.mdx": page("Home", 0),
      // Sidebar order against URL order.
      "src/content/docs/zeta/index.mdx": page("Zeta", 1),
      "src/content/docs/zeta/start.mdx": page("Start here", 1),
      "src/content/docs/guides/index.mdx": page("Guides", 2),
      "src/content/docs/guides/configure.mdx": page("Configure", 2),
      "src/content/docs/guides/deploy.mdx": page("Deploy", 1),
      "src/content/docs/guides/troubleshoot.mdx": page("Troubleshoot", 3),
      // Hidden from the sidebar, still listed: after the shown pages, by URL.
      "src/content/docs/guides/appendix.mdx": page("Appendix", undefined, "sidebar:\n  hidden: true\n"),
    },
    { packageImports: true, logLevel: "warn" },
  );
  const read = (file: string) => readFile(path.join(site.root, "dist", file), "utf8");
  const titles = (body: string) => [...body.matchAll(/^- \[([^\]]+)\]/gm)].map((match) => match[1]!);

  // The order the sidebar shows, as the page renders it.
  const shown = /<nav>([^<]*)<\/nav>/.exec(await read("guides/deploy/index.html"))![1]!.split("|");
  assert.ok(shown.indexOf("Zeta") < shown.indexOf("Guides"), shown.join(", "));
  assert.ok(shown.indexOf("Deploy") < shown.indexOf("Configure") && shown.indexOf("Configure") < shown.indexOf("Troubleshoot"), shown.join(", "));

  assert.deepEqual(titles(await read("guides/llms.txt")), ["Guides", "Deploy", "Configure", "Troubleshoot", "Appendix"]);
  // The root lists its sections where the sidebar has them.
  const root = titles(await read("llms.txt"));
  assert.ok(root.indexOf("Zeta") < root.indexOf("Guides"), root.join(", "));

  const full = await read("llms-full.txt");
  const blocks = [...full.matchAll(/^# (.+)$/gm)].map((match) => match[1]!).slice(1);
  const at = (title: string) => blocks.indexOf(title);
  assert.ok(at("Zeta") < at("Guides") && at("Deploy") < at("Configure") && at("Configure") < at("Troubleshoot") && at("Troubleshoot") < at("Appendix"), blocks.join(", "));

  // The same site gives the same files.
  const again = await sites.buildSite({}, { packageImports: true, logLevel: "warn", root: site.root });
  const reread = (file: string) => readFile(path.join(again.root, "dist", file), "utf8");
  assert.equal(await reread("guides/llms.txt"), await read("guides/llms.txt"));
  assert.equal(await reread("llms-full.txt"), full);
});
