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
  assert.deepEqual(
    missing.map(({ url, owner }) => [url, owner.entrypoint]),
    [
      ["/changelog/b/index.md", changelog.entrypoint],
      ["/guide/index.md", shared.entrypoint],
    ],
  );
  assert.equal(
    formatUngeneratedAgentPages(missing).split("\n").slice(0, 3).join("\n"),
    [
      "nimbus-docs: 2 Markdown or llms.txt pages were not prerendered:",
      "  - src/pages/changelog/[...slug]/index.md.ts (/changelog/[...slug]/index.md) is prerendered but did not generate: /changelog/b/index.md",
      "  - src/pages/[...slug]/index.md.ts (/[...slug]/index.md) is rendered on request, so the build has no file for: /guide/index.md",
    ].join("\n"),
  );
});

test("lists ten URLs per route and counts the rest", () => {
  const urls = Array.from({ length: 12 }, (_, index) => `/p${String(index).padStart(2, "0")}/index.md`);
  const message = formatUngeneratedAgentPages(
    findUngeneratedAgentPages([shared], urls, new Set()),
  );
  assert.match(message, /^nimbus-docs: 12 Markdown or llms\.txt pages were not prerendered:/);
  assert.match(message, /\/p09\/index\.md and 2 more\n/);
  assert.doesNotMatch(message, /\/p10\//);
});
