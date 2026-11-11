import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, dev } from "astro";
import { prefersMarkdown } from "../src/_internal/markdown-negotiation.js";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";
import { siteApp, srcModule, testAdapter } from "./fixtures/agent-site.js";

test("Markdown is chosen only when it outranks every HTML and wildcard range", () => {
  for (const [accept, expected] of [
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html;q=0.5, text/markdown;q=0.8, */*;q=0.1", true],
    ["TEXT/Markdown ; q=1", true],
    ["text/markdown, text/html", false],
    ["text/markdown;q=0.8, */*", false],
    ["text/markdown;q=0.5, text/*;q=0.5", false],
    ["text/markdown;q=0", false],
    ["text/markdown;q=0, text/html;q=0", false],
    ["*/*", false],
    ["text/html", false],
    ["text/plain", false],
    ["text/markdown;q=abc", false],
    ["text/markdown;q=2", false],
    ["text/markdown;q=0x1, text/html;q=0.9", false],
    ["text/markdown;q=.9, text/html;q=0.5", false],
    ["text/markdown;q = 0", false],
    ["text/markdown;q = 0.9, text/html;q=0.5", true],
    ["garbage", false],
    ["", false],
    [null, false],
  ] as const) {
    assert.equal(prefersMarkdown(accept), expected, `Accept: ${String(accept)}`);
  }
});

test("on server output a request-rendered page and the homepage negotiate; everything else passes through", async () => {
  const site = await fixture(
    "---\ntitle: Root entry\n---\nHome body.",
    "docs",
    false,
    undefined,
    { rendering: { default: "request" } },
  );
  const index = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
  await site.write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${JSON.stringify(index)};\nexport const getStaticPaths = getDocsStaticPaths;\nAstro.response.headers.set("Vary", "Cookie");\nAstro.response.headers.set("X-Owner", "page");\n---\n<html><body>Page</body></html>`,
  );
  await site.write("src/content/docs/café.mdx", "---\ntitle: Café\n---\nAccents too.");
  const server = await dev({ ...site.config, output: "server", server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const markdown = { Accept: "text/markdown, text/html;q=0.9" };
    const encoded = await fetch(`${origin}/docs/caf%C3%A9/`, { headers: markdown });
    assert.match(encoded.headers.get("Content-Type") ?? "", /text\/markdown/, "percent-encoded URL");
    const page = await fetch(`${origin}/docs/guide/`, { headers: markdown });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /text\/markdown/);
    // Negotiation answers before the page's HTML renders, so the Markdown
    // route's headers apply, not the page's.
    assert.equal(page.headers.get("Vary"), "Accept");
    assert.match(page.headers.get("ETag") ?? "", /^"sha256:/);
    assert.equal(await page.text(), await (await fetch(`${origin}/docs/guide/index.md`)).text());
    const unchanged = await fetch(`${origin}/docs/guide/`, {
      headers: { ...markdown, "If-None-Match": page.headers.get("ETag")! },
    });
    assert.equal(unchanged.status, 304, "a client holding the Markdown revalidates for free");
    assert.equal(unchanged.headers.get("ETag"), page.headers.get("ETag"));
    assert.equal(unchanged.headers.get("Vary"), "Accept");
    const html = await fetch(`${origin}/docs/guide/`, { headers: { Accept: "*/*" } });
    assert.match(html.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(html.headers.get("Vary") ?? "", /(^|, )Accept$/);
    // A page's own headers belong to its HTML, which a Markdown request never renders.
    const owned = await fetch(`${origin}/docs/guide/`, { headers: markdown });
    assert.equal(owned.headers.get("X-Owner"), null);
    assert.equal(html.headers.get("X-Owner"), "page");
    assert.match(html.headers.get("Vary") ?? "", /^Cookie, Accept$/);
    const head = await fetch(`${origin}/docs/guide/`, { method: "HEAD", headers: markdown });
    assert.match(head.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(await head.text(), "");
    const home = await fetch(`${origin}/docs/`, { headers: markdown });
    assert.match(home.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(home.headers.get("Vary"), "Accept");
    assert.equal(await home.text(), await (await fetch(`${origin}/docs/index.md`)).text());
    const homeHtml = await fetch(`${origin}/docs/`);
    // The HTML form carries the page's own Link and the discovery links; the
    // Markdown form, answered without rendering the page, the discovery links.
    assert.match(homeHtml.headers.get("Link") ?? "", /rel="help".*rel="ard"/);
    assert.equal(home.headers.get("Link"), homeHtml.headers.get("Link")!.replace(/^<[^>]*>; rel="help", /, ""));
    assert.match(home.headers.get("Link") ?? "", /^<[^>]*>; rel="ard"/);
    // Endpoints, assets, and a URL no entry owns pass through untouched.
    for (const route of ["/docs/llms.txt", "/docs/guide/index.md", "/docs/.well-known/ard.json", "/docs/nowhere/"]) {
      const response = await fetch(origin + route, { headers: markdown });
      assert.equal(response.status, 200, route);
      assert.doesNotMatch(response.headers.get("Vary") ?? "", /Accept/, route);
      assert.doesNotMatch(response.headers.get("Content-Type") ?? "", route.endsWith("/") ? /markdown/ : /html/, route);
    }
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("on server output a missing page answers Markdown with its 404 when Markdown is preferred", async () => {
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
    rendering: { default: "request" },
  });
  await site.write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsPage, getDocsStaticPaths } from ${srcModule("runtime.ts")};\nexport const getStaticPaths = getDocsStaticPaths;\nconst page = await getDocsPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Page</body></html>`,
  );
  await site.write("src/pages/404.astro", "<html><body>Not here</body></html>");
  await site.write(
    "src/pages/gone.json.ts",
    'export const GET = () => new Response(null, { status: 404, headers: { "Content-Type": "application/json" } });',
  );
  const server = await dev({ ...site.config, output: "server", server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const missing = await fetch(`${origin}/docs/nowhere/`, { headers: { Accept: "text/markdown" } });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.match(missing.headers.get("Vary") ?? "", /Accept/);
    const body = await missing.text();
    assert.match(body, /^# Not found\n\nThere is no page at `\/docs\/nowhere\/`\./);
    assert.match(body, /https:\/\/example\.test\/docs\/llms\.txt/);
    assert.match(body, /https:\/\/example\.test\/docs\/sitemap-index\.xml/);
    const head = await fetch(`${origin}/docs/nowhere/`, { method: "HEAD", headers: { Accept: "text/markdown" } });
    assert.equal(head.status, 404);
    assert.match(head.headers.get("Content-Type") ?? "", /text\/markdown/);
    const html = await fetch(`${origin}/docs/nowhere/`);
    assert.equal(html.status, 404);
    assert.match(await html.text(), /Not here/);
    assert.match(html.headers.get("Vary") ?? "", /Accept/);
    // An endpoint's own 404 keeps its type.
    const endpoint = await fetch(`${origin}/docs/gone.json`, { headers: { Accept: "text/markdown" } });
    assert.equal(endpoint.status, 404);
    assert.match(endpoint.headers.get("Content-Type") ?? "", /application\/json/);
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("under server output, build-rendered pages and the homepage of an all-build site stay HTML", async () => {
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
    rendering: { collections: { docs: "build" } },
  });
  const index = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
  await site.write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${JSON.stringify(index)};\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<html><body>Page</body></html>`,
  );
  const server = await dev({ ...site.config, output: "server", server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    for (const route of ["/docs/guide/", "/docs/"]) {
      const response = await fetch(origin + route, { headers: { Accept: "text/markdown" } });
      assert.match(response.headers.get("Content-Type") ?? "", /text\/html/, route);
      assert.doesNotMatch(response.headers.get("Vary") ?? "", /Accept/, route);
    }
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("production all-build homepages are prerendered without a source export", async () => {
  for (const rendering of [undefined, { collections: { docs: "build" } }]) {
    const site = await fixture(undefined, "docs", false, undefined, { rendering });
    try {
      await site.write("src/pages/[...slug].astro", `---\nimport { getDocsStaticPaths } from ${srcModule("index.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<html><body>Page</body></html>`);
      await site.write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
      await build({
        ...site.config,
        output: "server",
        adapter: testAdapter(path.join(site.root, "server-entry.mjs")),
        build: { client: path.join(site.root, "dist"), server: path.join(site.root, ".server") },
      });
      assert.match(await site.read("dist/index.html"), /Owner homepage/);
      assert.equal((await site.read("dist/_headers")).match(/^\/docs\/$/gm)?.length, 1);
    } finally {
      await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

test("a static site never negotiates", async () => {
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.");
  const server = await dev({ ...site.config, server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const home = await fetch(`${origin}/docs/`, { headers: { Accept: "text/markdown" } });
    assert.match(home.headers.get("Content-Type") ?? "", /text\/html/);
    assert.doesNotMatch(home.headers.get("Vary") ?? "", /Accept/);
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("production homepage Markdown reuses on-demand llms without shadowing an owner", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const site = await fixture(undefined, "docs", false, undefined, { rendering: { default: "request" } });
  try {
    process.env.NODE_ENV = "production";
    await site.write("src/pages/[...slug].astro", `---\nimport { getDocsStaticPaths } from ${srcModule("index.ts")};\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<html><body>Page</body></html>`);
    await site.write(
      "src/pages/llms.txt.ts",
      [
        "export const prerender = false;",
        "export function GET({ request }) {",
        '  const headers = { "Content-Type": "text/plain", "X-Owner": "index", ETag: \'"owner-index"\' };',
        '  if (request.headers.get("If-None-Match") === \'"owner-index"\') return new Response(null, { status: 304, headers });',
        '  return new Response("Owner documentation index.", { headers });',
        "}",
        "",
      ].join("\n"),
    );
    await site.write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
    for (const owner of [false, true]) {
      if (owner) await site.write("src/pages/index.md.ts", 'export const prerender = false;\nexport function GET() { return new Response("Owner homepage Markdown.", { headers: { "Content-Type": "text/markdown", "X-Owner": "home" } }); }\n');
      const server = path.join(site.root, owner ? ".server-owner" : ".server");
      await build({ ...site.config, output: "server", adapter: testAdapter(path.join(site.root, "server-entry.mjs")), build: { client: path.join(site.root, "dist"), server } });
      await assert.rejects(site.read("dist/index.md"), { code: "ENOENT" });
      const { app } = await import(pathToFileURL(path.join(server, "entry.mjs")).href);
      for (const method of ["GET", "HEAD"]) {
        const response = await app.render(new Request("https://example.test/docs/index.md", { method }));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("Content-Type") ?? "", /text\/markdown/);
        assert.equal(response.headers.get("X-Owner"), owner ? "home" : "index", `${method}: ${await response.clone().text()}`);
        assert.equal(await response.text(), method === "HEAD" ? "" : owner ? "Owner homepage Markdown." : "Owner documentation index.");
      }
      if (!owner) {
        // The owner's index revalidates; its 304 is the homepage's answer, not a reason to render something else.
        const unchanged = await app.render(new Request("https://example.test/docs/index.md", { headers: { "If-None-Match": '"owner-index"' } }));
        assert.equal(unchanged.status, 304);
        assert.equal(unchanged.headers.get("X-Owner"), "index");
        assert.equal(unchanged.body, null);
      }
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("production HTTP negotiation trusts the configured origin, not the request Host or asset redirects", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  let app: Awaited<ReturnType<typeof siteApp>>;
  let root = "";
  let base = "";
  let redirectMarkdownTo: string | undefined;
  let untrustedRequests = 0;
  const untrusted = createServer((_request, response) => {
    untrustedRequests++;
    response.writeHead(200, { "Content-Type": "text/markdown" });
    response.end("Untrusted origin body");
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    if (url.pathname.endsWith(".md")) {
      if (redirectMarkdownTo) {
        response.writeHead(302, { Location: redirectMarkdownTo });
        response.end();
        return;
      }
      try {
        const bytes = await readFile(path.join(root, "dist", url.pathname.slice(base.length)));
        response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    const rendered = await app.render(new Request(url, { method: request.method, headers: { Accept: request.headers.accept ?? "*/*" } }));
    response.writeHead(rendered.status, Object.fromEntries(rendered.headers));
    response.end(Buffer.from(await rendered.arrayBuffer()));
  });
  try {
    process.env.NODE_ENV = "production";
    await Promise.all([server, untrusted].map((host) =>
      new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve)),
    ));
    const address = server.address();
    const untrustedAddress = untrusted.address();
    assert.ok(address && typeof address !== "string");
    assert.ok(untrustedAddress && typeof untrustedAddress !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const untrustedOrigin = `http://127.0.0.1:${untrustedAddress.port}`;
    const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, undefined, {
      site: origin,
      rendering: { default: "request" },
    });
    root = site.root;
    await site.write("src/pages/[...slug].astro", `---\nimport { getDocsStaticPaths } from ${srcModule("index.ts")};\nexport const getStaticPaths = getDocsStaticPaths;\nAstro.response.headers.set("X-Owner", "page");\n---\n<html><body>Page</body></html>`);
    // A fully custom, prebuilt Markdown route (no factory, so the policy
    // never manages it): the request-rendered page negotiates by reading the
    // deployed public file from the configured origin, which is the path
    // whose trust properties this test verifies.
    await site.write(
      "src/pages/[...slug]/index.md.ts",
      `import { getMarkdownStaticPaths, getMarkdownPayload } from ${srcModule("agent-endpoints.ts")};
export const prerender = true;
export async function getStaticPaths() {
  return getMarkdownStaticPaths({ collection: "docs", surface: "markdown" });
}
export async function GET(context) {
  const payload = await getMarkdownPayload({
    collection: "docs",
    surface: "markdown",
    reference: context.props.reference,
    context: { request: context.request },
  });
  if (!payload) return new Response("Not found", { status: 404 });
  return new Response(payload.body, { headers: { "Content-Type": payload.mediaType } });
}
`,
    );
    await site.write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
    for (base of ["", "/docs"]) {
      await build({ ...site.config, base: base || "/", output: "server", adapter: testAdapter(path.join(site.root, "server-entry.mjs")), build: { client: path.join(site.root, "dist"), server: path.join(site.root, `.server${base ? "-base" : ""}`) } });
      const { app: built } = await import(pathToFileURL(path.join(site.root, `.server${base ? "-base" : ""}`, "entry.mjs")).href);
      app = built;
      for (const route of ["/", "/guide/"]) {
        const response = await fetch(`${origin}${base}${route}`, { headers: { Accept: "text/markdown" } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("Content-Type") ?? "", /text\/markdown/);
        assert.match(response.headers.get("Vary") ?? "", /Accept/);
        // The Markdown form is the deployed file's; the page's headers are its HTML's.
        assert.equal(response.headers.get("X-Owner"), null);
        const alternate = `${origin}${base}${route === "/" ? "/index.md" : `${route}index.md`}`;
        const expected = await (await fetch(alternate)).text();
        assert.equal(await response.text(), expected);
        for (const method of ["GET", "HEAD"]) {
          const spoofed = await app.render(new Request(`${untrustedOrigin}${base}${route}`, {
            method,
            headers: { Accept: "text/markdown" },
          }));
          assert.match(spoofed.headers.get("Content-Type") ?? "", /text\/markdown/);
          assert.equal(await spoofed.text(), method === "HEAD" ? "" : expected);
          assert.equal(untrustedRequests, 0, "incoming Host selected the asset origin");
        }
        const head = await fetch(`${origin}${base}${route}`, { method: "HEAD", headers: { Accept: "text/markdown" } });
        assert.match(head.headers.get("Content-Type") ?? "", /text\/markdown/);
        assert.equal(await head.text(), "");
        assert.match((await fetch(`${origin}${base}${route}`)).headers.get("Content-Type") ?? "", /text\/html/);
      }
      for (const location of [`${untrustedOrigin}/redirected.md`, `${origin}${base}/guide/index.md`]) {
        redirectMarkdownTo = location;
        for (const method of ["GET", "HEAD"]) {
          const redirected = await fetch(`${origin}${base}/guide/`, {
            method,
            headers: { Accept: "text/markdown" },
          });
          assert.equal(redirected.status, 200);
          assert.match(redirected.headers.get("Content-Type") ?? "", /text\/html/);
          assert.equal(redirected.headers.get("X-Owner"), "page");
          assert.match(redirected.headers.get("Vary") ?? "", /Accept/);
          assert.equal(untrustedRequests, 0, "asset redirect reached an untrusted origin");
        }
      }
      redirectMarkdownTo = undefined;
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await Promise.all([server, untrusted].map((host) =>
      new Promise<void>((resolve, reject) => host.close((error) => error ? reject(error) : resolve())),
    ));
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
