/**
 * Tests for `parseComponentsRegistry` — the text-level reader the MDX
 * validator uses to learn which PascalCase globals the user registered in
 * `src/components.ts`, without executing the file.
 *
 * The headline regression: the old regex-only parser captured up to the
 * first `\n\s*}`, so any entry declared after a multi-line nested object
 * literal was dropped — and a dropped name means the validator falsely flags
 * a genuinely-registered component as unregistered. The brace-walking rewrite
 * fixes that; several cases below pin it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseComponentsRegistry } from "../../src/_internal/parse-components-registry.js";

function withTempFile<T>(
  source: string,
  body: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-pcr-"));
  const file = path.join(dir, "components.ts");
  fs.writeFileSync(file, source);
  return body(file).finally(() =>
    fs.rmSync(dir, { recursive: true, force: true }),
  );
}

test("parses shorthand, aliased, and string-key entries", async () => {
  await withTempFile(
    `
import Callout from "./Callout.astro";
export const components = {
  Callout,
  Aside: Callout,
  "Card": Callout,
};
`,
    async (file) => {
      const names = await parseComponentsRegistry(file);
      assert.deepEqual(names, ["Callout", "Aside", "Card"]);
    },
  );
});

test("captures entries declared after a multi-line nested object literal", async () => {
  // The core regression. `Config`'s value spans a multi-line object, whose
  // closing `\n  })` is exactly what the old non-greedy regex terminated on —
  // dropping `Aside` and `Tabs` entirely.
  await withTempFile(
    `
export const components = {
  Callout,
  Config: makeComponent({
    variant: "info",
    meta: { nested: true },
  }),
  Aside,
  Tabs,
};
`,
    async (file) => {
      const names = await parseComponentsRegistry(file);
      assert.deepEqual(names, ["Callout", "Config", "Aside", "Tabs"]);
    },
  );
});

test("comment-embedded braces and commas don't terminate or split entries", async () => {
  await withTempFile(
    `
export const components = {
  // a trailing brace } and comma , inside a line comment
  Callout,
  /* block comment with { braces } and , commas */
  Aside,
};
`,
    async (file) => {
      const names = await parseComponentsRegistry(file);
      assert.deepEqual(names, ["Callout", "Aside"]);
    },
  );
});

test("skips spreads, computed keys, and non-PascalCase keys", async () => {
  await withTempFile(
    `
export const components = {
  ...shared,
  [dynamicKey]: Whatever,
  lowercase: Thing,
  Valid,
};
`,
    async (file) => {
      const names = await parseComponentsRegistry(file);
      assert.deepEqual(names, ["Valid"]);
    },
  );
});

test("tolerates a type annotation and a `satisfies` clause on the declaration", async () => {
  await withTempFile(
    `
export const components: Record<string, unknown> = {
  Callout,
  Aside,
} satisfies Record<string, unknown>;
`,
    async (file) => {
      const names = await parseComponentsRegistry(file);
      assert.deepEqual(names, ["Callout", "Aside"]);
    },
  );
});

test("returns null on a missing file", async () => {
  const names = await parseComponentsRegistry("/tmp/nimbus-no-such-components.ts");
  assert.equal(names, null);
});

test("returns null when there is no parseable components export", async () => {
  await withTempFile(`export const other = { Callout };\n`, async (file) => {
    const names = await parseComponentsRegistry(file);
    assert.equal(names, null);
  });
});
