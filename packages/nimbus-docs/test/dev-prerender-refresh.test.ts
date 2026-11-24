/** Real-adapter dev refresh: `nimbus-docs add adapter-cloudflare` writes
 * `prerenderEnvironment: "node"`, and in dev the adapter then runs prerendered
 * routes in its own `prerender` Vite environment. Edits must reach it.
 * Install adapters outside the repository and set NIMBUS_TEST_ADAPTER_ROOT
 * (as for api-page-assets-build.test.ts) and NIMBUS_TEST_WORKER_ASSETS=1.
 * Its own file: a content.config.ts edit leaves Astro's content layer state
 * in the process, which later builds in the same process would read. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { dev } from "astro";
import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const adapterRoot = process.env.NIMBUS_TEST_ADAPTER_ROOT;
const SRC = path.resolve(import.meta.dirname, "../src");
const packageModules = path.resolve(import.meta.dirname, "../node_modules");

/** The package's dependencies, with the real Cloudflare adapter in place. */
async function dependencies(root: string) {
  const destination = path.join(root, "node_modules");
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(packageModules)) {
    if (name.startsWith(".")) continue;
    if (!name.startsWith("@")) {
      await symlink(path.join(packageModules, name), path.join(destination, name), "dir");
      continue;
    }
    await mkdir(path.join(destination, name), { recursive: true });
    for (const child of await readdir(path.join(packageModules, name))) {
      if (name === "@astrojs" && child === "cloudflare") continue;
      await symlink(path.join(packageModules, name, child), path.join(destination, name, child), "dir");
    }
  }
  await mkdir(path.join(destination, "@astrojs"), { recursive: true });
  await symlink(path.join(adapterRoot!, "node_modules/@astrojs/cloudflare"), path.join(destination, "@astrojs/cloudflare"), "dir");
}

test(
  "dev with Node prerendering serves edited Markdown without a restart",
  { skip: !adapterRoot || process.env.NIMBUS_TEST_WORKER_ASSETS !== "1", timeout: 180_000 },
  async (t) => {
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    // Astro recognises content files by path; use the real one behind macOS's /var symlink.
    const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-dev-prerender-")));
    // A dev server's content sync can outlive server.stop(); remove the folder at exit.
    if (!process.env.NIMBUS_TEST_KEEP) process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    await dependencies(root);
    const write = async (name: string, contents: string) => {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), contents);
    };
    const config = (owner: string, fields: string) =>
      `import {defineCollection} from "astro:content";
import {z} from "astro/zod";
import {docsCollection} from ${JSON.stringify(pathToFileURL(path.join(SRC, "content.ts")).href)};
export const collections={docs:defineCollection(docsCollection({schemaFields:{owner:${owner}}${fields}}))};`;
    const guide = (title: string, section: string) =>
      `---\ntitle: ${title}\nowner: Ada\n---\n\n## ${section}\n\nCurrent prose.\n`;
    const route = (factory: string) =>
      `import {${factory}} from "@cloudflare/nimbus-docs/agent-endpoints";export const prerender=true;export const {GET,getStaticPaths}=${factory}();`;
    await write("package.json", JSON.stringify({ type: "module" }));
    await write("nimbus.json", JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }));
    await write("src/content.config.ts", config("z.string().optional()", ""));
    await write("src/content/docs/guide.md", guide("Current Guide", "First section"));
    // The page shows its prepared headings, so their refresh is visible.
    await write(
      "src/pages/[...slug].astro",
      `---
import {getCollectionStaticPaths,getCollectionPage} from "@cloudflare/nimbus-docs/runtime";
export const prerender=true;
export const getStaticPaths=getCollectionStaticPaths("docs");
const page=await getCollectionPage(Astro);
if(page instanceof Response)return page;
---
<html><body><h1>{page.entry.data.title}</h1>{page.headings.map((h)=><p data-heading={h.slug}>{h.text}</p>)}</body></html>`,
    );
    await write("src/pages/index.astro", "<html><body>Home</body></html>");
    await write("src/pages/[...slug]/index.md.ts", route("markdownRoute"));
    await write("src/pages/[...slug]/index.mdx.ts", route("markdownSourceRoute"));
    await write("src/pages/llms.txt.ts", route("llmsRoute"));
    await write(
      "wrangler.jsonc",
      JSON.stringify({
        name: "nimbus-dev-prerender-test",
        main: "@astrojs/cloudflare/entrypoints/server",
        compatibility_date: "2026-06-01",
        compatibility_flags: ["nodejs_compat"],
        assets: { binding: "ASSETS", directory: "./dist/client" },
      }),
    );
    const cloudflare = (
      await import(pathToFileURL(path.join(adapterRoot!, "node_modules/@astrojs/cloudflare/dist/index.js")).href)
    ).default;

    // A content.config.ts edit re-syncs content, sometimes more than once;
    // stopping the server while a sync runs leaves the process unable to
    // exit. Astro logs "Syncing content" and "Synced content" around each
    // sync, so stop only once every sync has finished and none has started
    // for a second.
    const logs: string[] = [];
    const streams = [process.stdout, process.stderr] as const;
    const writes = streams.map((stream) => stream.write);
    for (const [index, stream] of streams.entries()) {
      const original = writes[index]!.bind(stream) as (...args: unknown[]) => boolean;
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        logs.push(String(chunk));
        return original(chunk, ...rest);
      }) as typeof stream.write;
    }
    const count = (text: string) => logs.join("").split(text).length - 1;
    let syncsBeforeEdit: number | undefined;
    const settled = async () => {
      if (syncsBeforeEdit === undefined) return;
      const deadline = Date.now() + 30_000;
      let quietSince = 0;
      let seen = -1;
      while (true) {
        const started = count("Syncing content");
        const idle = count("Synced content") > syncsBeforeEdit && started === count("Synced content");
        if (!idle || started !== seen) quietSince = Date.now();
        seen = started;
        if (idle && Date.now() - quietSince >= 1_000) return;
        if (Date.now() > deadline) throw new Error("content sync after the config edit never finished");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    let server: Awaited<ReturnType<typeof dev>> | undefined;
    t.after(async () => {
      try {
        await settled();
      } finally {
        await server?.stop();
        for (const [index, stream] of streams.entries()) stream.write = writes[index]!;
        if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = oldNodeEnv;
      }
    });

    server = await dev({
      root: pathToFileURL(`${root}/`),
      cacheDir: path.join(root, ".astro"),
      output: "server",
      logLevel: "info",
      session: false,
      server: { host: "127.0.0.1", port: 0 },
      adapter: cloudflare({
        configPath: path.join(root, "wrangler.jsonc"),
        persistState: false,
        remoteBindings: false,
        inspectorPort: false,
        prerenderEnvironment: "node",
      }),
      vite: {
        cacheDir: path.join(root, ".vite"),
        resolve: {
          alias: [
            { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(SRC, "index.ts") },
            { find: /^@cloudflare\/nimbus-docs\//, replacement: `${SRC}/` },
          ],
        },
      },
      integrations: [
        nimbus(
          { site: "https://example.test", title: "Dev refresh", search: false, rendering: { default: "build" } },
          { admonitions: false, sitemap: false, validateMdx: false },
        ),
      ],
    } as never);
    const read = async (pathname: string) => {
      const response = await fetch(`http://127.0.0.1:${server!.address.port}${pathname}`);
      return { status: response.status, body: await response.text() };
    };
    const serves = async (pathname: string, text: string) => {
      let last = { status: 0, body: "" };
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        last = await read(pathname);
        if (last.status === 200 && last.body.includes(text)) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.fail(`${pathname} never served ${JSON.stringify(text)}; last: ${last.status} ${last.body.slice(0, 200)}`);
    };

    // Warm every route, so each environment holds the first snapshot.
    await serves("/guide/index.md", "## First section");
    await serves("/guide/index.mdx", "## First section");
    await serves("/llms.txt", "Current Guide");
    await serves("/guide/", 'data-heading="first-section"');

    for (const [title, section, slug] of [
      ["Renamed Guide", "Second section", "second-section"],
      ["Final Guide", "Third section", "third-section"],
    ] as const) {
      await write("src/content/docs/guide.md", guide(title, section));
      await serves("/guide/index.md", `## ${section}`);
      await serves("/guide/index.mdx", `## ${section}`);
      await serves("/llms.txt", title);
      await serves("/guide/", `data-heading="${slug}"`);
    }

    // content.config.ts edits that change the Markdown, with no content edit:
    // a new markdownFields list, then a schema transform of the same field.
    assert.doesNotMatch((await read("/guide/index.md")).body, /^owner:/m);
    syncsBeforeEdit = count("Synced content");
    await write("src/content.config.ts", config("z.string().optional()", ',markdownFields:["owner"]'));
    await serves("/guide/index.md", 'owner: "Ada"');
    await serves("/guide/index.mdx", 'owner: "Ada"');
    syncsBeforeEdit = count("Synced content");
    await write(
      "src/content.config.ts",
      config("z.string().optional().transform((v)=>v?.toUpperCase())", ',markdownFields:["owner"]'),
    );
    await serves("/guide/index.md", 'owner: "ADA"');
    await serves("/guide/index.mdx", 'owner: "ADA"');
  },
);
