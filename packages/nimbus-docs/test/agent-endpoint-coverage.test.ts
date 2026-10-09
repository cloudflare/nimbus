import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findUngeneratedAgentPages,
  formatUngeneratedAgentPages,
  llmsAssetUrl,
  type EndpointRouteRecord,
} from "../src/_internal/agent-endpoint-coverage.ts";

const route = (
  entrypoint: string,
  pattern: string,
  regex: RegExp,
  prerendered = true,
): EndpointRouteRecord => ({ entrypoint, pattern, regex, prerendered });

const changelog = route(
  "src/pages/changelog/[...slug]/index.md.ts",
  "/changelog/[...slug]/index.md",
  /^\/changelog(?:\/(.*?))?\/index\.md$/,
);
const shared = route("src/pages/[...slug]/index.md.ts", "/[...slug]/index.md", /^(?:\/(.*?))?\/index\.md$/, false);
const section = route("src/pages/[section]/llms.txt.ts", "/[section]/llms.txt", /^\/([^/]+?)\/llms\.txt$/);

test("llms asset URLs follow the starter routes", () => {
  assert.equal(llmsAssetUrl({ scope: "site", surface: "index" }), "/llms.txt");
  assert.equal(llmsAssetUrl({ scope: "site", surface: "full" }), "/llms-full.txt");
  assert.equal(
    llmsAssetUrl({ scope: "section", surface: "index", section: "v1" }),
    "/v1/llms.txt",
  );
});

test("reports ungenerated URLs with the first matching endpoint and skips unserved ones", () => {
  const missing = findUngeneratedAgentPages(
    [changelog, shared, section],
    ["/guide/index.md", "/changelog/a/index.md", "/changelog/b/index.md", "/guide/index.mdx", "/v1/llms.txt", "/llms.txt"],
    new Set(["/changelog/a/index.md", "/v1/llms.txt"]),
  );
  // `/guide/index.md` belongs to the request-rendered shared route, which
  // serves it on request — agent files follow the rendering policy, so that
  // is normal operation, not a missing file.
  assert.deepEqual(
    missing.map(({ url, owner }) => [url, owner.entrypoint]),
    [["/changelog/b/index.md", changelog.entrypoint]],
  );
  assert.equal(
    formatUngeneratedAgentPages(missing).split("\n").slice(0, 2).join("\n"),
    [
      "nimbus-docs: 1 Markdown or llms.txt page was not prerendered:",
      "  - src/pages/changelog/[...slug]/index.md.ts (/changelog/[...slug]/index.md) is prerendered but did not generate: /changelog/b/index.md",
    ].join("\n"),
  );
});

test("lists ten URLs per route and counts the rest", () => {
  const urls = Array.from({ length: 12 }, (_, index) => `/p${String(index).padStart(2, "0")}/index.md`);
  const prerenderedShared = { ...shared, prerendered: true };
  const message = formatUngeneratedAgentPages(
    findUngeneratedAgentPages([prerenderedShared], urls, new Set()),
  );
  assert.match(message, /^nimbus-docs: 12 Markdown or llms\.txt pages were not prerendered:/);
  assert.match(message, /\/p09\/index\.md and 2 more\n/);
  assert.doesNotMatch(message, /\/p10\//);
});
