import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { corpusHash, type SearchCorpusManifest, type SearchCorpusPage } from "../src/_internal/search-corpus.js";
import { createAiSearchApi } from "../src/cli/search/ai-search-api.js";
import { ciGuard } from "../src/cli/search/index.js";
import { itemKey, syncSearchCorpus, type LoadedManifest } from "../src/cli/search/sync.js";
import { startAiSearchStandIn } from "./fixtures/ai-search-stand-in.js";

let outDir: string;
before(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "nimbus-search-sync-"));
});
after(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const VERSION = "a".repeat(64);

/** A built site: one twin file per page, and the manifest pointing at it. */
async function site(pages: Array<{ route: string; body: string; collection?: string; searchable?: boolean }>, collections = ["docs"]) {
  const records: SearchCorpusPage[] = [];
  for (const page of pages) {
    const file = `${page.route.replace(/^\/|\/$/g, "") || "index"}.md`;
    const preamble = "---\ntitle: x\n---\n\n> Documentation Index\n\n";
    const content = Buffer.from(page.body, "utf8");
    await mkdir(path.dirname(path.join(outDir, file)), { recursive: true });
    await writeFile(path.join(outDir, file), Buffer.concat([Buffer.from(preamble), content, Buffer.from("\nSource: x\n")]));
    const meta = { url: `https://example.com${page.route}`, title: page.route, version: VERSION, deprecated: false, product: "site" };
    records.push({
      ...meta,
      collection: page.collection ?? "docs",
      section: "",
      searchable: page.searchable ?? true,
      file,
      contentStart: Buffer.byteLength(preamble),
      contentEnd: Buffer.byteLength(preamble) + content.byteLength,
      bytes: content.byteLength,
      hash: corpusHash(content, meta),
    });
  }
  const manifest: SearchCorpusManifest = {
    format: 1,
    site: "https://example.com",
    base: "/",
    slice: "",
    collections,
    siteCollections: collections,
    versions: [],
    products: [],
    pages: records,
  };
  return [{ manifest, outDir, source: "test" }] satisfies LoadedManifest[];
}

async function withStandIn(run: (standIn: Awaited<ReturnType<typeof startAiSearchStandIn>>, api: ReturnType<typeof createAiSearchApi>) => Promise<void>, options = {}) {
  const standIn = await startAiSearchStandIn(options);
  const api = () =>
    createAiSearchApi({ accountId: standIn.accountId, token: standIn.token, instance: standIn.instance, apiBase: standIn.apiBase, gapMs: 0, backoffMs: 1 });
  try {
    await run(standIn, api());
  } finally {
    await standIn.close();
  }
}

const freshApi = (standIn: Awaited<ReturnType<typeof startAiSearchStandIn>>) =>
  createAiSearchApi({ accountId: standIn.accountId, token: standIn.token, instance: standIn.instance, apiBase: standIn.apiBase, gapMs: 0, backoffMs: 1 });

test("first sync uploads every searchable page with the five fields; a second uploads nothing", async () => {
  await withStandIn(async (standIn, api) => {
    const manifests = await site([
      { route: "/", body: "# Home\n\nWelcome." },
      { route: "/guide/", body: "# Guide\n\nInstall it — ünïcode." },
      { route: "/hidden/", body: "# Hidden\n\nNot searchable.", searchable: false },
    ]);
    const first = await syncSearchCorpus(api, manifests);
    assert.equal(first.uploaded, 2);
    const items = [...standIn.items.values()];
    assert.deepEqual(items.map((item) => item.metadata.url).sort(), ["https://example.com/", "https://example.com/guide/"]);
    const guide = items.find((item) => item.metadata.url === "https://example.com/guide/")!;
    assert.equal(guide.content, "# Guide\n\nInstall it — ünïcode.");
    assert.deepEqual(Object.keys(guide.metadata).sort(), ["deprecated", "product", "title", "url", "version"]);
    assert.match(guide.key, /^docs\/guide-[0-9a-f]{16}\.[0-9a-f]{12}\.md$/);

    const second = await syncSearchCorpus(freshApi(standIn), manifests);
    assert.deepEqual([second.uploaded, second.unchanged, second.replacementDeletes, second.removalDeletes], [0, 2, 0, 0]);
  });
});

test("an edited page is one upload and one replacement delete; a removed page one removal", async () => {
  await withStandIn(async (standIn, api) => {
    await syncSearchCorpus(api, await site([{ route: "/a/", body: "# A\n\none" }, { route: "/b/", body: "# B\n\ntwo" }]));
    const edited = await syncSearchCorpus(freshApi(standIn), await site([{ route: "/a/", body: "# A\n\nchanged" }, { route: "/b/", body: "# B\n\ntwo" }]));
    assert.deepEqual([edited.uploaded, edited.replacementDeletes, edited.removalDeletes], [1, 1, 0]);
    assert.equal([...standIn.items.values()].find((item) => item.metadata.url.toString().endsWith("/a/"))!.content, "# A\n\nchanged");
    assert.equal(standIn.items.size, 2);
    const removed = await syncSearchCorpus(freshApi(standIn), await site([{ route: "/a/", body: "# A\n\nchanged" }]));
    assert.deepEqual([removed.uploaded, removed.removalDeletes], [0, 1]);
    assert.equal(standIn.items.size, 1);
  });
});

test("removing most of a collection needs --force; a dry run changes nothing", async () => {
  await withStandIn(async (standIn, api) => {
    const many = Array.from({ length: 12 }, (_, index) => ({ route: `/p${index}/`, body: `# P${index}\n\ntext` }));
    await syncSearchCorpus(api, await site(many));
    const few = await site(many.slice(0, 1));
    const blocked = await syncSearchCorpus(freshApi(standIn), few);
    assert.deepEqual(blocked.blocked, { docs: { deletes: 11, items: 12 } });
    assert.equal(standIn.items.size, 12);
    const plan = await syncSearchCorpus(freshApi(standIn), few, { dryRun: true, force: true });
    assert.equal(plan.removalDeletes, 11);
    assert.equal(standIn.items.size, 12);
    await syncSearchCorpus(freshApi(standIn), few, { force: true });
    assert.equal(standIn.items.size, 1);
  });
});

test("deletes stay inside the manifest's collections; other folders are orphans or left alone", async () => {
  await withStandIn(async (standIn, api) => {
    await syncSearchCorpus(api, await site([{ route: "/a/", body: "# A\n\none" }, { route: "/api/x/", body: "# X\n\ntwo", collection: "api" }], ["docs", "api"]));
    // A slice that built only `docs`, of a site with `docs` and `api`.
    const slice = await site([{ route: "/a/", body: "# A\n\none" }], ["docs"]);
    slice[0]!.manifest.siteCollections = ["api", "docs"];
    const summary = await syncSearchCorpus(freshApi(standIn), slice);
    assert.equal(summary.removalDeletes, 0);
    assert.deepEqual(summary.orphans, {});
    assert.equal(standIn.items.size, 2);
    // A collection the site no longer has is an orphan, purged on request.
    const dropped = await syncSearchCorpus(freshApi(standIn), await site([{ route: "/a/", body: "# A\n\none" }]));
    assert.deepEqual(dropped.orphans, { api: 1 });
    await syncSearchCorpus(freshApi(standIn), await site([]), { purge: true, collection: "api" });
    assert.equal(standIn.items.size, 1);
  });
});

test("a heading-only page is reported as skipped by the next run, which leaves it alone", async () => {
  await withStandIn(async (standIn, api) => {
    const manifests = await site([{ route: "/empty/", body: "# Empty\n" }, { route: "/full/", body: "# Full\n\ntext" }]);
    const summary = await syncSearchCorpus(api, manifests);
    assert.deepEqual([summary.uploaded, summary.failed.length], [2, 0]);
    const next = await syncSearchCorpus(freshApi(standIn), manifests);
    assert.deepEqual([next.uploaded, next.repaired, next.skipped.length], [0, 0, 1]);
  });
});

test("a schema without the five fields stops the run before any upload", async () => {
  await withStandIn(
    async (standIn, api) => {
      await assert.rejects(syncSearchCorpus(api, await site([{ route: "/a/", body: "# A\n\none" }])), /missing product \(text\)/);
      assert.equal(standIn.items.size, 0);
    },
    { fields: [{ field_name: "url", data_type: "text" }] },
  );
});

test("429s back off and retry", async () => {
  await withStandIn(
    async (standIn, api) => {
      const summary = await syncSearchCorpus(api, await site([{ route: "/a/", body: "# A\n\none" }]));
      assert.equal(summary.uploaded, 1);
      assert.equal(standIn.state.throttle, 0);
    },
    { throttle: 3 },
  );
});

test("keys stay within 128 characters and identify the base-free path", () => {
  const page = { collection: "docs", url: `https://example.com/docs/${"Very Long Ñame ".repeat(20)}/`, hash: "f".repeat(64) };
  const { key } = itemKey(page, "/docs");
  assert.ok(key.length <= 128, key);
  assert.match(key, /^docs\/very-long-/);
  assert.equal(
    itemKey({ ...page, url: "https://example.com/docs/guide/" }, "/docs").pathHash,
    itemKey({ ...page, url: "https://other.example/guide/" }, "/").pathHash,
  );
});

test("the CI guard runs on production pushes and by hand, never on previews", () => {
  const github = (event: string, ref: string) => ({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: event, GITHUB_REF_NAME: ref });
  assert.equal(ciGuard(github("push", "main"), "main").allowed, true);
  assert.equal(ciGuard(github("workflow_dispatch", "main"), "main").allowed, true);
  assert.equal(ciGuard(github("pull_request", "main"), "main").allowed, false);
  assert.equal(ciGuard(github("workflow_run", "main"), "main").allowed, false);
  assert.equal(ciGuard(github("push", "feature"), "main").allowed, false);
  assert.equal(ciGuard({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "preview" }, "main").allowed, false);
  assert.equal(ciGuard({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }, "main").allowed, true);
  assert.deepEqual(ciGuard({}, "main"), { allowed: true, detected: "not detected" });
});

test("check names a bad config, then compares the live instance with the build", async () => {
  const { checkAiSearch } = await import("../src/check/ai-search.js");
  const cwd = await mkdtemp(path.join(tmpdir(), "nimbus-search-check-"));
  const parsed = (search: Record<string, unknown>) => ({ ok: true, config: { search }, unresolved: [] }) as never;
  const codes = (findings: Array<{ code: string }>) => findings.map((finding) => finding.code.replace("nimbus/ai-search-", ""));
  try {
    assert.deepEqual(codes(await checkAiSearch(cwd, parsed({ provider: "ai-search", endpoint: "http://example.com", instance: "Bad Name" }), {})), ["instance", "endpoint"]);
    const config = parsed({ provider: "ai-search", endpoint: "https://x.search.ai.cloudflare.com", instance: "nimbus-demo" });
    assert.deepEqual(codes(await checkAiSearch(cwd, config, {})), ["live"]);
    assert.deepEqual(await checkAiSearch(cwd, parsed({ provider: "pagefind" }), {}), []);

    await withStandIn(async (standIn) => {
      const env = { CLOUDFLARE_ACCOUNT_ID: standIn.accountId, NIMBUS_AI_SEARCH_TOKEN: standIn.token, NIMBUS_AI_SEARCH_API: standIn.apiBase };
      assert.deepEqual(codes(await checkAiSearch(cwd, config, env)), ["settings", "sync"]);
      const [built] = await site([{ route: "/a/", body: "# A\n\none" }]);
      await mkdir(path.join(cwd, "dist", "_nimbus"), { recursive: true });
      await writeFile(path.join(cwd, "dist", "_nimbus", "search-corpus.json"), JSON.stringify({ ...built!.manifest, pages: built!.manifest.pages.map((page) => ({ ...page, file: path.join(path.relative(path.join(cwd, "dist"), outDir), page.file) })) }));
      const behind = await checkAiSearch(cwd, config, env);
      assert.deepEqual(codes(behind), ["settings", "out-of-sync"]);
      assert.match(behind[1]!.message, /1 page to upload, 0 items to remove/);
      await syncSearchCorpus(freshApi(standIn), [built!]);
      assert.deepEqual(codes(await checkAiSearch(cwd, config, env)), ["settings", "in-sync"]);
    });
    await withStandIn(
      async (standIn) => {
        const env = { CLOUDFLARE_ACCOUNT_ID: standIn.accountId, NIMBUS_AI_SEARCH_TOKEN: standIn.token, NIMBUS_AI_SEARCH_API: standIn.apiBase };
        assert.deepEqual(codes(await checkAiSearch(cwd, config, env)), ["fields"]);
      },
      { fields: [{ field_name: "url", data_type: "text" }] },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
