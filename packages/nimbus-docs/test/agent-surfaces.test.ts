// Agent surfaces follow the site's routes: a page's Markdown URL is published
// only where a recorded Markdown route serves it, the indexes and llms-full
// only where their routes exist, and nothing is baked or linked otherwise.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  beginPreparedMarkdownLoad,
  beginPreparedMarkdownSession,
  clearPreparedMarkdownRegistry,
  commitPreparedMarkdownCollection,
  preparedMarkdownRootKey,
} from "../src/_internal/prepared-markdown-registry.ts";
import {
  AGENT_ENDPOINT_ASSET_GENERATION,
  bakeAgentEndpointAssets,
  configureAgentEndpointAssetRoot,
  ensureAgentEndpointAssets,
  readLlmsEndpointPayload,
  readMarkdownEndpointPayload,
  stageAgentEndpointAssets,
} from "../src/_internal/agent-endpoint-assets.ts";
import {
  agentSurfacesFromRoutes,
  describeAgentSurfaces,
  publishesAgentUrl,
  type AgentSurfaces,
} from "../src/_internal/agent-surfaces.ts";
import { pageUrls } from "../src/_internal/page-urls.ts";

const roots: string[] = [];
const capability = { generation: AGENT_ENDPOINT_ASSET_GENERATION, base: "/docs" };

afterEach(async () => {
  clearPreparedMarkdownRegistry();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "nimbus-agent-surfaces-"));
  roots.push(value);
  beginPreparedMarkdownSession(value);
  return value;
}

function commit(root: string, entries: Array<{ id: string; body: string; title: string }>): void {
  const key = preparedMarkdownRootKey(root);
  const epoch = beginPreparedMarkdownLoad(key, "docs", false);
  assert.equal(
    commitPreparedMarkdownCollection(
      key,
      "docs",
      epoch,
      capability,
      entries.map((entry) => ({
        id: entry.id,
        body: entry.body,
        filePath: `src/content/docs/${entry.id}.mdx`,
        data: { title: entry.title },
      })) as never,
      new Map(entries.map((entry) => [entry.id, []])),
      "page",
    ),
    true,
  );
}

const REGEX_SYNTAX = new Set("^$\\.*+?()[]{}|/");
const literal = (value: string) => [...value].map((char) => (REGEX_SYNTAX.has(char) ? `\\${char}` : char)).join("");

/** Route records as `recordMarkdownRoutes` produces them, from patterns. */
function route(pattern: string, shared?: "markdown" | "source" | "llms") {
  const source = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith("[...")
        ? "(?:(.*?)/)?"
        : segment.startsWith("[")
          ? "([^/]+)/"
          : `${literal(segment)}/`,
    )
    .join("")
    .replace(/\/$/u, "");
  const regex = new RegExp(`^/${source}$`, "u");
  return { pattern, entrypoint: `src/pages${pattern}.ts`, regex, params: [], prerendered: true, ...(shared ? { shared } : {}) };
}
const STARTER = [
  route("/[...slug]/index.md", "markdown"),
  route("/[...slug]/index.mdx", "source"),
  route("/llms.txt", "llms"),
  route("/[...section]/llms.txt", "llms"),
  route("/llms-full.txt", "llms"),
];

test("publishesAgentUrl answers from the recorded routes, per URL", () => {
  assert.equal(publishesAgentUrl(STARTER, "/guide/index.md"), true);
  assert.equal(publishesAgentUrl(STARTER, "/index.md"), true);
  assert.equal(publishesAgentUrl(STARTER, "/guide/index.mdx"), true);
  assert.equal(publishesAgentUrl([], "/guide/index.md"), false);
  const scoped = [route("/changelog/[...slug]/index.md", "markdown")];
  assert.equal(publishesAgentUrl(scoped, "/changelog/2026/index.md"), true);
  assert.equal(publishesAgentUrl(scoped, "/guide/index.md"), false);
  // A site's own `.md` route counts as much as the shared factory.
  assert.equal(publishesAgentUrl([route("/guide/index.md")], "/guide/index.md"), true);
  // The section route's regex matches /llms.txt with an empty section, which
  // the section factory refuses: only a route at /llms.txt serves the index.
  const noRoot = STARTER.filter((r) => r.pattern !== "/llms.txt");
  assert.equal(publishesAgentUrl(noRoot, "/llms.txt"), false);
  assert.equal(publishesAgentUrl(noRoot, "/guide/llms.txt"), true);
  assert.equal(agentSurfacesFromRoutes(noRoot).llms, false);
  assert.equal(agentSurfacesFromRoutes(noRoot).llmsSections, true);
});

test("agentSurfacesFromRoutes reads the index and llms-full routes", () => {
  const all = agentSurfacesFromRoutes(STARTER);
  assert.deepEqual([all.llms, all.llmsSections, all.llmsFull], [true, true, true]);
  const none = agentSurfacesFromRoutes([route("/[...slug]/index.md", "markdown")]);
  assert.deepEqual([none.llms, none.llmsSections, none.llmsFull], [false, false, false]);
  // The injected per-mount section index counts as a section route.
  assert.equal(agentSurfacesFromRoutes([route("/products/sdk/[llms].txt")]).llmsSections, true);
  assert.match(describeAgentSurfaces({ pageMarkdown: false, source: true, llms: true, llmsSections: false, llmsFull: false, mcpBodies: true }).join(" "), /Page Markdown: off .*bodies kept for agents\.mcp/);
});

test("pageUrls publishes a Markdown or source URL only where a route serves it", () => {
  const none = pageUrls("", { id: "guide", body: "x" }, () => false);
  assert.equal(none.markdownUrl, undefined);
  assert.equal(none.sourceUrl, undefined);
  assert.equal(none.url, "/guide/");
  const markdownOnly = pageUrls("", { id: "guide", body: "x" }, (url) => url.endsWith(".md"));
  assert.deepEqual([markdownOnly.markdownUrl, markdownOnly.sourceUrl], ["/guide/index.md", undefined]);
});

function surfaces(routes: ReturnType<typeof route>[]): AgentSurfaces {
  return agentSurfacesFromRoutes(routes);
}

test("with no Markdown route the bake writes no page Markdown and the indexes link the pages", async () => {
  const projectRoot = await root();
  commit(projectRoot, [
    { id: "guide", body: "Guide body", title: "Guide" },
    { id: "index", body: "Home body", title: "Home" },
  ]);
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      surfaces: surfaces([route("/llms.txt", "llms"), route("/[...section]/llms.txt", "llms"), route("/llms-full.txt", "llms")]),
    }),
  );
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  assert.deepEqual(manifest.markdownAssets, []);
  const index = await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "index" });
  assert.match(index.body, /\(https:\/\/example\.test\/docs\/guide\/\)/);
  assert.doesNotMatch(index.body, /index\.md/);
  const full = await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "full" });
  assert.match(full.body, /Source: https:\/\/example\.test\/docs\/guide\/\n/);
  assert.doesNotMatch(full.body, /Markdown: /);
});

test("the bake keeps page bodies for the MCP server without publishing a URL", async () => {
  const projectRoot = await root();
  commit(projectRoot, [{ id: "guide", body: "Guide body", title: "Guide" }]);
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      mcpUrl: "https://example.test/docs/mcp",
      surfaces: surfaces([route("/llms.txt", "llms")]),
    }),
  );
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  const guide = manifest.markdownAssets.find((asset) => asset.id === "guide" && asset.surface === "markdown");
  assert.ok(guide);
  assert.equal(guide.published, false);
  assert.equal(manifest.markdownAssets.some((asset) => asset.surface === "source"), false);
  const payload = await readMarkdownEndpointPayload(projectRoot, { collection: "docs", id: "guide", surface: "markdown" });
  assert.match(payload.content, /Guide body/);
  // No `.mdx` route: the body names no source file.
  assert.doesNotMatch(payload.body, /Source: /);
  const staged = path.join(projectRoot, "dist", "client");
  await stageAgentEndpointAssets(projectRoot, staged);
  const pageIndex = JSON.parse(
    await readFile(path.join(staged, "_nimbus", "agent-endpoint-assets", manifest.pageIndex!.path), "utf8"),
  ) as { pages: Array<{ markdownUrl?: string; markdownPath: string }> };
  assert.equal(pageIndex.pages[0]!.markdownUrl, undefined);
  assert.equal(pageIndex.pages[0]!.markdownPath, "/guide/index.md");
});

test("without an llms.txt route there is no index, no index note and no llms-full index line", async () => {
  const projectRoot = await root();
  commit(projectRoot, [{ id: "guide", body: "Guide body", title: "Guide" }]);
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      surfaces: surfaces([route("/[...slug]/index.md", "markdown"), route("/llms-full.txt", "llms")]),
    }),
  );
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  assert.deepEqual(
    manifest.llmsAssets.map((asset) => `${asset.scope}:${asset.surface}`),
    ["site:full"],
  );
  const payload = await readMarkdownEndpointPayload(projectRoot, { collection: "docs", id: "guide", surface: "markdown" });
  assert.doesNotMatch(payload.body, /Documentation Index/);
  const full = await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "full" });
  assert.doesNotMatch(full.body, /^Index: /mu);
});

test("every starter route gives today's output: markdown, source, indexes and the full document", async () => {
  const projectRoot = await root();
  commit(projectRoot, [{ id: "guide", body: "Guide body", title: "Guide" }]);
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      surfaces: surfaces(STARTER),
    }),
  );
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  assert.deepEqual(
    manifest.markdownAssets.map((asset) => `${asset.surface}:${asset.url}:${asset.published ?? true}`).sort(),
    ["markdown:/guide/index.md:true", "source:/guide/index.mdx:true"],
  );
  assert.ok(manifest.llmsAssets.some((asset) => asset.scope === "site" && asset.surface === "index"));
  const payload = await readMarkdownEndpointPayload(projectRoot, { collection: "docs", id: "guide", surface: "markdown" });
  assert.match(payload.body, /Documentation Index/);
  assert.match(payload.body, /Source: https:\/\/example\.test\/docs\/guide\/index\.mdx/);
});

test("a scoped Markdown route publishes only the pages it matches", async () => {
  const projectRoot = await root();
  commit(projectRoot, [
    { id: "guide", body: "Guide body", title: "Guide" },
    { id: "changelog/2026", body: "Entry body", title: "Entry" },
  ]);
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      surfaces: surfaces([route("/changelog/[...slug]/index.md", "markdown"), route("/llms.txt", "llms")]),
    }),
  );
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  assert.deepEqual(
    manifest.markdownAssets.map((asset) => asset.url),
    ["/changelog/2026/index.md"],
  );
  const index = await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "index" });
  assert.match(index.body, /\[Guide\]\(https:\/\/example\.test\/docs\/guide\/\)/);
  assert.match(index.body, /changelog\/2026\/index\.md/);
});

test("bodies kept only for the build never reach the staged deploy, and MCP's do", async () => {
  for (const mcp of [false, true]) {
    const projectRoot = await root();
    commit(projectRoot, [{ id: "guide", body: "Guide body", title: "Guide" }]);
    configureAgentEndpointAssetRoot(projectRoot, "build", () =>
      bakeAgentEndpointAssets({
        root: projectRoot,
        base: "/docs",
        site: "https://example.test",
        title: "Test",
        buildBodies: true,
        ...(mcp ? { mcpUrl: "https://example.test/docs/mcp" } : {}),
        surfaces: surfaces([route("/llms.txt", "llms")]),
      }),
    );
    const baked = await ensureAgentEndpointAssets(projectRoot);
    assert.equal(baked.markdownAssets.length, 1, "the body is in the build cache");
    assert.equal(baked.markdownAssets[0]!.published, false);
    const out = path.join(projectRoot, "dist", "client");
    await stageAgentEndpointAssets(projectRoot, out);
    const staged = JSON.parse(
      await readFile(path.join(out, "_nimbus", "agent-endpoint-assets", "manifest.json"), "utf8"),
    ) as { markdownAssets: Array<{ path: string }> };
    assert.equal(staged.markdownAssets.length, mcp ? 1 : 0, `mcp=${mcp}`);
    const { existsSync } = await import("node:fs");
    assert.equal(
      existsSync(path.join(out, "_nimbus", "agent-endpoint-assets", baked.markdownAssets[0]!.path)),
      mcp,
      `asset file staged only for MCP (mcp=${mcp})`,
    );
    clearPreparedMarkdownRegistry();
  }
});

test("every starter route bakes exactly what a bake without route knowledge bakes", async () => {
  const bake = async (withSurfaces: boolean) => {
    const projectRoot = await root();
    commit(projectRoot, [
      { id: "guide", body: "Guide body", title: "Guide" },
      { id: "index", body: "Home body", title: "Home" },
      { id: "reference/options", body: "Options body", title: "Options" },
    ]);
    configureAgentEndpointAssetRoot(projectRoot, "build", () =>
      bakeAgentEndpointAssets({
        root: projectRoot,
        base: "/docs",
        site: "https://example.test",
        title: "Test",
        ...(withSurfaces ? { surfaces: surfaces(STARTER) } : {}),
      }),
    );
    const manifest = await ensureAgentEndpointAssets(projectRoot);
    const strip = (assets: Array<{ path: string; digest: string }>) => assets.map(({ path: _p, ...rest }) => rest);
    const bodies = await Promise.all(
      manifest.markdownAssets.map((asset) =>
        readMarkdownEndpointPayload(projectRoot, { collection: asset.collection, id: asset.id, surface: asset.surface }).then((p) => p.body),
      ),
    );
    const result = { markdown: strip(manifest.markdownAssets), llms: strip(manifest.llmsAssets), bodies };
    clearPreparedMarkdownRegistry();
    return result;
  };
  assert.deepEqual(await bake(true), await bake(false));
});

test("a split full document carries no index line without an llms.txt route", async () => {
  const projectRoot = await root();
  commit(projectRoot, [
    { id: "a/one", body: "x".repeat(400), title: "One" },
    { id: "b/two", body: "y".repeat(400), title: "Two" },
  ]);
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      llmsFullLimitBytes: 600,
      surfaces: surfaces([route("/[...slug]/index.md", "markdown"), route("/llms-full.txt", "llms")]),
    }),
  );
  const full = await readLlmsEndpointPayload(projectRoot, { scope: "site", surface: "full" });
  assert.match(full.body, /split by section/);
  assert.doesNotMatch(full.body, /Index: /);
  assert.doesNotMatch(full.body, /llms\.txt/);
});

test("deleting only the site index route keeps the section indexes and drops the root one", async () => {
  const projectRoot = await root();
  commit(projectRoot, [
    { id: "guide/one", body: "One body", title: "One" },
    { id: "guide/two", body: "Two body", title: "Two" },
  ]);
  configureAgentEndpointAssetRoot(projectRoot, "build", () =>
    bakeAgentEndpointAssets({
      root: projectRoot,
      base: "/docs",
      site: "https://example.test",
      title: "Test",
      surfaces: surfaces(STARTER.filter((r) => r.pattern !== "/llms.txt")),
    }),
  );
  const manifest = await ensureAgentEndpointAssets(projectRoot);
  const indexes = manifest.llmsAssets.filter((asset) => asset.surface === "index").map((asset) => (asset.scope === "section" ? asset.section : "site"));
  assert.deepEqual(indexes, ["guide"]);
  const payload = await readMarkdownEndpointPayload(projectRoot, { collection: "docs", id: "guide/one", surface: "markdown" });
  assert.doesNotMatch(payload.body, /Documentation Index/);
});

test("the runtime falls back to every URL only when Node itself refuses the virtual module", async () => {
  const { unresolvableVirtualModule } = await import("../src/_internal/agent-surfaces-runtime.ts");
  const refused = Object.assign(new Error("Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'virtual:'"), {
    code: "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  });
  assert.equal(unresolvableVirtualModule(refused), true);
  assert.equal(unresolvableVirtualModule(Object.assign(new Error("Failed to load resolved virtual module"), { code: "ERR_LOAD_URL" })), false);
  assert.equal(unresolvableVirtualModule(Object.assign(new Error("Cannot find module 'left-pad'"), { code: "ERR_MODULE_NOT_FOUND" })), false);
  assert.equal(unresolvableVirtualModule(new TypeError("routes is not iterable")), false);
});
