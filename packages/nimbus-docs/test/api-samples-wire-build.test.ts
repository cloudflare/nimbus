import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "astro";
import { JSDOM } from "jsdom";
import nimbus from "../src/index.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { buildApiModel, getApiPageProps, type ApiOperationPage } from "../src/api/index.js";
import { sampleClientUnavailable, startSampleCapture } from "./_api-sample-wire.js";

const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);
const runtime = moduleUrl("../src/runtime.ts");
const api = moduleUrl("../src/api/index.ts");

test("rendered HTML and Markdown samples send null, absence, and schema synthesis correctly", async (t) => {
  const capture = await startSampleCapture();
  t.after(() => capture.close());
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-api-null-wire-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  const spec = {
    openapi: "3.1.0",
    info: { title: "Request bodies", version: "1.0.0" },
    servers: [{ url: capture.origin }],
    paths: Object.fromEntries([
      ["sendNull", { example: null, schema: { type: ["object", "null"] } }],
      ["noBody", undefined],
      ["schemaBody", { schema: { type: "object", properties: { id: { type: "string", example: "synthesized" } } } }],
    ].map(([operationId, media]) => [`/${operationId}`, { post: {
      operationId,
      ...(media ? { requestBody: { content: { "application/json": media } } } : {}),
      responses: { "200": { description: "OK" } },
    } }])),
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await write("nimbus.json", JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }));
  await write("src/api/spec.json", JSON.stringify(spec));
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  await write("src/content.config.ts", `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = { docs: defineCollection(docsCollection()), api: defineCollection(apiCollection()) };`);
  await write("src/pages/api/[...slug].astro", `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page } = result;
---
<html><head><title>Request bodies</title></head><body><main data-coordinate={page.coordinate}>
{page.kind === "operation" && <>
  <section data-example set:html={page.example?.highlightedHtml ?? ""} />
  {page.samples.map((sample) => <section data-lang={sample.lang} set:html={sample.highlightedHtml ?? ""} />)}
</>}
</main></body></html>`);
  await write("src/pages/api/[...slug]/index.md.ts", `import { getApiRoute, getApiStaticPaths } from ${runtime};
import { renderApiPageMarkdown } from ${api};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
export async function GET(context) {
  const result = await getApiRoute(context);
  if (result instanceof Response) return result;
  return new Response(renderApiPageMarkdown(result.page), { headers: { "Content-Type": "text/markdown" } });
}`);
  await write("src/pages/[...slug].astro", `---
import { getDocsStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
---
<p>doc</p>`);
  await build({
    root: pathToFileURL(`${root}${path.sep}`), cacheDir: path.join(root, ".astro"), outDir: "./dist",
    vite: { cacheDir: path.join(root, ".vite") }, logLevel: "silent",
    integrations: [nimbus({ site: "https://example.test", title: "Test", description: "Test", search: false,
      api: [{ collection: "api", spec: path.join(root, "src/api/spec.json") }],
    }, { admonitions: false, sitemap: false, validateMdx: false })],
  });

  const model = await buildApiModel({ collection: "api", spec });
  const dist = path.join(root, "dist");
  let operations = 0;
  for (const entry of await readdir(path.join(dist, "api"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== "index.html") continue;
    const document = new JSDOM(await readFile(path.join(entry.parentPath, entry.name), "utf8")).window.document;
    const coordinate = document.querySelector("main")?.getAttribute("data-coordinate");
    if (!coordinate) continue;
    const page = getApiPageProps(model, coordinate);
    if (page.kind !== "operation") continue;
    operations++;
    const operation = page as ApiOperationPage;
    if (operation.example?.value === null) assert.equal(document.querySelector("[data-example]")?.textContent, "null");
    const markdown = await readFile(path.join(entry.parentPath, "index.md"), "utf8");
    const mdSamples = [...markdown.matchAll(/```(curl|typescript|python)\n([\s\S]*?)\n```/g)].map((match) => ({ lang: match[1]!, source: match[2]! }));
    const htmlSamples = [...document.querySelectorAll("[data-lang]")].map((element) => ({ lang: element.getAttribute("data-lang")!, source: element.textContent! }));
    const expected = operation.samples.map(({ lang, source }) => ({ lang, source }));
    assert.deepEqual(htmlSamples, expected);
    assert.deepEqual(mdSamples, expected);
    for (const [surface, samples] of [["HTML", htmlSamples], ["Markdown", mdSamples]] as const) {
      for (const sample of samples) {
        await t.test(`${coordinate} ${surface} ${sample.lang}`, { skip: sampleClientUnavailable[sample.lang as keyof typeof sampleClientUnavailable] }, async () => {
          const request = await capture.run(sample);
          if (operation.example === undefined) {
            assert.equal(request.body.length, 0);
            assert.equal(request.headers["content-type"], undefined);
          } else {
            assert.equal(request.headers["content-type"], "application/json");
            if (operation.example.value === null) assert.equal(request.body.toString("hex"), "6e756c6c");
            else assert.deepEqual(JSON.parse(request.body.toString()), operation.example.value);
          }
        });
      }
    }
  }
  assert.equal(operations, 3);
});
