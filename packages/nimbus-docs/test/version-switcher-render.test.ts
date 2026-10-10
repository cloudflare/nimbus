import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "astro";
import { JSDOM } from "jsdom";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const starter = path.resolve(
  import.meta.dirname,
  "../../nimbus-starter-source",
);
const source = path.resolve(import.meta.dirname, "../src");

test("version navigation exposes links and the current page in both variants", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "nimbus-version-navigation-"),
  );
  const originalCwd = process.cwd();
  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };

  try {
    await symlink(
      path.join(starter, "node_modules"),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await write(
      "nimbus.json",
      JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }),
    );
    await write(
      "package.json",
      JSON.stringify({
        type: "module",
        dependencies: { "@iconify-json/ph": "^1.2.0" },
      }),
    );
    await write(
      "src/content.config.ts",
      `
import { defineCollection } from "astro:content";
import { docsCollection } from ${JSON.stringify(pathToFileURL(path.join(source, "content.ts")).href)};
export const collections = {
  docs: defineCollection(docsCollection()),
  "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })),
};
`,
    );
    await write(
      "src/content/docs/guide.md",
      "---\ntitle: Guide\n---\nCurrent guide.\n",
    );
    await write(
      "src/content/docs-v1/guide.md",
      "---\ntitle: Old guide\n---\nOld guide.\n",
    );
    await write(
      "src/pages/[...slug].astro",
      `---
import VersionSwitcher from ${JSON.stringify(path.join(starter, "src/components/ui/version-switcher/VersionSwitcher.astro").replaceAll("\\", "/"))};
export function getStaticPaths() {
  return [
    { params: { slug: "guide" }, props: { collection: "docs" } },
    { params: { slug: "v1/guide" }, props: { collection: "docs-v1" } },
  ];
}
const { collection } = Astro.props;
---
<html lang="en"><head><title>Version navigation</title></head><body>
<main>
<div data-variant="header"><VersionSwitcher collection={collection} entryId="guide" /></div>
<div data-variant="sidebar"><VersionSwitcher collection={collection} entryId="guide" variant="sidebar" /></div>
</main>
</body></html>
`,
    );
    process.chdir(root);
    await build({
      root: pathToFileURL(`${root}${path.sep}`),
      cacheDir: path.join(root, ".astro"),
      logLevel: "silent",
      vite: {
        resolve: {
          alias: [
            {
              find: /^@cloudflare\/nimbus-docs$/,
              replacement: path.join(source, "index.ts"),
            },
            { find: /^@cloudflare\/nimbus-docs\//, replacement: `${source}/` },
            {
              find: "@/lib/cn",
              replacement: path.join(starter, "src/lib/cn.ts"),
            },
          ],
        },
      },
      integrations: [
        nimbus(
          {
            site: "https://example.test",
            title: "Test",
            search: false,
            versions: { current: "v2", others: ["v1"] },
          },
          { validateMdx: false },
        ),
      ],
    });

    for (const page of ["guide", "v1/guide"]) {
      const html = await readFile(
        path.join(root, `dist/${page}/index.html`),
        "utf8",
      );
      const document = new JSDOM(html).window.document;
      for (const variant of ["header", "sidebar"]) {
        const navigation = document.querySelector(
          `[data-variant="${variant}"]`,
        )!;
        const links = Array.from(navigation.querySelectorAll("a[href]"));
        assert.equal(links.length, 2, `${variant} renders both destinations`);
        assert.deepEqual(
          links.map((link) => link.getAttribute("href")),
          ["/guide/", "/v1/guide/"],
        );
        assert.equal(
          navigation.querySelectorAll("a[aria-current='page']").length,
          1,
        );
        assert.equal(
          navigation
            .querySelector("a[aria-current='page']")
            ?.getAttribute("href"),
          `/${page}/`,
        );
        for (const link of links) {
          assert.equal(
            link.getAttribute("role"),
            null,
            `${variant} keeps native link semantics`,
          );
          assert.equal(
            link.getAttribute("aria-selected"),
            null,
            `${variant} does not claim widget selection`,
          );
        }
        assert.equal(
          navigation.querySelector("[role='listbox']"),
          null,
          `${variant} is navigation, not a selection widget`,
        );
      }
    }
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
