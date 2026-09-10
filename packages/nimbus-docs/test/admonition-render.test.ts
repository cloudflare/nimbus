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
import { build } from "astro";
import { JSDOM } from "jsdom";
import nimbus from "../src/index.js";
import { satteriAdmonitions } from "../src/_internal/admonition-processor.js";

const source = [
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
  ":::note[Read *the* [guide][g]]",
  "Reference body.",
  ":::",
  "",
  ':::note[<script>throw new Error("unsafe title")</script><code onclick="throw 1">safe</code> {(() => { throw new Error("executed title") })()}]',
  "Safe body.",
  ":::",
  "",
  "[g]: /guide",
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
  test(`Astro ${processor} renders rich titles with legacy fallback and protected code`, async () => {
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
      const asideSource = await readFile(
        path.resolve(
          import.meta.dirname,
          "../../nimbus-starter-source/src/components/ui/aside/Aside.astro",
        ),
        "utf8",
      );
      const titleSlot = '<slot name="title-content">{displayTitle}</slot>';
      assert.ok(asideSource.includes(titleSlot));
      await writeFile(path.join(root, "src/Aside.astro"), asideSource);
      await writeFile(
        path.join(root, "src/LegacyAside.astro"),
        asideSource.replace(titleSlot, "{displayTitle}"),
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
        path.join(root, "src/pages/legacy.mdx"),
        `import Aside from "../LegacyAside.astro";\n\n${source}`,
      );
      await writeFile(
        path.join(root, "src/pages/plain.md"),
        ":::note[`Age` response header]\nPlain Markdown.\n:::\n",
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
      const asides = [...document.querySelectorAll("aside")];
      assert.equal(asides.length, 9);
      const labels = [
        "Age response header",
        "Run traceroute",
        "Say “hi”",
        "Caution",
        "Custom",
        "Danger",
        "When name and class_name differ",
        "Read the guide",
        'safe {(() => { throw new Error("executed title") })()}',
      ];
      assert.deepEqual(
        asides.map((aside) => aside.getAttribute("aria-label")),
        labels,
      );
      assert.deepEqual(
        asides.map((aside) => aside.querySelector("p")!.textContent?.trim()),
        labels,
      );
      assert.equal(asides[0]!.querySelector("p code")?.textContent, "Age");
      assert.equal(
        asides[1]!.querySelector("p code")?.textContent,
        "traceroute",
      );
      assert.deepEqual(
        [...asides[6]!.querySelectorAll("p code")].map(
          (node) => node.textContent,
        ),
        ["name", "class_name"],
      );
      assert.equal(
        asides[6]!.querySelector("pre code")?.textContent?.trim(),
        '{"name":"agent","class_name":"Agent"}',
      );
      assert.equal(asides[7]!.querySelector("p em")?.textContent, "the");
      assert.equal(
        asides[7]!.querySelector("p a")?.getAttribute("href"),
        "/guide",
      );
      assert.equal(asides[8]!.querySelector("script, [onclick]"), null);
      assert.equal(asides[8]!.querySelector("p code")?.textContent, "safe");
      const legacy = new JSDOM(
        await readFile(path.join(root, "dist/legacy/index.html"), "utf8"),
      ).window.document;
      const legacyAsides = [...legacy.querySelectorAll("aside")];
      assert.deepEqual(
        legacyAsides.map((aside) => aside.getAttribute("aria-label")),
        labels,
      );
      assert.deepEqual(
        legacyAsides.map((aside) =>
          aside.querySelector("p")!.textContent?.trim(),
        ),
        labels,
      );
      assert.equal(legacy.querySelector("[slot]"), null);
      for (const aside of legacyAsides)
        assert.equal(aside.querySelector("p")!.querySelector("code"), null);
      assert.deepEqual(
        legacyAsides.map(
          (aside) => aside.querySelector(".aside-card-body")?.textContent,
        ),
        asides.map(
          (aside) => aside.querySelector(".aside-card-body")?.textContent,
        ),
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
