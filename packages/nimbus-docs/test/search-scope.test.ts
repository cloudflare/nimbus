import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/_internal/search-corpus.js";
import { buildSearchScopeTable, pageScopeOf, versionChoices } from "../src/_internal/search-scope.js";
import { aiSearchFilters, normaliseAiSearchChunks } from "../src/client/ai-search.js";

const table = buildSearchScopeTable({
  versions: { current: "v2", others: ["v1", "v0"], deprecated: ["v1"], hidden: ["v0"] },
  apis: [
    { family: "api", familyPath: "/api", version: "v2", label: "v2", isDefault: true, deprecated: false, hidden: false },
    { family: "api", familyPath: "/api", version: "v1", label: "v1", isDefault: false, deprecated: true, hidden: false },
    { family: "sdk", familyPath: "/sdk/reference", version: "v2", label: "v2", isDefault: true, deprecated: false, hidden: false },
  ],
  hash: sha256Hex,
});

test("docs and API versions with the same label stay apart, and a label selects both", () => {
  const docs = pageScopeOf(table, { collection: "docs" });
  const api = pageScopeOf(table, { collection: "api" });
  const sdk = pageScopeOf(table, { collection: "sdk" });
  assert.notEqual(docs.version, api.version);
  assert.notEqual(api.version, sdk.version);
  assert.deepEqual(versionChoices(table).v2!.sort(), [docs.version, api.version, sdk.version].sort());
  assert.equal(versionChoices(table).v0, undefined, "hidden versions aren't offered");
  assert.equal(pageScopeOf(table, { collection: "api", apiVersion: "v1" }).deprecated, true);
  assert.equal(pageScopeOf(table, { collection: "docs-v1" }).deprecated, true);
});

test("readers search visible current versions, and a deprecated page its own version", () => {
  assert.deepEqual(aiSearchFilters({ version: "h", deprecated: false }), { deprecated: false });
  assert.deepEqual(aiSearchFilters({ version: "h", deprecated: true }), { version: "h" });
  assert.deepEqual(aiSearchFilters(undefined, { versions: ["a", "b"] }), { version: { $in: ["a", "b"] } });
});

test("results keep only this site's pages, as paths, one per page in rank order", () => {
  const chunk = (url: unknown, text = "# Install\n\nRun **it** [here](https://x).", title = "Guide") => ({
    text,
    item: { metadata: { url, title } },
  });
  const sections = normaliseAiSearchChunks(
    {
      result: {
        chunks: [
          chunk("https://example.com/docs/guide/"),
          chunk("https://example.com/docs/guide/", "# Again\n\nsecond chunk"),
          chunk("https://evil.example/docs/x/"),
          chunk("https://user:pass@example.com/docs/x/"),
          chunk("javascript:alert(1)"),
          chunk("https://example.com/other/"),
          chunk("https://example.com//evil.example/docs/x/"),
          chunk("https://example.com/docs/b/", "<img src=x onerror=alert(1)> and `custom_metadata` > 2", "B"),
          { text: "no metadata" },
        ],
      },
    },
    { site: "https://example.com", base: "/docs/" },
  );
  assert.deepEqual(sections, [
    { title: "Guide", heading: "Install", url: "/docs/guide/", excerpt: "Run it here." },
    { title: "B", heading: "", url: "/docs/b/", excerpt: "<img src=x onerror=alert(1)> and custom_metadata > 2" },
  ]);
  assert.equal(normaliseAiSearchChunks({ nope: true }, { site: "https://example.com" }), undefined);
});
