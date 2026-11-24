// A source collection publishes the files its `pattern` matches. A relative
// link to a Markdown file the pattern leaves out stays as written, with a
// warning that says why, in the page, its Markdown version and lint.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "astro";
import { JSDOM } from "jsdom";

import { globPageMatcher, registerSourceCollectionFolder, rewriteSourceLinks } from "../src/_internal/source-links.ts";
import { gitRemote } from "./fixtures/git-remote.ts";
import { pageRoute, paritySite, type ParitySite } from "./fixtures/parity-site.ts";

async function buildWarnings(site: ParitySite, sources: Record<string, unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
    warn(...args);
  };
  try {
    await build(site.configure({ sources }));
  } finally {
    console.warn = warn;
  }
  return warnings.filter((w) => w.startsWith("[nimbus] "));
}

async function hrefs(site: ParitySite, file: string): Promise<Array<string | null>> {
  const doc = new JSDOM(await site.read(file)).window.document;
  return [...doc.querySelectorAll("main a")].map((a) => a.getAttribute("href"));
}

test("a link to a file the pattern excludes stays as written, with the pattern's warning", async () => {
  const site = await paritySite({
    extraCollections: [`pkg: defineCollection(docsCollection({ source: "pkg", pattern: "{README.md,docs/**/*.md}" }))`],
    routes: { "src/pages/pkg/[...slug].astro": pageRoute("pkg") },
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const remote = await gitRemote(path.join(site.root, "remotes"), {
      "LICENSE.md": "# License\n",
      "pkg/README.md": "# Widget\n\nSee the [changes](./CHANGELOG.md), [usage](./docs/usage.md) and [license](../LICENSE.md).\n",
      "pkg/docs/usage.md": "# Usage\n",
      "pkg/CHANGELOG.md": "# Changes\n",
    });
    const warnings = await buildWarnings(site, { pkg: { repo: remote.bare, ref: "main", path: "pkg" } });

    assert.deepEqual(await hrefs(site, "dist/pkg/readme/index.html"), ["./CHANGELOG.md", "/pkg/docs/usage/", "../LICENSE.md"]);
    const twin = await site.read("dist/pkg/readme/index.md");
    assert.match(twin, /\[changes\]\(\.\/CHANGELOG\.md\)/);
    assert.match(twin, /\[usage\]\(https:\/\/docs\.example\.test\/pkg\/docs\/usage\/\)/);
    assert.match(twin, /\[license\]\(\.\.\/LICENSE\.md\)/);
    assert.deepEqual((await readdir(path.join(site.root, "dist/pkg"))).sort(), ["docs", "llms.txt", "readme"]);
    assert.deepEqual(
      warnings.filter((w) => w.includes("README.md")),
      [
        `[nimbus] pkg: README.md links to "./CHANGELOG.md", which the collection's pattern doesn't publish, ` +
          `and to "../LICENSE.md", which isn't a page of this collection; the links stay as written.`,
      ],
    );
  } finally {
    await site.remove();
  }
});

test("two collections over one folder each link their own pages, and lint uses the page's own collection", async () => {
  const site = await paritySite({
    extraCollections: [
      `readme: defineCollection(docsCollection({ source: "pkg", pattern: "README.md" }))`,
      `guides: defineCollection(docsCollection({ source: "pkg", pattern: "docs/**/*.{md,mdx}" }))`,
    ],
    routes: {
      "src/pages/readme/[...slug].astro": pageRoute("readme"),
      "src/pages/guides/[...slug].astro": pageRoute("guides"),
    },
    // `--rule` alone would force the rule on everywhere; the top-level
    // setting keeps the per-collection ones.
    integration: {
      rules: { "nimbus/internal-link": "error" },
      collections: {
        readme: { rules: { "nimbus/internal-link": "off" } },
        guides: { rules: { "nimbus/internal-link": "error" } },
      },
    },
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const remote = await gitRemote(path.join(site.root, "remotes"), {
      "pkg/README.md": "# Widget\n\nRead the [usage](./docs/usage.md).\n",
      "pkg/docs/usage.md": "# Usage\n\nSee [advanced](./advanced.md) and [the readme](../README.md).\n",
      "pkg/docs/advanced.md": "# Advanced\n",
      "pkg/docs/links.mdx": "# Links\n\nThe [readme](../README.md) and [usage](./usage.md).\n",
    });
    const warnings = await buildWarnings(site, { pkg: { repo: remote.bare, ref: "main", path: "pkg" } });

    assert.deepEqual(await hrefs(site, "dist/guides/docs/usage/index.html"), ["/guides/docs/advanced/", "../README.md"]);
    assert.deepEqual(await hrefs(site, "dist/readme/readme/index.html"), ["./docs/usage.md"]);
    for (const expected of [
      `[nimbus] guides: usage.md links to "../README.md", which the collection's pattern doesn't publish; the link stays as written.`,
      `[nimbus] readme: README.md links to "./docs/usage.md", which the collection's pattern doesn't publish; the link stays as written.`,
    ]) {
      assert.ok(warnings.includes(expected), warnings.join("\n"));
    }

    const lint = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)),
        "lint",
        "--rule",
        "nimbus/internal-link",
        "--format",
        "json",
      ],
      { cwd: site.root, encoding: "utf8" },
    );
    const reports = (JSON.parse(lint.stdout) as { diagnostics: Array<{ code: string; file: string; message: string }> }).diagnostics
      .filter((d) => d.code === "nimbus/internal-link")
      .map((d) => `${d.file}: ${d.message}`);
    assert.deepEqual(
      reports,
      [`pkg: pkg/docs/links.mdx: relative link "../README.md" isn't a page of this collection; the build leaves it as written.`],
      lint.stderr,
    );
    assert.ok(!existsSync(path.join(site.root, "dist/guides/readme")));
  } finally {
    await site.remove();
  }
});

test("the page matcher selects the files Astro's glob loader reads", async () => {
  const negated = globPageMatcher(["**/*.md", "!drafts/**"]);
  assert.equal(negated("drafts/a.md"), false);
  assert.equal(negated("guide.md"), true);

  const extglob = globPageMatcher("!(drafts)/**/*.md");
  assert.equal(extglob("guide/a.md"), true);
  assert.equal(extglob("drafts/a.md"), false);

  // The loader reads files with tinyglobby; the matcher agrees with it file for file.
  const { createRequire } = await import("node:module");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { TEST_TMP } = await import("./fixtures/temp-root.ts");
  const astro = createRequire(import.meta.resolve("astro/package.json"));
  const { glob } = (await import(astro.resolve("tinyglobby"))) as {
    glob: (pattern: string | string[], options: { cwd: string; expandDirectories: boolean }) => Promise<string[]>;
  };
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-matcher-"));
  const files = ["README.md", "CHANGELOG.md", "docs/a.md", "docs/b.mdx", "docs/sub/c.md", "drafts/x.md", "docs/drafts/y.md", ".hidden/h.md", "Notes.MD"];
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), "x");
    }
    for (const pattern of [
      "**/*.{md,mdx}",
      "{README.md,docs/**/*.md}",
      ["**/*.md", "!drafts/**"],
      ["**/*.md", "!(drafts)/**"],
      ["**/*.md", "!!drafts/**"],
      "!(drafts)/**/*.md",
      "./docs/**/*.md",
      "docs//**/*.md",
      "docs/sub/../a.md",
      "**/*.mdx/",
      "{README.md,[!C]*.md}",
      "**/*.MD",
    ]) {
      const read = new Set(await glob(pattern, { cwd: dir, expandDirectories: false }));
      const matches = globPageMatcher(pattern);
      assert.deepEqual(files.filter(matches), files.filter((file) => read.has(file)), JSON.stringify(pattern));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a collection removed from the config stops owning its files once the others load again", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const { TEST_TMP } = await import("./fixtures/temp-root.ts");
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-source-owner-"));
  try {
    await writeFile(path.join(dir, "README.md"), "# Widget\n");
    await writeFile(path.join(dir, "CHANGELOG.md"), "# Changes\n");
    const root = pathToFileURL(`${dir}${path.sep}`);
    const readme = path.join(dir, "README.md");
    registerSourceCollectionFolder({ collection: "readme", folder: dir, pattern: "README.md", root });
    registerSourceCollectionFolder({ collection: "guides", folder: dir, pattern: "docs/**/*.md", root });
    assert.equal(rewriteSourceLinks("[changes](./CHANGELOG.md)", readme), "[changes](./CHANGELOG.md)");
    // The config drops `readme` and widens `guides`; only `guides` loads again.
    registerSourceCollectionFolder({ collection: "guides", folder: dir, pattern: "**/*.md", root });
    assert.equal(rewriteSourceLinks("[changes](./CHANGELOG.md)", readme), "[changes](/guides/changelog/)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
