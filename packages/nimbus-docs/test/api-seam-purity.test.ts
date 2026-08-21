// Enforces the seam rule: `./api` exposes ONLY the frozen view-model. No spine
// IR type (DocsModel/Node/Facts/NodeKind) may be re-exported, and the runtime
// export set is exactly the documented helpers + the version constant + ApiBuildError.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as api from "../src/api/index.js";

const source = readFileSync(
  fileURLToPath(new URL("../src/api/index.ts", import.meta.url)),
  "utf8",
);

describe("api seam purity", () => {
  test("no spine IR type is exported from ./api", () => {
    const exportBlocks = source.match(/export\s+(type\s+)?\{[^}]*\}/g) ?? [];
    for (const block of exportBlocks) {
      assert.doesNotMatch(block, /\bDocsModel\b/);
      assert.doesNotMatch(block, /\bNodeKind\b/);
      assert.doesNotMatch(block, /\bFacts\b/);
      assert.doesNotMatch(block, /(^|[^i])\bNode\b/);
    }
  });

  test("runtime exports are exactly the frozen surface", () => {
    assert.deepEqual(
      Object.keys(api).sort(),
      [
        "ApiBuildError",
        "apiSchemaVersion",
        "buildApiModel",
        "clearApiModelCache",
        "getApiModel",
        "getApiNav",
        "getApiPageIndex",
        "getApiPageProps",
        "getApiPageSlugs",
        "renderApiPageMarkdown",
      ].sort(),
    );
  });

  test("apiSchemaVersion is frozen at 1", () => {
    assert.equal(api.apiSchemaVersion, 1);
  });
});
