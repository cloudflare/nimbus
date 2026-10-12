// A real build over a content source: a bare git repository on disk holding
// `docs/` and `docs/openapi.json`, mounted as the `sdk` collection and read by
// the `api` entry's spec through the checkout the integration makes at
// `astro:config:setup`. Then the cache (a second build with the remote gone
// makes no fetch), a branch ref picking up a new commit, an annotated tag, the
// credential in the repository URL reaching no log line and no file, and
// `check --structure` on the same site with a templated ref.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "astro";

import nimbus from "../src/index.ts";
import { listContentSourceContentDirs } from "../src/_internal/content-sources.ts";
import { lintPaths } from "../src/lint/engine.ts";
import type { NimbusConfig } from "../src/types.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { formatCheckJson } from "../src/check/format.ts";
import { runChecks } from "../src/check/run.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const TOKEN = "secret-token-7f3a9c";
const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Widgets API", version: "1.0.0" },
  servers: [{ url: "https://api.example.test" }],
  tags: [{ name: "widgets" }],
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        tags: ["widgets"],
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).trim();

/** A work tree and the bare repository it pushes to, with the SDK's docs and spec. */
async function makeRemote(root: string) {
  const work = path.join(root, "sdk-work");
  const bare = path.join(root, "sdk.git");
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(work, relative)), { recursive: true });
    await writeFile(path.join(work, relative), contents, "utf8");
  };
  await write("README.md", "# SDK\n");
  await write("src/lib.ts", "export const lib = 1;\n");
  await write("docs/index.md", "---\ntitle: SDK overview\n---\n\nStart with [install](/sdk/guides/install).\n");
  await write("docs/guides/install.md", "---\ntitle: Install\n---\n\nInstall the SDK.\n");
  await write("docs/guides/cite.md", "---\ntitle: Cite\n---\n\nCall [list widgets](api.ref:api:listWidgets).\n");
  await write("docs/guides/links.mdx", "---\ntitle: Links\n---\n\nSee [install](/sdk/guides/install) and [nowhere](/sdk/nowhere).\n");
  await write("docs/openapi.json", `${JSON.stringify(SPEC, null, 2)}\n`);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "docs");
  git(root, "clone", "-q", "--bare", work, bare);
  git(bare, "config", "uploadpack.allowFilter", "true");
  return { work, bare, commit: git(work, "rev-parse", "HEAD") };
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(file)));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await walk(dir)) {
    if ((await readFile(file, "utf8").catch(() => "")).includes(needle)) hits.push(path.relative(dir, file));
  }
  return hits;
}

test("a site builds its sdk collection and api spec from a git source, caches the commit, follows a branch, and keeps the token out of every output", async () => {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-sources-build-"));
  const site = path.join(root, "site");
  const remote = await makeRemote(root);
  const repo = `file://x-access-token:${TOKEN}@${remote.bare}`;
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(site, relative)), { recursive: true });
    await writeFile(path.join(site, relative), contents, "utf8");
  };
  await mkdir(site, { recursive: true });
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(site, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write("package.json", `{ "name": "fixture", "type": "module" }\n`);
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ source: "sdk" })),
  api: defineCollection(apiCollection()),
};
`,
  );
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nSee the [SDK](/sdk).\n");
  await write(
    "src/pages/[...slug].astro",
    `---
import { getDocsStaticPaths, getDocsPageProps } from ${moduleUrl("../src/runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { entry } = await getDocsPageProps(Astro);
---
<html><body><h1>{entry.data.title}</h1></body></html>
`,
  );
  await write(
    "src/pages/sdk/[...slug].astro",
    `---
import { getCollectionStaticPaths, getCollectionPageProps, getEditUrl, getLastUpdated } from ${moduleUrl("../src/runtime.ts")};
export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("sdk");
const { entry, Content } = await getCollectionPageProps(Astro);
const editUrl = (await getEditUrl(entry)) ?? "no-edit-url";
const lastUpdated = (await getLastUpdated(entry))?.toISOString() ?? "no-date";
---
<html><body><h1>{entry.data.title}</h1><p>{entry.filePath}</p><a id="edit" href={editUrl}>{editUrl}</a><time>{lastUpdated}</time><main><Content /></main></body></html>
`,
  );
  await write(
    "src/pages/api/[...slug].astro",
    `---
import { getApiStaticPaths } from ${moduleUrl("../src/runtime.ts")};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
---
<html><body>api</body></html>
`,
  );
  await write(
    "src/pages/[section]/llms.txt.ts",
    `import { llmsSectionRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = llmsSectionRoute();
`,
  );
  // The Nimbus config as text, for \`check\`; the build gets the same config inline.
  const astroConfig = (ref: string) => `import { defineConfig } from "astro/config";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";

const nimbusConfig = defineNimbusConfig({
  site: "https://example.test",
  title: "Test",
  search: false,
  sources: {
    sdk: {
      repo: ${JSON.stringify(repo)},
      ref: ${ref},
      path: "docs",
    },
  },
  api: [{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }],
});

export default defineConfig({
  output: "static",
  integrations: [nimbus(nimbusConfig)],
});
`;

  const traceFile = path.join(root, "git-trace.log");
  /** The site config for `ref`; `override` replaces whole top-level keys. */
  const siteConfig = (ref: string, override: Partial<NimbusConfig> = {}): NimbusConfig => ({
    site: "https://example.test",
    title: "Test",
    search: false,
    sources: { sdk: { repo, ref, path: "docs" } },
    api: [{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }],
    ...override,
  });
  async function buildSite(
    ref: string,
    options: { config?: Partial<NimbusConfig>; logLevel?: "info" | "silent" } = {},
  ): Promise<string> {
    const output: string[] = [];
    const restore = [process.stdout, process.stderr].map((stream) => {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array) => (output.push(String(chunk)), true)) as typeof stream.write;
      return () => (stream.write = original);
    });
    await rm(traceFile, { force: true });
    process.env.GIT_TRACE = traceFile;
    try {
      await build({
        root: pathToFileURL(`${site}${path.sep}`),
        configFile: false,
        cacheDir: path.join(site, ".astro"),
        outDir: "./dist",
        vite: { cacheDir: path.join(site, ".vite") },
        logLevel: options.logLevel ?? "info",
        integrations: [
          nimbus(siteConfig(ref, options.config), { admonitions: false, sitemap: false, validateMdx: false }),
        ],
      });
    } finally {
      delete process.env.GIT_TRACE;
      for (const reset of restore) reset();
    }
    return output.join("");
  }
  const gitCalls = async () =>
    (await readFile(traceFile, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => /built-in: git (ls-remote|fetch|clone)|run_command: .*upload-pack/.test(line));
  const read = (relative: string) => readFile(path.join(site, relative), "utf8");
  const sourceDir = path.join(site, ".nimbus/sources/sdk");

  try {
    // 1. A pinned ref: pages, the section llms.txt, the API pages and the published spec.
    const logs = await buildSite(remote.commit);
    const checkout = path.join(sourceDir, remote.commit);
    assert.match(logs, new RegExp(`nimbus: source "sdk" \\(file://${remote.bare} @ ${remote.commit}\\): fetched commit ${remote.commit.slice(0, 12)}\\.`));
    assert.ok(existsSync(path.join(checkout, "docs/guides/install.md")), "the docs folder is checked out");
    assert.ok(!existsSync(path.join(checkout, "src")), "the sparse checkout leaves src/ out");
    assert.ok(!existsSync(path.join(checkout, ".git")), ".git is deleted after the checkout");
    const marker = JSON.parse(await readFile(path.join(checkout, ".nimbus-source.json"), "utf8"));
    assert.deepEqual(
      { version: marker.version, repo: marker.repo, ref: marker.ref, commit: marker.commit, path: marker.path },
      { version: 1, repo: `file://${remote.bare}`, ref: remote.commit, commit: remote.commit, path: "docs" },
    );
    assert.match(await read("dist/sdk/index.html"), /SDK overview/);
    assert.match(await read("dist/sdk/guides/install/index.html"), /Install/);
    assert.match(await read("dist/sdk/guides/install/index.html"), new RegExp(`\\.nimbus/sources/sdk/${remote.commit}/docs/guides/install\\.md`));
    // Without `sources.sdk.editPattern` a remote page gets no edit link; the
    // site's `editPattern` never receives a checkout path. No git date either.
    assert.match(await read("dist/sdk/guides/install/index.html"), /<a id="edit" href="no-edit-url">no-edit-url<\/a><time>no-date<\/time>/);
    assert.match(await read("dist/guide/index.html"), /Guide/);
    assert.match(await read("dist/sdk/llms.txt"), /\/sdk\/guides\/install/);
    // The checkout is in citation scope: an `api.ref:` in a remote page resolves.
    assert.match(await read("dist/sdk/guides/cite/index.html"), /href="\/api\/widgets\/listWidgets\/?"/);
    // And in lint scope: the link checker reads the checkout like src/content.
    assert.deepEqual(listContentSourceContentDirs(site), [path.join(checkout, "docs")]);
    const linkFindings = lintPaths([path.join(checkout, "docs/guides/links.mdx")], site, {
      rules: { "nimbus/internal-link": "error" },
    }).filter((finding) => finding.code === "nimbus/internal-link");
    assert.equal(linkFindings.length, 1, JSON.stringify(linkFindings));
    assert.match(linkFindings[0]!.message, /\/sdk\/nowhere/);
    assert.ok(existsSync(path.join(site, "dist/api/index.html")), "the API overview page is built");
    const apiPages = (await walk(path.join(site, "dist/api"))).filter((file) => file.endsWith("index.html"));
    assert.ok(apiPages.length >= 2, `api pages: ${apiPages.join(", ")}`);
    assert.equal(JSON.parse(await read("dist/api/openapi.json")).info.title, "Widgets API");

    // The token in the repo URL reaches no log line and no file the build leaves behind.
    assert.ok(!logs.includes(TOKEN), "the token is not in the build log");
    for (const dir of [".nimbus", "dist", ".astro"]) {
      assert.deepEqual(await filesContaining(path.join(site, dir), TOKEN), [], `no file under ${dir} holds the token`);
    }

    // 2. The remote gone: a pinned ref is a cache hit and makes no fetch.
    await rename(remote.bare, `${remote.bare}.away`);
    const cached = await buildSite(remote.commit);
    assert.match(cached, new RegExp(`nimbus: source "sdk" \\(file://${remote.bare} @ ${remote.commit}\\): using cached commit ${remote.commit.slice(0, 12)}\\.`));
    assert.doesNotMatch(cached, /could not fetch|WARN.*source "sdk"/);
    assert.deepEqual(await gitCalls(), [], "no git network command ran");
    assert.match(await read("dist/sdk/guides/install/index.html"), /Install/);
    assert.ok(!cached.includes(TOKEN));

    // 3. A branch ref picks up a new commit, and the old commit folder goes.
    await rename(`${remote.bare}.away`, remote.bare);
    await writeFile(path.join(remote.work, "docs/guides/publish.md"), "---\ntitle: Publish\n---\n\nPublish a widget.\n");
    git(remote.work, "add", "-A");
    git(remote.work, "commit", "-q", "-m", "publish guide");
    git(remote.work, "push", "-q", remote.bare, "HEAD:main");
    const next = git(remote.work, "rev-parse", "HEAD");
    const editPattern = "https://forge.example.test/acme/sdk/edit/{ref}/{path}";
    const branch = await buildSite("main", {
      config: { editPattern: "https://forge.example.test/acme/docs/edit/main/{path}", sources: { sdk: { repo, ref: "main", path: "docs", editPattern } } },
    });
    assert.match(branch, new RegExp(`nimbus: source "sdk" \\(file://${remote.bare} @ main\\): fetched commit ${next.slice(0, 12)}\\. Ref "main" floats; pin a commit for reproducible builds\\.`));
    assert.match(await read("dist/sdk/guides/publish/index.html"), /Publish/);
    // `{path}` is repository-relative and `{ref}` the configured ref, not the commit.
    assert.match(
      await read("dist/sdk/guides/install/index.html"),
      /href="https:\/\/forge\.example\.test\/acme\/sdk\/edit\/main\/docs\/guides\/install\.md"/,
    );
    assert.ok(!/href="[^"]*[0-9a-f]{40}/.test(await read("dist/sdk/guides/install/index.html")), "the edit URL never carries the resolved commit");
    assert.match(await read("dist/sdk/guides/install/index.html"), new RegExp(`\\.nimbus/sources/sdk/${next}/docs/guides/install\\.md`));
    assert.deepEqual(await readdir(sourceDir), [next], "only the latest commit folder is kept");
    assert.ok(!branch.includes(TOKEN));

    // A second branch build: one ls-remote, no fetch.
    const again = await buildSite("main");
    assert.match(again, new RegExp(`@ main\\): using cached commit ${next.slice(0, 12)}\\.`));
    const calls = await gitCalls();
    assert.equal(calls.filter((line) => line.includes("ls-remote")).length, 1, calls.join("\n"));
    assert.equal(calls.filter((line) => /built-in: git fetch/.test(line)).length, 0, calls.join("\n"));

    // An annotated tag resolves to the commit it points at, not the tag object.
    git(remote.work, "tag", "-a", "v1.0.0", "-m", "release", remote.commit);
    git(remote.work, "push", "-q", remote.bare, "refs/tags/v1.0.0");
    const tagged = await buildSite("v1.0.0");
    assert.match(tagged, new RegExp(`@ v1\\.0\\.0\\): fetched commit ${remote.commit.slice(0, 12)}\\. Ref "v1\\.0\\.0" floats`));
    assert.ok(!existsSync(path.join(site, "dist/sdk/guides/publish/index.html")), "the tag predates the publish guide");

    // A path missing at the commit is the author's error, not a cache fallback.
    await assert.rejects(
      buildSite("main", { logLevel: "silent", config: { sources: { sdk: { repo, ref: "main", path: "guides" } }, api: undefined } }),
      /could not check out source "sdk" \(file:\/\/.* @ main\): path "guides" does not exist at commit/,
    );

    // 4. `check --structure --json` on the site: a templated ref keeps the
    // config readable, a literal branch is floating.
    const checkJson = async () =>
      JSON.parse(formatCheckJson(await runChecks(site, { env: false, structure: true, authoring: false, types: false }))) as {
        status: string;
        findings: { code: string; severity: string; message: string }[];
        scopes: { scope: string; notes: { code: string }[] }[];
      };
    await write("astro.config.ts", astroConfig(`process.env.SDK_DOCS_REF ?? ${JSON.stringify(next)}`));
    const templated = await checkJson();
    const structureNotes = templated.scopes.find((scope) => scope.scope === "structure")?.notes.map((note) => note.code) ?? [];
    assert.ok(!structureNotes.includes("nimbus/config-unresolved"), `notes: ${structureNotes.join(", ")}`);
    assert.ok(!templated.findings.some((finding) => finding.code === "nimbus/config-invalid"), JSON.stringify(templated.findings));
    assert.deepEqual(templated.findings.filter((finding) => finding.code.startsWith("nimbus/source-")), []);
    assert.ok(!JSON.stringify(templated).includes(TOKEN), "check output never carries the token");

    await write("astro.config.ts", astroConfig(JSON.stringify("main")));
    const floating = await checkJson();
    const warning = floating.findings.find((finding) => finding.code === "nimbus/source-floating-ref");
    assert.equal(warning?.severity, "warn");
    assert.match(warning?.message ?? "", new RegExp(`sources\\.sdk follows ref "main" of file://${remote.bare}`));
    assert.ok(!JSON.stringify(floating).includes(TOKEN));

    // 5. No cache and no remote: the build fails naming the source, without the token.
    await rm(path.join(site, ".nimbus/sources"), { recursive: true, force: true });
    await rename(remote.bare, `${remote.bare}.away`);
    await assert.rejects(buildSite(remote.commit), (error: Error) => {
      assert.match(error.message, new RegExp(`could not fetch source "sdk" \\(file://${remote.bare} @ ${remote.commit}\\), and no cached checkout exists under \\.nimbus/sources/sdk/`));
      assert.ok(!error.message.includes(TOKEN), "the error does not carry the token");
      assert.ok(!(error as { hint?: string }).hint?.includes(TOKEN), "the hint does not carry the token");
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
});
