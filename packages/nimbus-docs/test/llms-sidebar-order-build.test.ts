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

test("an API placed before the docs in the sidebar reads there, in its nav order", { timeout: 300_000 }, async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { TEST_TMP } = await import("./fixtures/temp-root.js");
  const { srcModule } = await import("./fixtures/agent-site.ts");
  const ok = { "200": { description: "ok" } };
  const specDir = await mkdtemp(path.join(TEST_TMP, "nimbus-llms-order-api-"));
  const spec = path.join(specDir, "spec.json");
  // Nav order (list, then create) against URL order (create, then list).
  await writeFile(spec, JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Pets", version: "1" },
    tags: [{ name: "Users" }],
    paths: {
      "/users": {
        get: { operationId: "usersList", summary: "List users", tags: ["Users"], responses: ok },
        post: { operationId: "usersCreate", summary: "Create user", tags: ["Users"], responses: ok },
      },
    },
  }));
  const site = await sites.buildSite(
    {
      "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from "@cloudflare/nimbus-docs/content";
import { apiCollection } from ${srcModule("content.ts")};
export const collections = { docs: defineCollection(docsCollection()), api: defineCollection(apiCollection()) };`,
      "src/pages/[...slug].astro": `---
import { getDocsStaticPaths, getDocsPageProps } from ${runtime};
export const getStaticPaths = getDocsStaticPaths;
const { Content } = await getDocsPageProps(Astro);
---
<html><body><Content /></body></html>
`,
      "src/pages/api/[...slug].astro": `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro, "api");
if (result instanceof Response) return result;
---
<html><body>{result.page.kind}</body></html>
`,
      "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
      "src/pages/llms-full.txt.ts": `import { llmsFullRoute } from ${endpoints};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();\n`,
      "src/pages/runtime-full.txt.ts": `import { renderLlmsFullMarkdown } from ${runtime};\nexport const prerender = true;\nexport const GET = async () => new Response(await renderLlmsFullMarkdown());\n`,
      "src/content/docs/index.mdx": page("Home"),
      "src/content/docs/intro.mdx": page("Intro"),
    },
    {
      packageImports: true,
      logLevel: "warn",
      sidebar: { items: [{ label: "Pets API", autogenerate: { collection: "api" } }, { autogenerate: { directory: "." } }] },
      api: [{ collection: "api", spec, routes: { convention: "resource-action-v2" } }],
    },
  );
  const read = (file: string) => readFile(path.join(site.root, "dist", file), "utf8");
  const headings = (body: string) => [...body.matchAll(/^# (.+)$/gm)].map((match) => match[1]!);
  for (const file of ["llms-full.txt", "runtime-full.txt"]) {
    const order = headings(await read(file));
    const at = (title: string) => order.findIndex((heading) => heading.includes(title));
    assert.ok(at("List users") >= 0 && at("Create user") >= 0 && at("Intro") >= 0, `${file}: ${order.join(", ")}`);
    assert.ok(at("List users") < at("Create user"), `${file}: ${order.join(", ")}`);
    assert.ok(at("Create user") < at("Intro"), `${file}: ${order.join(", ")}`);
  }
});
