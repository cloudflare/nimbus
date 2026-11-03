// A repository's docs folder as GitHub renders it: no frontmatter, a heading
// for a title, relative `.md` links between pages and one out to the
// repository's readme. Pages get their heading as title (and sidebar label),
// links between them become page URLs in the HTML and the Markdown version,
// and the link out stays as written with a warning.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "astro";
import { JSDOM } from "jsdom";

import { titleFromFile } from "../src/content.ts";
import { gitRemote } from "./fixtures/git-remote.ts";
import { paritySite, src } from "./fixtures/parity-site.ts";

const route = [
  "---",
  `import { getCollectionStaticPaths, getCollectionPage, getSidebar } from ${src("runtime.ts")};`,
  "export const prerender = true;",
  `export const getStaticPaths = getCollectionStaticPaths("sdk");`,
  "const page = await getCollectionPage(Astro);",
  "if (page instanceof Response) return page;",
  "const { entry, Content } = page;",
  "const sidebar = await getSidebar(Astro.url.pathname, { collection: entry.collection });",
  "const labels = JSON.stringify(sidebar.flatMap(function walk(item) { return item.type === 'group' ? item.children.flatMap(walk) : [item.label]; }));",
  "---",
  `<html><head><title>{entry.data.title}</title></head><body><nav data-labels={labels}></nav><main><Content /></main></body></html>`,
].join("\n");

test("a plain Markdown docs folder builds with heading titles, page links and sidebar labels", async () => {
  const site = await paritySite({
    extraCollections: [`sdk: defineCollection(docsCollection({ source: "sdk" }))`],
    routes: { "src/pages/sdk/[...slug].astro": route },
    nimbus: { sidebar: { items: [{ label: "SDK", autogenerate: { collection: "sdk" } }] } },
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const remote = await gitRemote(path.join(site.root, "remotes"), {
      "readme.md": "# SDK\n",
      "docs/1-promise.md": "[> Back to homepage](../readme.md#documentation)\n\n## Promise API\n\nSee [the options](2-options.md#signal) and [streams](./guides/streams.md).\n\n```md\n[not a link](2-options.md)\n```\n",
      "docs/2-options.md": "## `Options` and *more*\n\nBack to [promises](1-promise.md).\n",
      "docs/guides/streams.md": "Streams, with no heading at all.\n\nUp to [options](../2-options.md).\n",
    });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
      warn(...args);
    };
    try {
      await build(site.configure({ sources: { sdk: { repo: remote.bare, ref: "main", path: "docs" } } }));
    } finally {
      console.warn = warn;
    }
    const doc = new JSDOM(await site.read("dist/sdk/1-promise/index.html")).window.document;
    assert.equal(doc.title, "Promise API");
    const hrefs = [...doc.querySelectorAll("main a")].map((a) => a.getAttribute("href"));
    assert.deepEqual(hrefs, ["../readme.md#documentation", "/sdk/2-options/#signal", "/sdk/guides/streams/"]);
    assert.match(doc.querySelector("main pre")!.textContent!, /\[not a link\]\(2-options\.md\)/, "code stays as written");
    assert.deepEqual(
      (JSON.parse(doc.querySelector("nav")!.getAttribute("data-labels")!) as string[]).sort(),
      ["Options and more", "Promise API", "Streams"],
    );

    const twin = await site.read("dist/sdk/1-promise/index.md");
    assert.match(twin, /\[the options\]\(https:\/\/docs\.example\.test\/sdk\/2-options\/#signal\)/);
    assert.match(await site.read("dist/sdk/guides/streams/index.html"), /href="\/sdk\/2-options\/"/);
    // Lint reads MDX, and says how many Markdown pages that leaves out.
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const lint = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)), "lint", "--rule", "nimbus/single-h1"],
      { cwd: site.root, encoding: "utf8" },
    );
    assert.match(lint.stderr, /4 Markdown \(\.md\) pages not linted: lint reads \.mdx files\./, lint.stderr);
    assert.ok(
      warnings.some((w) => /sdk: 1-promise\.md links to "\.\.\/readme\.md#documentation", which isn't a page of this collection/.test(w)),
      warnings.join("\n"),
    );
  } finally {
    await site.remove();
  }
});

test("a title comes from the first heading outside code, else the file name", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { TEST_TMP } = await import("./fixtures/temp-root.ts");
  const dir = mkdtempSync(path.join(TEST_TMP, "nimbus-title-"));
  try {
    const file = (name: string, body: string) => (writeFileSync(path.join(dir, name), body), path.join(dir, name));
    assert.equal(titleFromFile(file("a.md", "```\n# not this\n```\n\n### [Linked](x.md) title ###\n"), "a"), "Linked title");
    assert.equal(titleFromFile(file("b.md", "---\nfoo: 1\n---\n# From body\n"), "b"), "From body");
    assert.equal(titleFromFile(file("c.md", "No headings here.\n"), "guides/getting-started"), "Getting Started");
    assert.equal(titleFromFile(undefined, "x/quick-start"), "Quick Start");
    assert.equal(titleFromFile(file("d.md", "## The <code>Client</code> class <script>x</script>\n"), "d"), "The Client class x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source collection's links follow its route when it moves, on a warm cache", async () => {
  // The route imports the package by name, as a site does, so the build reads which collection it serves.
  const movedRoute = route
    .replace(src("runtime.ts"), JSON.stringify("@cloudflare/nimbus-docs/runtime"))
    .replace("getSidebar(Astro.url.pathname, ", "getSidebar(Astro.url.pathname.replace(import.meta.env.BASE_URL.replace(/[/]$/, ''), ''), ");
  const site = await paritySite({
    extraCollections: [`sdk: defineCollection(docsCollection({ source: "sdk" }))`],
    routes: { "src/pages/sdk/[...slug].astro": movedRoute },
    nimbus: { sidebar: { items: [{ label: "SDK", autogenerate: { collection: "sdk" } }] } },
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const remote = await gitRemote(path.join(site.root, "remotes"), {
      "docs/1-promise.md": "## Promise API\n\nSee [the options](2-options.md#signal).\n",
      "docs/2-options.md": "## Options\n\nBack to [promises](1-promise.md).\n",
    });
    const config = site.configure({ sources: { sdk: { repo: remote.bare, ref: "main", path: "docs" } } });
    const pkg = path.resolve(import.meta.dirname, "../src");
    const run = () =>
      build({
        ...config,
        vite: {
          ...config.vite,
          resolve: {
            alias: [
              { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(pkg, "index.ts") },
              { find: /^@cloudflare\/nimbus-docs\//, replacement: `${pkg}/` },
            ],
          },
        },
      });
    const links = async (url: string) =>
      [...new JSDOM(await site.read(`dist${url}1-promise/index.html`)).window.document.querySelectorAll("main a")].map((a) => a.getAttribute("href"));

    await run();
    assert.deepEqual(await links("/sdk/"), ["/sdk/2-options/#signal"]);

    const { rm } = await import("node:fs/promises");
    await rm(path.join(site.root, "src/pages/sdk"), { recursive: true });
    await site.write("src/pages/integrations/dbt/[...slug].astro", movedRoute);
    await run();
    assert.deepEqual(await links("/integrations/dbt/"), ["/integrations/dbt/2-options/#signal"]);
    assert.match(await site.read("dist/integrations/dbt/1-promise/index.md"), /\[the options\]\(https:\/\/docs\.example\.test\/integrations\/dbt\/2-options\/#signal\)/);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(path.join(site.root, "dist/sdk")));
  } finally {
    await site.remove();
  }
});
