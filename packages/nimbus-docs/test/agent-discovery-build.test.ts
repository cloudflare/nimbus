import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";
import { agentSites, siteApp, srcModule } from "./fixtures/agent-site.js";

function contentTypes(headers: string, pathname: string): string[] {
  const values: string[] = [];
  let matches = false;
  for (const line of headers.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      matches = new RegExp(`^${pattern}$`).test(pathname);
    } else if (matches && /^\s+Content-Type:/i.test(line)) {
      values.push(line.replace(/^\s+Content-Type:\s*/i, ""));
    }
  }
  return values;
}

test("prerendered agent text has a single UTF-8 Content-Type at root and under a base", async () => {
  for (const base of ["/", "/docs"]) {
    const site = await fixture();
    try {
      await site.write(
        "src/content/docs/guide.mdx",
        "---\ntitle: 中文測試\n---\n這是一段中文說明, café.",
      );
      await site.write(
        "src/content/docs/setup/start.mdx",
        "---\ntitle: 安裝\n---\n開始設定.",
      );
      await site.write(
        "src/pages/llms-full.txt.ts",
        `import { llmsFullRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsFullRoute();`,
      );
      await site.write(
        "src/pages/[section]/llms.txt.ts",
        `import { llmsSectionRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();`,
      );
      await site.write(
        "src/pages/robots.txt.ts",
        'export const prerender = true;\nexport const GET = () => new Response("User-agent: *\\nAllow: /", { headers: { "Content-Type": "text/plain; charset=utf-8" } });',
      );
      await site.write("public/download.txt", "Owner download.");
      await site.write("public/download.md", "Owner Markdown.");
      await build({ ...site.config, base });
      const headers = await site.read("dist/_headers");
      const prefix = base === "/" ? "" : base;
      for (const [file, type] of [
        ["llms.txt", "text/plain"],
        ["llms-full.txt", "text/plain"],
        ["setup/llms.txt", "text/plain"],
        ["guide/index.md", "text/markdown"],
        ["setup/start/index.md", "text/markdown"],
        ["index.md", "text/markdown"],
        ["robots.txt", "text/plain"],
      ]) {
        assert.ok((await site.read(`dist/${file}`)).length);
        assert.deepEqual(
          contentTypes(headers, `${prefix}/${file}`),
          [`${type}; charset=utf-8`],
          file,
        );
      }
      assert.match(await site.read("dist/llms.txt"), /中文測試/);
      assert.match(await site.read("dist/llms-full.txt"), /這是一段中文說明/);
      assert.match(await site.read("dist/guide/index.md"), /café/);
      for (const file of ["download.txt", "download.md", "index.html"])
        assert.deepEqual(contentTypes(headers, `${prefix}/${file}`), [], file);
      if (base === "/docs") {
        const owner =
          "/*.txt\r\n  Content-Type: text/plain; charset=utf-8\r\n\r\n/*.md\r\n  Content-Type: text/markdown; charset=utf-8\r\n";
        await site.write("public/_headers", owner);
        await build({ ...site.config, base });
        const updated = await site.read("dist/_headers");
        assert.ok(updated.startsWith(owner));
        assert.deepEqual(contentTypes(updated, "/docs/llms.txt"), [
          "text/plain; charset=utf-8",
        ]);
        assert.deepEqual(contentTypes(updated, "/docs/guide/index.md"), [
          "text/markdown; charset=utf-8",
        ]);
        assert.deepEqual(contentTypes(updated, "/docs/index.md"), [
          "text/markdown; charset=utf-8",
        ]);
      }
    } finally {
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

test("real Astro builds reuse llms bytes and preserve owner headers under a base", async () => {
  const site = await fixture();
  try {
    await build(site.config);
    assert.equal(
      await site.read("dist/index.md"),
      await site.read("dist/llms.txt"),
    );
    const ard = await site.read("dist/.well-known/ard.json");
    assert.equal(ard, await site.read("dist/.well-known/ai-catalog.json"));
    const document = JSON.parse(ard);
    assert.deepEqual(
      document.entries.map((entry: { url: string }) => entry.url),
      [
        "https://example.test/docs/llms.txt",
        "https://example.test/docs/index.md",
      ],
    );
    assert.ok(
      (await site.read("dist/_headers")).startsWith(
        await site.read("public/_headers"),
      ),
    );
    assert.match(await site.read("dist/_headers"), /rel="ard"/);
    await site.write(
      "src/content/docs/guide.mdx",
      "---\ntitle: New title\n---\nNew discovery text.",
    );
    await build(site.config);
    assert.match(await site.read("dist/index.md"), /New title/);
    assert.equal(
      (await site.read("dist/_headers")).match(/^\/docs\/$/gm)?.length,
      1,
    );
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a real root entry wins over llms, while noindex excludes only its discovery link", async () => {
  const site = await fixture(
    "---\ntitle: Root entry\nnoindex: true\n---\nUnique homepage body.",
  );
  try {
    await build(site.config);
    assert.match(await site.read("dist/index.md"), /Unique homepage body/);
    assert.doesNotMatch(await site.read("dist/llms.txt"), /Root entry/);
    const document = JSON.parse(await site.read("dist/.well-known/ard.json"));
    assert.deepEqual(
      document.entries.map((entry: { type: string }) => entry.type),
      ["text/plain"],
    );
    assert.doesNotMatch(await site.read("dist/_headers"), /rel="alternate"/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("an existing public discovery document fails visibly instead of being overwritten", async () => {
  const site = await fixture();
  try {
    const owner = '{"entries": [{"url": "https://example.net/custom"}]}';
    await site.write("assets/.well-known/ard.json", owner);
    await assert.rejects(
      build({ ...site.config, publicDir: "./assets" }),
      /Move your existing discovery document at assets[/\\]\.well-known[/\\]ard\.json/,
    );
    assert.equal(await site.read("assets/.well-known/ard.json"), owner);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a noindex entry in another collection does not hide the llms homepage fallback", async () => {
  const site = await fixture(
    "---\ntitle: Handbook\nnoindex: true\n---\nHandbook body.",
    "handbook",
  );
  try {
    await build(site.config);
    assert.equal(
      await site.read("dist/index.md"),
      await site.read("dist/llms.txt"),
    );
    assert.match(await site.read("dist/handbook/index.md"), /Handbook body/);
    assert.match(
      await site.read("dist/.well-known/ard.json"),
      /text\/markdown/,
    );
    assert.match(await site.read("dist/_headers"), /rel="alternate"/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("owner homepage Markdown does not inherit an unused root entry's noindex, and no Markdown route means no homepage Markdown", async () => {
  for (const owner of [false, true]) {
    const site = await fixture(
      "---\ntitle: Unused root\nnoindex: true\n---\nUnused body.",
    );
    try {
      await rm(path.join(site.root, "src/pages/[...slug]/index.md.ts"));
      if (owner)
        await site.write("public/index.md", "Owner homepage Markdown.");
      await build(site.config);
      if (owner) {
        assert.equal(await site.read("dist/index.md"), "Owner homepage Markdown.");
        assert.match(await site.read("dist/.well-known/ard.json"), /text\/markdown/);
        assert.match(await site.read("dist/_headers"), /rel="alternate"/);
      } else {
        // With no route serving /index.md, an llms.txt route alone publishes
        // no homepage Markdown: no file, no catalog entry, no alternate link.
        assert.ok(!existsSync(path.join(site.root, "dist/index.md")));
        assert.doesNotMatch(await site.read("dist/.well-known/ard.json"), /text\/markdown/);
        assert.doesNotMatch(await site.read("dist/_headers"), /rel="alternate"/);
      }
    } finally {
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

test("an on-demand homepage Markdown owner is not shadowed by the static llms fallback", async () => {
  const sites = agentSites();
  try {
    for (const sharedRoute of [false, true]) {
      const site = await sites.buildSite(
        {
          "package.json": '{"type":"module"}',
          "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = { docs: defineCollection(docsCollection({ base: "docs" })) };`,
          "src/content/docs/guide.mdx": "---\ntitle: Guide\n---\nGuide body.",
          "src/content/docs/index.mdx": "---\ntitle: Root\n---\nRoot body.",
          "src/pages/index.astro":
            "---\nexport const prerender = true;\n---\n<html><body>Home</body></html>",
          "src/pages/llms.txt.ts": `import { llmsRoute } from ${srcModule("agent-endpoints.ts")};
export const prerender = true;
export const { GET } = llmsRoute();`,
          "src/pages/index.md.ts": `export const prerender = false;
export function GET() {
  return new Response("Owner request Markdown.", {
    headers: { "Content-Type": "text/markdown" },
  });
}`,
          ...(sharedRoute
            ? {
                "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${srcModule("agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();`,
              }
            : {}),
        },
        { server: true },
      );
      assert.match(
        await readFile(path.join(site.root, "dist/llms.txt"), "utf8"),
        /Guide/,
      );
      await assert.rejects(readFile(path.join(site.root, "dist/index.md")), {
        code: "ENOENT",
      });
      const response = await (
        await siteApp(site)
      ).render(new Request("https://example.test/docs/index.md"));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), "text/markdown");
      assert.equal(await response.text(), "Owner request Markdown.");
    }
  } finally {
    await sites.cleanup();
  }
});

test("API discovery links follow the document trailing-slash policy under a base", async () => {
  const site = await fixture(undefined, "docs", true);
  try {
    const api = pathToFileURL(
      path.resolve(import.meta.dirname, "../src/runtime.ts"),
    ).href;
    await site.write(
      "src/pages/pets/[...slug].astro",
      `---
import { getApiStaticPaths } from ${JSON.stringify(api)};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("pets");
---
<html><body>Pets API</body></html>`,
    );
    for (const [trailingSlash, format, suffix] of [
      ["never", "directory", ""],
      ["always", "directory", "/"],
      ["ignore", "file", ""],
    ] as const) {
      await build({ ...site.config, trailingSlash, build: { format } });
      const headers = await site.read("dist/_headers");
      const links = headers
        .split("\n")
        .filter((line) => line.includes('rel="service-doc"'));
      assert.ok(links.length);
      assert.ok(
        links.every(
          (line) =>
            line ===
            `  Link: <https://example.test/docs/pets${suffix}>; rel="service-doc"; type="text/html"`,
        ),
        headers,
      );
      assert.match(
        await site.read(
          format === "file" ? "dist/pets.html" : "dist/pets/index.html",
        ),
        /Pets API/,
      );
    }
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});
