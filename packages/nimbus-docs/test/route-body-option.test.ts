// A site changes a document's text through the factory's `body`: the ETag
// and the 304 are over the text sent, on request and at build, and nothing
// changes for a route without it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { dev } from "astro";

import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";
import { agentSites, srcModule } from "./fixtures/agent-site.js";

const tagOf = (text: string) => `"sha256:${createHash("sha256").update(text).digest("hex")}"`;
const ENDPOINTS = srcModule("agent-endpoints.ts");

test("on request, every factory's body is tagged over the text it returns; a client revalidates against those bytes", async () => {
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, { rendering: { default: "request" } });
  const stamp = path.join(site.root, "stamp.txt");
  await writeFile(stamp, "one");
  await site.write("src/content/docs/ref/one.mdx", "---\ntitle: One\n---\nRef body.");
  await site.write("src/content/docs/café.mdx", "---\ntitle: Café\n---\nAccents too.");
  await site.write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${srcModule("index.ts")};\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<html><body>Page</body></html>`,
  );
  await site.write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${ENDPOINTS};\nexport const prerender = false;\nexport const { GET, getStaticPaths } = markdownRoute({ body: async (text) => \`\${text}\\nLicensed ✓\\n\` });\n`,
  );
  await site.write(
    "src/pages/[...slug]/index.mdx.ts",
    `import { markdownSourceRoute } from ${ENDPOINTS};\nexport const prerender = false;\nexport const { GET, getStaticPaths } = markdownSourceRoute({ body: (text) => \`\${text}\\n<!-- source -->\\n\` });\n`,
  );
  await site.write(
    "src/pages/llms.txt.ts",
    `import { readFileSync } from "node:fs";\nimport { llmsRoute } from ${ENDPOINTS};\nexport const prerender = false;\nexport const { GET } = llmsRoute({ body: (text, context) => \`\${text}\\n## Stamp \${readFileSync(${JSON.stringify(stamp)}, "utf8")} for \${context.url.pathname}\\n\` });\n`,
  );
  await site.write(
    "src/pages/[...section]/llms.txt.ts",
    `import { llmsSectionRoute } from ${ENDPOINTS};\nexport const prerender = false;\nexport const { GET, getStaticPaths } = llmsSectionRoute({ body: () => "" });\n`,
  );
  await site.write(
    "src/pages/llms-full.txt.ts",
    `import { llmsFullRoute } from ${ENDPOINTS};\nexport const prerender = false;\nexport const { GET } = llmsFullRoute({ body: () => { throw new Error("secret detail"); } });\n`,
  );
  const server = await dev({ ...site.config, output: "server", server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const get = (url: string, headers: Record<string, string> = {}, method = "GET") => fetch(`${origin}${url}`, { method, headers });

    // Page Markdown: the tag is over the returned text, a 304 only for that text.
    const page = await get("/docs/guide/index.md");
    const text = await page.text();
    assert.equal(page.status, 200);
    assert.match(text, /Licensed ✓\n$/);
    assert.equal(page.headers.get("ETag"), tagOf(text), "the tag is the SHA-256 of the UTF-8 bytes sent");
    assert.equal((await get("/docs/guide/index.md", { "If-None-Match": page.headers.get("ETag")! })).status, 304);
    const nimbusOwn = tagOf(text.replace(/\nLicensed ✓\n$/, ""));
    assert.notEqual(nimbusOwn, page.headers.get("ETag"));
    assert.equal((await get("/docs/guide/index.md", { "If-None-Match": nimbusOwn })).status, 200, "Nimbus's own tag no longer matches");
    const head = await get("/docs/guide/index.md", {}, "HEAD");
    assert.equal(head.headers.get("ETag"), page.headers.get("ETag"));
    assert.equal(await head.text(), "");
    assert.equal((await get("/docs/guide/index.md", { "If-None-Match": page.headers.get("ETag")! }, "HEAD")).status, 304);
    const encoded = await get("/docs/caf%C3%A9/index.md");
    assert.equal(encoded.headers.get("ETag"), tagOf(await encoded.text()));

    // Negotiated: same text and tag, HEAD included, Vary on Accept.
    const markdown = { Accept: "text/markdown, text/html;q=0.9" };
    const negotiated = await get("/docs/guide/", markdown);
    assert.equal(negotiated.status, 200);
    assert.equal(await negotiated.text(), text);
    assert.equal(negotiated.headers.get("ETag"), page.headers.get("ETag"));
    assert.equal(negotiated.headers.get("Vary"), "Accept");
    assert.equal((await get("/docs/guide/", { ...markdown, "If-None-Match": page.headers.get("ETag")! })).status, 304);
    const negotiatedHead = await get("/docs/guide/", markdown, "HEAD");
    assert.equal(negotiatedHead.status, 200);
    assert.equal(negotiatedHead.headers.get("ETag"), page.headers.get("ETag"));
    assert.equal(negotiatedHead.headers.get("Vary"), "Accept");
    assert.equal(await negotiatedHead.text(), "");
    const negotiatedUnchanged = await get("/docs/guide/", { ...markdown, "If-None-Match": page.headers.get("ETag")! }, "HEAD");
    assert.equal(negotiatedUnchanged.status, 304);
    assert.equal(negotiatedUnchanged.headers.get("ETag"), page.headers.get("ETag"));
    assert.equal(await negotiatedUnchanged.text(), "");

    // Source.
    const source = await get("/docs/guide/index.mdx");
    const sourceText = await source.text();
    assert.match(sourceText, /<!-- source -->\n$/);
    assert.equal(source.headers.get("ETag"), tagOf(sourceText));
    assert.equal((await get("/docs/guide/index.mdx", { "If-None-Match": source.headers.get("ETag")! })).status, 304);

    // llms.txt: the stale case. Nimbus's text is unchanged; the appended part changes.
    const first = await get("/docs/llms.txt");
    const firstText = await first.text();
    assert.match(firstText, /## Stamp one for \/docs\/llms\.txt\n$/);
    assert.equal(first.headers.get("ETag"), tagOf(firstText));
    assert.equal((await get("/docs/llms.txt", { "If-None-Match": first.headers.get("ETag")! })).status, 304);
    await writeFile(stamp, "two");
    const second = await get("/docs/llms.txt", { "If-None-Match": first.headers.get("ETag")! });
    assert.equal(second.status, 200, "a changed body is sent, not a 304 for the old one");
    const secondText = await second.text();
    assert.match(secondText, /## Stamp two for/);
    assert.equal(second.headers.get("ETag"), tagOf(secondText));

    // Section index: an empty body is a valid text with its own tag.
    const section = await get("/docs/ref/llms.txt");
    assert.equal(section.status, 200);
    assert.equal(await section.text(), "");
    assert.equal(section.headers.get("ETag"), tagOf(""));
    assert.equal((await get("/docs/ref/llms.txt", { "If-None-Match": tagOf("") })).status, 304);

    // Full document: a throwing body is a detail-free 500.
    const full = await get("/docs/llms-full.txt");
    assert.equal(full.status, 500);
    assert.doesNotMatch(await full.text(), /secret detail/);
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true });
  }
});

const sites = agentSites();
after(() => sites.cleanup());

const PAGE = `---
import { getDocsStaticPaths, getDocsPageProps } from ${srcModule("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { Content } = await getDocsPageProps(Astro);
---
<html><body><main><Content /></main></body></html>
`;
const doc = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

function outcome(logs: string, file: string): "rendered" | "skipped" {
  const plain = logs.replace(/\x1b\[[0-9;]*m/g, "");
  const line = plain.split("\n").find((entry) => entry.includes(`├─ /${file} `));
  assert.ok(line, `${file} appears in the build log`);
  return /\((cached|restored)\)/.test(line) ? "skipped" : "rendered";
}

test("at build, body transforms the baked file, a scoped route its own pages, and every transformed document renders again", { timeout: 240_000 }, async () => {
  const files = (stampPath: string) => ({
    "src/content.config.ts": `import { defineCollection } from "astro:content";\nimport { docsCollection } from ${srcModule("content.ts")};\nexport const collections = { docs: defineCollection(docsCollection()) };\n`,
    "src/pages/[...slug].astro": PAGE,
    "src/content/docs/guides/setup.mdx": doc("Setup", "Set up."),
    "src/content/docs/faq.mdx": doc("FAQ", "Questions."),
    "src/pages/[...slug]/index.md.ts": `import { readFileSync } from "node:fs";\nimport { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute({ body: (text) => \`\${text}\\nStamp \${readFileSync(${JSON.stringify(stampPath)}, "utf8")}\\n\` });\n`,
    "src/pages/guides/[...slug]/index.md.ts": `import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute({ body: (text) => \`\${text}\\nGuides only\\n\` });\n`,
    // The control: no body, so its cache key stays and the second build skips it.
    "src/pages/[...slug]/index.mdx.ts": `import { markdownSourceRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownSourceRoute();\n`,
    "src/pages/llms.txt.ts": `import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const prerender = true;\nexport const { GET } = llmsRoute({ body: (text) => \`\${text}\\n## Index note\\n\` });\n`,
  });
  const options = { experimental: { incrementalBuild: true }, logLevel: "info" as const, base: "/", packageImports: true };
  // The stamp file sits outside the module graph, in a sibling of the site root.
  const probe = await sites.buildSite({ "stamp.txt": "first" }, { ...options, logLevel: "silent" }).catch(() => undefined);
  const root = probe?.root;
  assert.ok(root);
  const stampPath = path.join(root, "stamp.txt");
  const first = await sites.buildSite(files(stampPath), { ...options, root });
  const dist = (file: string) => readFile(path.join(root, "dist", file), "utf8");
  assert.match(await dist("faq/index.md"), /\nStamp first\n$/);
  assert.doesNotMatch(await dist("faq/index.md"), /Guides only/);
  assert.match(await dist("guides/setup/index.md"), /\nGuides only\n$/, "the scoped route's body, not the shared one's");
  assert.doesNotMatch(await dist("guides/setup/index.md"), /Stamp/);
  assert.doesNotMatch(await dist("faq/index.mdx"), /Stamp|Guides only/);
  assert.match(await dist("llms.txt"), /\n## Index note\n$/);
  // The homepage stand-in is the llms index, with its route's body and not the Markdown route's.
  assert.equal(await dist("index.md"), await dist("llms.txt"));

  await writeFile(stampPath, "second");
  const again = await sites.buildSite({}, { ...options, root });
  assert.match(await dist("faq/index.md"), /\nStamp second\n$/, "a body that reads outside the module graph runs again");
  assert.equal(outcome(again.logs, "faq/index.md"), "rendered");
  assert.equal(outcome(again.logs, "guides/setup/index.md"), "rendered");
  assert.equal(outcome(again.logs, "faq/index.mdx"), "skipped", "a route without body keeps its cache key");
});

test("a body that throws fails a static build", { timeout: 240_000 }, async () => {
  await assert.rejects(
    sites.buildSite(
      {
        "src/content.config.ts": `import { defineCollection } from "astro:content";\nimport { docsCollection } from ${srcModule("content.ts")};\nexport const collections = { docs: defineCollection(docsCollection()) };\n`,
        "src/pages/[...slug].astro": PAGE,
        "src/content/docs/faq.mdx": doc("FAQ", "Questions."),
        "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute({ body: () => { throw new Error("no"); } });\n`,
      },
      { packageImports: true, base: "/" },
    ),
    /no/,
  );
});
