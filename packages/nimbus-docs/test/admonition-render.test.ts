import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import mdx from "@astrojs/mdx";
import { satteri } from "@astrojs/markdown-satteri";
import { unified } from "@astrojs/markdown-remark";
import { build } from "astro";
import { JSDOM } from "jsdom";
import nimbus from "../src/index.js";
import { satteriAdmonitions } from "../src/_internal/admonition-processor.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";

const source = [
  "[Reference target][target-ref]",
  "",
  "[target-ref]: /target#reference",
  "",
  ":::note[`Age` response header]",
  "Body with `code`.",
  ":::",
  "",
  ":::note[Run <code>traceroute</code>]",
  "Body.",
  ":::",
  "",
  ':::tip[Say "hi"]',
  "Body.",
  ":::",
  "",
  ":::warning",
  "Default.",
  ":::",
  "",
  '<Aside title="Custom">Direct.</Aside>',
  "",
  '<Aside type="danger">Default danger.</Aside>',
  "",
  ":::note[When `name` and `class_name` differ]",
  "```json",
  '{"name":"agent","class_name":"Agent"}',
  "```",
  ":::",
  "",
  "````mdx",
  ":::note",
  "Literal example.",
  "```txt",
  ":::",
  "```",
  ":::",
  "````",
  "",
].join("\n");

for (const processor of ["satteri", "nimbus"] as const) {
  test(`Astro ${processor} renders the unchanged Aside with plain titles and protected code`, async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "nimbus-aside-render-")),
    );
    try {
      await symlink(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(root, "node_modules"),
        "dir",
      );
      await mkdir(path.join(root, "src/pages"), { recursive: true });
      await writeFile(
        path.join(root, "src/Aside.astro"),
        await readFile(
          path.resolve(
            import.meta.dirname,
            "../../nimbus-starter-source/src/components/ui/aside/Aside.astro",
          ),
          "utf8",
        ),
      );
      await writeFile(
        path.join(root, "src/cn.ts"),
        'export const cn = (...args: unknown[]) => args.filter(Boolean).join(" ");',
      );
      await writeFile(
        path.join(root, "src/Icon.astro"),
        '<svg aria-hidden="true" />',
      );
      await writeFile(
        path.join(root, "src/pages/index.mdx"),
        `import Aside from "../Aside.astro";\n\n${source}`,
      );
      await writeFile(
        path.join(root, "src/pages/plain.md"),
        ":::note[`Age` response header]\nPlain Markdown.\n:::\n",
      );
      await writeFile(
        path.join(root, "nimbus.json"),
        `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
      );
      await build({
        root: pathToFileURL(`${root}/`),
        outDir: "./dist",
        cacheDir: path.join(root, ".astro"),
        build: { server: path.join(root, ".server") },
        markdown:
          processor === "satteri"
            ? {
                processor: satteri({
                  mdastPlugins: [
                    satteriAdmonitions({
                      contentDirs: [path.join(root, "src")],
                    }),
                  ],
                }),
              }
            : {},
        integrations:
          processor === "nimbus"
            ? [
                nimbus(
                  {
                    site: "https://example.test",
                    title: "Admonitions",
                    description: "Fixture",
                    locale: "en",
                    search: false,
                  },
                  {
                    admonitions: { contentDirs: ["src"] },
                    validateMdx: false,
                    sitemap: false,
                  },
                ),
              ]
            : [mdx()],
        vite: {
          cacheDir: path.join(root, ".vite"),
          resolve: {
            alias: {
              "@/lib/cn": path.join(root, "src/cn.ts"),
              "@cloudflare/nimbus-docs/components/Icon.astro": path.join(
                root,
                "src/Icon.astro",
              ),
            },
          },
        },
        logLevel: "silent",
      });
      const html = await readFile(path.join(root, "dist/index.html"), "utf8");
      const document = new JSDOM(html).window.document;
      assert.equal(
        document.querySelector('a[href="/target#reference"]')?.textContent,
        "Reference target",
      );
      const asides = [...document.querySelectorAll("aside")];
      assert.equal(asides.length, 7);
      const labels = [
        "`Age` response header",
        "Run <code>traceroute</code>",
        'Say "hi"',
        "Caution",
        "Custom",
        "Danger",
        "When `name` and `class_name` differ",
      ];
      assert.deepEqual(
        asides.map((aside) => aside.getAttribute("aria-label")),
        labels,
      );
      assert.deepEqual(
        asides.map((aside) => aside.querySelector("p")!.textContent),
        labels,
      );
      assert.equal(asides[0]!.querySelector("p")!.querySelector("code"), null);
      assert.equal(asides[1]!.querySelector("p")!.querySelector("code"), null);
      assert.equal(asides[6]!.querySelector("p")!.querySelector("code"), null);
      assert.equal(
        asides[6]!.querySelector("pre code")?.textContent?.trim(),
        '{"name":"agent","class_name":"Agent"}',
      );
      assert.equal(
        asides[0]!.querySelector(".aside-card-body code")?.textContent,
        "code",
      );
      assert.ok(
        [...document.querySelectorAll("pre")].some((node) =>
          node.textContent?.includes(":::note"),
        ),
      );
      assert.equal(document.querySelector("fragment"), null);
      const plain = await readFile(
        path.join(root, "dist/plain/index.html"),
        "utf8",
      );
      assert.ok(plain.includes(":::note["));
      assert.doesNotMatch(plain, /<aside|<fragment|titleLabel=/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const optionPath of ["markdown.processor", "mdx.processor"] as const) {
  test(`Nimbus rejects an incompatible ${optionPath}`, async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "nimbus-aside-processor-")),
    );
    try {
      await symlink(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(root, "node_modules"),
        "dir",
      );
      await mkdir(path.join(root, "src/pages"), { recursive: true });
      await writeFile(path.join(root, "src/pages/index.mdx"), "# Page\n");
      const processor = unified();
      await assert.rejects(
        build({
          root: pathToFileURL(`${root}/`),
          outDir: "./dist",
          cacheDir: path.join(root, ".astro"),
          integrations: [
            nimbus(
              {
                site: "https://example.test",
                title: "Admonitions",
                description: "Fixture",
                locale: "en",
                search: false,
              },
              {
                ...(optionPath === "markdown.processor"
                  ? { markdown: { processor } }
                  : { mdx: { processor } }),
                validateMdx: false,
                sitemap: false,
              },
            ),
          ],
          logLevel: "silent",
        }),
        new RegExp(`compatible Sätteri processor for ${optionPath.replace(".", "\\.")}.*admonitions: false`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Nimbus permits custom processors when admonitions are disabled", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nimbus-aside-disabled-")),
  );
  try {
    await symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    await mkdir(path.join(root, "src/pages"), { recursive: true });
    await writeFile(path.join(root, "src/pages/index.mdx"), "# Page\n");
    await writeFile(
      path.join(root, "nimbus.json"),
      `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
    );
    await build({
      root: pathToFileURL(`${root}/`),
      outDir: "./dist",
      cacheDir: path.join(root, ".astro"),
      markdown: { processor: unified() },
      integrations: [
        nimbus(
          {
            site: "https://example.test",
            title: "Admonitions",
            description: "Fixture",
            locale: "en",
            search: false,
          },
          {
            admonitions: false,
            validateMdx: false,
            sitemap: false,
          },
        ),
      ],
      logLevel: "silent",
    });
    assert.match(
      await readFile(path.join(root, "dist/index.html"), "utf8"),
      /<h1[^>]*>Page<\/h1>/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
