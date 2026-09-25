// A zero-argument `apiCollection()` in `astro dev`: editing the `api` entry in
// astro.config re-indexes the API collection without a manual restart, prose
// keeps its prepared data (headings, Markdown routes, llms.txt) across the
// restart, and spec edits still re-index after it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { dev } from "astro";

import { getPreparedMarkdownSnapshot } from "../src/_internal/prepared-markdown-registry.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })),
  );
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);

function spec(summary: string) {
  return `${JSON.stringify(
    {
      openapi: "3.1.0",
      info: { title: "Restart API", version: "1.0.0" },
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            summary,
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function astroConfig(specPath: string): string {
  return `import nimbus from ${moduleUrl("../src/index.ts")};

export default {
  cacheDir: "./.astro",
  vite: { cacheDir: "./.vite", logLevel: "silent" },
  integrations: [
    nimbus(
      {
        site: "https://restart.test",
        title: "Restart",
        description: "Restart",
        search: false,
        api: [
          {
            collection: "api",
            spec: ${JSON.stringify(specPath)},
            label: ${JSON.stringify(`Spec ${path.basename(specPath)}`)},
          },
        ],
      },
      { admonitions: false, sitemap: false, validateMdx: false },
    ),
  ],
};
`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function until<T>(
  describe: string,
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${describe}; last value: ${JSON.stringify(last)}`);
}

test("dev restart after an api entry edit keeps prose prepared and spec watching alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-api-dev-restart-"));
  roots.push(root);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write(
    "nimbus.json",
    `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
  );
  await write("specs/a.json", spec("Ping A"));
  await write("specs/b.json", spec("Ping B"));
  await write("astro.config.mjs", astroConfig("./specs/a.json"));
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection, partialsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  partials: defineCollection(partialsCollection()),
  api: defineCollection(apiCollection()),
};`,
  );
  await write(
    "src/content/docs/guide.mdx",
    '---\ntitle: Guide\n---\n\n## Own heading\n\nText.\n\n<Render file="shared" />\n',
  );
  await write("src/content/partials/shared.mdx", "## Partial heading\n\nFrom a partial.\n");
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { getMarkdownPayload } from ${moduleUrl("../src/agent-endpoints.ts")};
import { getPreparedMarkdownRouteStaticPaths } from ${moduleUrl("../src/publication.ts")};
export const prerender = true;
export const getStaticPaths = () => getPreparedMarkdownRouteStaticPaths({ collection: "docs", surface: "markdown" });
export async function GET({ params, props, request }) {
  const payload = await getMarkdownPayload({ collection: "docs", surface: "markdown", slug: params.slug, reference: props.artifact, context: { request } });
  return new Response(payload.body, { headers: { "content-type": payload.mediaType } });
}`,
  );
  await write(
    "src/pages/llms.txt.ts",
    `import { getLlmsPayload } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export async function GET({ request }) {
  const payload = await getLlmsPayload({ scope: "site", surface: "index" }, { request });
  return new Response(payload.body, { headers: { "content-type": payload.mediaType } });
}`,
  );

  // Reports which `api` entry the serving Vite server was configured with, so
  // the test can tell when the restarted server has taken over.
  await write(
    "src/pages/configured-spec.txt.ts",
    `import { config } from "virtual:nimbus/config";
export const prerender = true;
export function GET() {
  return new Response(String(config.api?.[0]?.label));
}`,
  );

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = await dev({
    root: pathToFileURL(`${root}${path.sep}`),
    logLevel: "silent",
    server: { host: "127.0.0.1", port },
  });

  const apiTitle = () =>
    getPreparedMarkdownSnapshot(root)?.collections.get("api")?.entries.get("ping")?.data
      .title;
  const guideHeadings = () =>
    (getPreparedMarkdownSnapshot(root)?.collections.get("docs")?.entries.get("guide")
      ?.headings ?? []).map((heading) => heading.slug);
  const fetchText = async (route: string) => {
    const response = await fetch(`${origin}${route}`);
    return { status: response.status, body: await response.text() };
  };
  const assertProsePrepared = async (phase: string) => {
    const snapshot = getPreparedMarkdownSnapshot(root);
    for (const collection of ["api", "docs", "partials"]) {
      assert.ok(snapshot?.collections.has(collection), `${phase}: ${collection} is prepared`);
    }
    assert.deepEqual(guideHeadings(), ["own-heading"], `${phase}: prose headings are prepared`);
    const markdown = await fetchText("/guide/index.md");
    assert.equal(markdown.status, 200, `${phase}: Markdown route: ${markdown.body.slice(0, 300)}`);
    assert.match(markdown.body, /Partial heading/, `${phase}: Markdown route renders the partial`);
    const llms = await fetchText("/llms.txt");
    assert.equal(llms.status, 200, `${phase}: llms.txt: ${llms.body.slice(0, 300)}`);
    assert.match(llms.body, /\[Guide\]/, `${phase}: llms.txt lists the guide`);
  };

  try {
    await until(
      "the initial content sync",
      () => ({
        api: apiTitle(),
        collections: [...(getPreparedMarkdownSnapshot(root)?.collections.keys() ?? [])].sort(),
      }),
      ({ api, collections }) =>
        api === "Ping A" && ["api", "docs", "partials"].every((name) => collections.includes(name)),
    );
    await assertProsePrepared("before restart");

    // Edit the `api` entry in the Astro config: Astro restarts the dev server.
    await write("astro.config.mjs", astroConfig("./specs/b.json"));
    // Wait until the restarted server serves requests. The refresh runs
    // before it starts listening, so the API collection must already be
    // re-indexed and every prose collection prepared again by then.
    await until(
      "the restarted dev server",
      async () => (await fetchText("/configured-spec.txt").catch(() => ({ body: "" }))).body,
      (body) => body === "Spec b.json",
    );
    assert.equal(apiTitle(), "Ping B", "the edited api entry re-indexed during the restart");
    await assertProsePrepared("after restart");

    // The loader's own watcher is closed by the restart; spec edits must still
    // re-index.
    await write("specs/b.json", spec("Ping B edited"));
    await until("the spec edit to re-index", apiTitle, (title) => title === "Ping B edited");
    await assertProsePrepared("after spec edit");

    // A second restart: Astro's content layer still holds the first server's
    // (closed) watcher, and re-running loaders against it must not leave the
    // process unable to exit once the server stops.
    await write("astro.config.mjs", astroConfig("./specs/a.json"));
    await until(
      "the second restart",
      async () => (await fetchText("/configured-spec.txt").catch(() => ({ body: "" }))).body,
      (body) => body === "Spec a.json",
    );
    assert.equal(apiTitle(), "Ping A", "the second api entry edit re-indexed");
    await assertProsePrepared("after second restart");

    // Astro debounces data-store writes; let the re-index persist before the
    // server stops and the temp root is removed.
    await until(
      "the re-index to persist",
      () => readFile(path.join(root, ".astro", "data-store.json"), "utf8").catch(() => ""),
      (store) => store.includes("Ping A") && !store.includes("Ping B edited"),
    );
  } finally {
    await server.stop();
  }
});
