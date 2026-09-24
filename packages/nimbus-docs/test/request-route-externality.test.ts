import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const inventorySource = readFileSync(
  fileURLToPath(
    new URL("../src/_internal/request-route-inventory.ts", import.meta.url),
  ),
  "utf8",
);
const readerSource = readFileSync(
  fileURLToPath(
    new URL("../src/_internal/agent-endpoint-asset-reader.ts", import.meta.url),
  ),
  "utf8",
);
const runtimeSource = readFileSync(
  fileURLToPath(new URL("../src/runtime.ts", import.meta.url)),
  "utf8",
);
const projectorSource = readFileSync(
  fileURLToPath(
    new URL("../src/_internal/api-projector.ts", import.meta.url),
  ),
  "utf8",
);

test("request inventory keeps build-only asset code out of the server graph", () => {
  assert.doesNotMatch(
    inventorySource,
    /from\s+["']\.\/agent-endpoint-assets\.js["']/,
  );
  assert.match(
    inventorySource,
    /from\s+["']\.\/agent-endpoint-asset-reader\.js["']/,
  );
  assert.doesNotMatch(
    readerSource,
    /(?:from\s+|import\()["']\.\/agent-endpoint-assets\.js["']/,
  );
  assert.doesNotMatch(
    runtimeSource,
    /import\(["']\.\/_internal\/api-loader\.js["']\)/,
  );
  assert.match(
    runtimeSource,
    /from\s+["']\.\/_internal\/api-projector\.js["']/,
  );
  assert.doesNotMatch(
    projectorSource,
    /(?:from\s+|import\()["']\.\/api-loader\.js["']/,
  );
});
