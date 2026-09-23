import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(
    new URL("../src/_internal/request-route-inventory.ts", import.meta.url),
  ),
  "utf8",
);

test("request inventory keeps build-only asset code out of the server graph", () => {
  assert.doesNotMatch(
    source,
    /from\s+["']\.\/agent-endpoint-assets\.js["']/,
  );
  assert.match(
    source,
    /const specifier = \[\s*"@cloudflare\/nimbus-docs",\s*"_internal\/agent-endpoint-assets",\s*\]\.join\("\/"\)/,
  );
  assert.match(
    source,
    /import\(\/\*\s*@vite-ignore\s*\*\/\s*specifier\)/,
  );
});
