import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  canonicalSlug,
  contentEntryUrl,
  enumerateEntries,
  enumerateEntriesByBase,
  enumerateStaticPageRoutes,
  findDuplicateRoutes,
  formatDuplicateRoutes,
  type ContentEntry,
  type RouteOwner,
} from "../../src/lint/site-model.js";

function entry(collection: string, id: string): ContentEntry {
  return { collection, id, relPath: `${collection}/${id}.mdx` };
}

/** Shorthand to build a content-entry RouteOwner the way the integration would. */
function contentOwner(
  collection: string,
  id: string,
  versions?: { others: string[] } | null,
): RouteOwner {
  const e = entry(collection, id);
  return {
    url: contentEntryUrl(e, versions),
    source: `src/content/${e.relPath}`,
  };
}

test("enumerateEntries reads a content tree from disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-sm-"));
  try {
    fs.mkdirSync(path.join(root, "docs/guides"), { recursive: true });
    fs.mkdirSync(path.join(root, "blog"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/index.mdx"), "x");
    fs.writeFileSync(path.join(root, "docs/guides/setup.mdx"), "x");
    fs.writeFileSync(path.join(root, "blog/post.mdx"), "x");

    const entries = enumerateEntries(root);
    const ids = entries.map((e) => `${e.collection}:${e.id}`).sort();
    assert.deepEqual(ids, ["blog:post", "docs:guides/setup", "docs:index"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enumerateEntries returns empty when the root is missing", () => {
  const missing = path.join(os.tmpdir(), "nimbus-no-such-content");
  assert.deepEqual(enumerateEntries(missing), []);
});

test("enumerateEntries skips node_modules and dotfiles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-sm-"));
  try {
    fs.mkdirSync(path.join(root, "docs/node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs/.cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/node_modules/junk.mdx"), "x");
    fs.writeFileSync(path.join(root, "docs/.cache/junk.mdx"), "x");
    fs.writeFileSync(path.join(root, "docs/real.mdx"), "x");

    const entries = enumerateEntries(root);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["real"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// canonicalSlug
// ---------------------------------------------------------------------------

test("canonicalSlug mirrors Astro's content-layer slug algorithm", () => {
  // Lowercases, github-slug per segment, strips trailing /index.
  assert.equal(canonicalSlug("WIP/specs/lints/spec"), "wip/specs/lints/spec");
  assert.equal(canonicalSlug("WIP/index"), "wip");
  assert.equal(canonicalSlug("index"), "");
  assert.equal(canonicalSlug("getting-started"), "getting-started");
  // Special characters get folded the way github-slugger does.
  assert.equal(canonicalSlug("Hello World"), "hello-world");
});

// ---------------------------------------------------------------------------
// findDuplicateRoutes — groups by URL across all RouteOwner inputs
// (content entries, static page files).
// ---------------------------------------------------------------------------

test("findDuplicateRoutes catches a leaf-vs-folder-index collision", () => {
  // `foo.mdx` and `foo/index.mdx` both canonicalize to URL `/foo` —
  // Astro emits one page and silently shadows the other.
  const dups = findDuplicateRoutes([
    contentOwner("docs", "foo"),
    contentOwner("docs", "foo/index"),
    contentOwner("docs", "bar"),
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/foo");
  assert.equal(dups[0]!.sources.length, 2);
});

test("findDuplicateRoutes catches case-only collisions", () => {
  const dups = findDuplicateRoutes([
    contentOwner("docs", "Foo"),
    contentOwner("docs", "foo"),
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/foo");
});

test("findDuplicateRoutes catches collisions via github-slug normalization", () => {
  // Spaces and hyphens collapse to the same slug.
  const dups = findDuplicateRoutes([
    contentOwner("docs", "Hello World"),
    contentOwner("docs", "hello-world"),
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/hello-world");
});

test("findDuplicateRoutes catches cross-collection collisions (docs root vs sibling collection)", () => {
  // The `docs` collection mounts at root, so `docs/blog/post.mdx` serves
  // at `/blog/post`. A separate `blog` collection mounting at `/blog`
  // with `post.mdx` also serves `/blog/post` — Astro shadows one.
  const dups = findDuplicateRoutes([
    contentOwner("docs", "blog/post"),
    contentOwner("blog", "post"),
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/blog/post");
  assert.equal(dups[0]!.sources.length, 2);
});

test("findDuplicateRoutes flags page-shadows-content as shadowedByPage (warn, not error)", () => {
  const dups = findDuplicateRoutes([
    contentOwner("docs", "ai/models"),
    { url: "/ai/models", source: "src/pages/ai/models/index.astro", kind: "page" },
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/ai/models");
  assert.equal(dups[0]!.shadowedByPage, true);
});

test("findDuplicateRoutes keeps content-vs-content as a hard collision", () => {
  const dups = findDuplicateRoutes([
    contentOwner("docs", "foo"),
    contentOwner("docs", "foo/index"),
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.shadowedByPage, false);
});

test("findDuplicateRoutes still errors when a page sits over MULTIPLE content entries", () => {
  // The page wins the route, but the 2 content entries stay mutually ambiguous.
  const dups = findDuplicateRoutes([
    contentOwner("docs", "ai/models"),
    contentOwner("docs", "ai/models/index"),
    { url: "/ai/models", source: "src/pages/ai/models/index.astro", kind: "page" },
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/ai/models");
  assert.equal(dups[0]!.shadowedByPage, false);
});

test("findDuplicateRoutes treats two pages at one URL as a hard collision", () => {
  const dups = findDuplicateRoutes([
    { url: "/x", source: "src/pages/x.astro", kind: "page" },
    { url: "/x", source: "src/pages/x.md", kind: "page" },
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.shadowedByPage, false);
});

test("findDuplicateRoutes catches version-collection collisions (docs/v1/x vs docs-v1/x)", () => {
  // `docs/v1/intro.mdx` serves `/v1/intro`; `docs-v1/intro.mdx` with `v1`
  // in `versions.others` also serves `/v1/intro` (version collections
  // mount at the version slug, not the collection id).
  const versions = { others: ["v1"] };
  const dups = findDuplicateRoutes([
    contentOwner("docs", "v1/intro", versions),
    contentOwner("docs-v1", "intro", versions),
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/v1/intro");
});

test("findDuplicateRoutes treats unregistered version collections as ordinary collections", () => {
  // `docs-archive` isn't in `versions.others` → it mounts at `/docs-archive`,
  // not `/archive`. So an entry there does NOT collide with `docs/archive/x`.
  const versions = { others: ["v1"] };
  const dups = findDuplicateRoutes([
    contentOwner("docs", "archive/intro", versions),
    contentOwner("docs-archive", "intro", versions),
  ]);
  assert.deepEqual(dups, []);
});

test("findDuplicateRoutes catches page-vs-content collisions", () => {
  // `src/pages/search.astro` and `src/content/docs/search.mdx` both serve
  // `/search`. Astro silently shadows; pre-build dup-detection needs to see
  // *both* sources.
  const dups = findDuplicateRoutes([
    contentOwner("docs", "search"),
    { url: "/search", source: "src/pages/search.astro" },
  ]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.url, "/search");
  assert.ok(dups[0]!.sources.includes("src/content/docs/search.mdx"));
  assert.ok(dups[0]!.sources.includes("src/pages/search.astro"));
});

test("findDuplicateRoutes scopes correctly when collections mount at different prefixes", () => {
  // `docs/foo` serves `/foo`; `blog/foo` serves `/blog/foo`. Not a collision.
  const dups = findDuplicateRoutes([
    contentOwner("docs", "foo"),
    contentOwner("blog", "foo"),
  ]);
  assert.deepEqual(dups, []);
});

test("findDuplicateRoutes is clean when nothing collides", () => {
  const dups = findDuplicateRoutes([
    contentOwner("docs", "a"),
    contentOwner("docs", "b"),
    contentOwner("docs", "c/d"),
  ]);
  assert.deepEqual(dups, []);
});

test("formatDuplicateRoutes renders the URL and both source paths", () => {
  const msg = formatDuplicateRoutes([
    {
      url: "/search",
      sources: ["src/pages/search.astro", "src/content/docs/search.mdx"],
    },
  ]);
  assert.match(msg, /nimbus\/duplicate-slug/);
  assert.match(msg, /\/search/);
  assert.match(msg, /src\/pages\/search\.astro/);
  assert.match(msg, /src\/content\/docs\/search\.mdx/);
});

// ---------------------------------------------------------------------------
// enumerateStaticPageRoutes
// ---------------------------------------------------------------------------

function withTempPages<T>(
  files: Record<string, string>,
  body: (root: string, projectRoot: string) => T,
): T {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-pages-"));
  const pagesRoot = path.join(projectRoot, "src/pages");
  fs.mkdirSync(pagesRoot, { recursive: true });
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = path.join(pagesRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    }
    return body(pagesRoot, projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("enumerateStaticPageRoutes maps static files to served URLs", () => {
  withTempPages(
    {
      "index.astro": "x",
      "search.astro": "x",
      "blog/index.astro": "x",
      "blog/post.md": "x",
      "llms.txt.ts": "x",
      "og.png.ts": "x",
    },
    (pagesRoot, projectRoot) => {
      const routes = enumerateStaticPageRoutes(pagesRoot, projectRoot);
      const urls = routes.map((r) => r.url).sort();
      assert.deepEqual(urls, [
        "/",
        "/blog",
        "/blog/post",
        "/llms.txt",
        "/og.png",
        "/search",
      ]);
      // sources are project-relative.
      assert.ok(routes.every((r) => r.source.startsWith("src/pages/")));
    },
  );
});

test("enumerateStaticPageRoutes skips dynamic-segment routes (they're opaque pre-build)", () => {
  withTempPages(
    {
      "[id].astro": "x",
      "blog/[slug].astro": "x",
      "[...slug].astro": "x",
      "static.astro": "x",
    },
    (pagesRoot, projectRoot) => {
      const routes = enumerateStaticPageRoutes(pagesRoot, projectRoot);
      assert.deepEqual(
        routes.map((r) => r.url),
        ["/static"],
      );
    },
  );
});

test("enumerateStaticPageRoutes skips underscore-prefixed files and directories", () => {
  withTempPages(
    {
      "_helper.astro": "x",
      "_components/Card.astro": "x",
      "og/_og-card-config.ts": "x",
      "index.astro": "x",
    },
    (pagesRoot, projectRoot) => {
      const routes = enumerateStaticPageRoutes(pagesRoot, projectRoot);
      assert.deepEqual(
        routes.map((r) => r.url),
        ["/"],
      );
    },
  );
});

test("enumerateStaticPageRoutes lowercases segments to match Astro's joinSegments", () => {
  withTempPages(
    {
      "Search.astro": "x",
      "Blog/My-Post.mdx": "x",
    },
    (pagesRoot, projectRoot) => {
      const routes = enumerateStaticPageRoutes(pagesRoot, projectRoot);
      const urls = routes.map((r) => r.url).sort();
      assert.deepEqual(urls, ["/blog/my-post", "/search"]);
    },
  );
});

// ---------------------------------------------------------------------------
// enumerateEntriesByBase — handles custom `base:` overrides.
// ---------------------------------------------------------------------------

test("enumerateEntriesByBase walks each collection at its configured base, tags with the key", () => {
  // A `docsCollection({ base: "documentation" })` puts content at
  // `src/content/documentation/` but registers as collection `docs`. Walking
  // with the (key→base) map ensures entries get tagged with the registered
  // key, not the folder.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-bases-"));
  try {
    fs.mkdirSync(path.join(root, "documentation"), { recursive: true });
    fs.mkdirSync(path.join(root, "posts"), { recursive: true });
    fs.writeFileSync(path.join(root, "documentation/intro.mdx"), "x");
    fs.writeFileSync(path.join(root, "posts/hello.mdx"), "x");
    // A folder that isn't registered — should be skipped entirely.
    fs.mkdirSync(path.join(root, "scratch"), { recursive: true });
    fs.writeFileSync(path.join(root, "scratch/note.mdx"), "x");

    const entries = enumerateEntriesByBase(
      root,
      new Map([
        ["docs", "documentation"],
        ["blog", "posts"],
      ]),
    );
    const tagged = entries.map((e) => `${e.collection}:${e.id}`).sort();
    assert.deepEqual(tagged, ["blog:hello", "docs:intro"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
