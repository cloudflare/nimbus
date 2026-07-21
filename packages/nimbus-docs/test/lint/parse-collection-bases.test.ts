/**
 * Tests for `parseCollectionBases` — the parser the duplicate-slug check
 * uses to find each registered collection's on-disk base folder.
 *
 * Lives under test/lint/ rather than a sibling _internal/ test directory
 * because the lint check is its only consumer today; if a second consumer
 * appears (e.g. orphan-page), promote the tests to a shared location.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseCollectionBases } from "../../src/_internal/parse-content-collections.js";

function withTempConfig<T>(
  source: string,
  body: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-pcb-"));
  const file = path.join(dir, "content.config.ts");
  fs.writeFileSync(file, source);
  return body(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("parseCollectionBases defaults base to the collection key when no override", async () => {
  await withTempConfig(
    `
import { defineCollection } from "astro:content";
import { docsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection()),
  blog: defineCollection(docsCollection()),
};
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.ok(map !== null);
      assert.equal(map.get("docs"), "docs");
      assert.equal(map.get("blog"), "blog");
    },
  );
});

test("parseCollectionBases reads `base:` overrides from Nimbus helper calls", async () => {
  await withTempConfig(
    `
import { defineCollection } from "astro:content";
import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection({ base: "documentation" })),
  partials: defineCollection(partialsCollection({ base: "frags" })),
};
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.ok(map !== null);
      assert.equal(map.get("docs"), "documentation");
      assert.equal(map.get("partials"), "frags");
    },
  );
});

test("parseCollectionBases handles single-quote bases too", async () => {
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = {
  docs: defineCollection(docsCollection({ base: 'documentation' })),
};
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.equal(map?.get("docs"), "documentation");
    },
  );
});

test("parseCollectionBases falls back to the key for shorthand entries with no base override", async () => {
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content";
const docs = defineCollection(docsCollection());

export const collections = {
  docs,
  blog: defineCollection(docsCollection({ base: "posts" })),
};
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.equal(map?.get("docs"), "docs");
      assert.equal(map?.get("blog"), "posts");
    },
  );
});

test("parseCollectionBases resolves shorthand entries to their local declaration's base override", async () => {
  await withTempConfig(
    `
import { defineCollection } from "astro:content";
import { docsCollection } from "@cloudflare/nimbus-docs/content";

const docs = defineCollection(docsCollection({ base: "documentation" }));
const blog = defineCollection(docsCollection({ base: "posts" }));

export const collections = { docs, blog };
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.equal(map?.get("docs"), "documentation");
      assert.equal(map?.get("blog"), "posts");
    },
  );
});

test("parseCollectionBases resolves shorthand entries across nested expressions", async () => {
  // The declaration's value contains parens/braces; the walker needs to
  // track depth so it captures the entire expression, not just up to the
  // first `;`-ish token inside an option object.
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content";

const docs = defineCollection(
  docsCollection({
    base: "documentation",
    schemaFields: { audience: z.string().optional() },
  }),
);

export const collections = { docs };
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.equal(map?.get("docs"), "documentation");
    },
  );
});

test("parseCollectionBases distinguishes shorthand keys from unrelated declarations", async () => {
  // A `const docs = …` declaration with no base AND a `const documentation
  // = …` with a base must not cross-contaminate.
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content";

const documentation = defineCollection(docsCollection({ base: "elsewhere" }));
const docs = defineCollection(docsCollection());

export const collections = { docs };
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      // \`docs\` resolves to its own declaration (no base override) → "docs".
      assert.equal(map?.get("docs"), "docs");
    },
  );
});

test("parseCollectionBases handles let/var as well as const for shorthand", async () => {
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content";

let docs = defineCollection(docsCollection({ base: "doc-pages" }));
export const collections = { docs };
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.equal(map?.get("docs"), "doc-pages");
    },
  );
});

test("parseCollectionBases honors ASI — semicolonless shorthand doesn't bleed into the next statement", async () => {
  // The walker must honor ASI: stop at the first top-level newline after the
  // value has produced non-whitespace content.
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content"

const docs = defineCollection(docsCollection())
export const collections = {
  docs,
  blog: defineCollection(docsCollection({ base: "posts" })),
}
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      // \`docs\` has no base override → defaults to the key, NOT "posts".
      assert.equal(map?.get("docs"), "docs");
      // The colon-form entry for blog still resolves correctly.
      assert.equal(map?.get("blog"), "posts");
    },
  );
});

test("parseCollectionBases tolerates a leading newline before the value (ASI doesn't fire mid-assignment)", async () => {
  // The ASI termination must only fire AFTER non-whitespace has been seen.
  // A line break right after `=` doesn't end the statement — the walker
  // keeps scanning to the actual value on the next line.
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content"

const docs =
  defineCollection(docsCollection({ base: "documentation" }))

export const collections = { docs }
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.equal(map?.get("docs"), "documentation");
    },
  );
});

test("parseCollectionBases tolerates type annotations on the declaration", async () => {
  // A TypeScript annotation between identifier and `=` should be skipped
  // over without confusing the `=` finder.
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content";

const docs: ReturnType<typeof defineCollection> = defineCollection(
  docsCollection({ base: "documentation" }),
);

export const collections = { docs };
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      assert.equal(map?.get("docs"), "documentation");
    },
  );
});

test("parseCollectionBases ignores `base:` written outside the collection registration", async () => {
  // Comments are stripped before parsing, but a `base:` inside an *option*
  // for an UNRELATED call could otherwise match. Confirm the per-entry
  // scope holds.
  await withTempConfig(
    `
import { docsCollection } from "@cloudflare/nimbus-docs/content";
const someOtherConfig = { base: "elsewhere" };

export const collections = {
  docs: defineCollection(docsCollection()),
};
`,
    async (file) => {
      const map = await parseCollectionBases(file);
      // The \`docs\` entry has no \`base:\` — should default to \`"docs"\`,
      // NOT pick up the unrelated literal above.
      assert.equal(map?.get("docs"), "docs");
    },
  );
});

test("parseCollectionBases returns null on a missing file", async () => {
  const map = await parseCollectionBases("/tmp/nimbus-no-such-file.ts");
  assert.equal(map, null);
});
