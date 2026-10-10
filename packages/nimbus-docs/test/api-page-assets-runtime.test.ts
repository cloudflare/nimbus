import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveApiAssetLinks } from "../src/_internal/api/page-assets-links.js";
import { apiAssetMetadata } from "../src/_internal/api/page-assets-runtime.js";
import { resolveApiFamily } from "../src/_internal/api/resolve-versions.js";
import { parsePageAssetIndex } from "../src/_internal/page-assets.js";
import { assertApiPickerSourceUpgrade } from "../src/_internal/api-picker-upgrade.js";

const id = "api:operation:getPets";
const token = `nimbus-ref:v1:${Buffer.from(id).toString("base64url")}`;
const rows = [
  {
    id,
    slug: "pets/list",
    title: "List pets",
    location: { filename: `record-${"a".repeat(64)}.json` },
  },
];
const index = () =>
  parsePageAssetIndex({
    revision: 1,
    rows,
    metadata: {
      matches: {},
      canonicalSlugs: {},
      nav: { version: 2, nav: { items: [] }, paths: {} },
    },
  });
const targets = resolveApiFamily({
  collection: "api",
  versionUrl: { in: "query" },
  versions: [
    { version: "v2", default: true, spec: {} },
    { version: "v1", spec: {} },
  ],
});

test("one immutable record resolves independently across versions and preserves authored content", () => {
  const record = {
    apiSchemaVersion: 1,
    coordinate: id,
    href: token,
    breadcrumbs: [{ href: token + "#name%20value" }],
    description: "[authored](/api/other?version=v0)",
    samples: [{ source: "GET /api/pets" }],
  };
  const historical = resolveApiAssetLinks(
    record,
    targets[1]!,
    index(),
  ) as typeof record & { markdownHref?: string };
  const latest = resolveApiAssetLinks(
    record,
    targets[0]!,
    index(),
  ) as typeof historical;
  assert.equal(historical.href, "/api/pets/list/?version=v1");
  assert.equal(
    historical.breadcrumbs[0]!.href,
    "/api/pets/list/?version=v1#name%20value",
  );
  assert.equal(historical.markdownHref, undefined);
  assert.equal(latest.href, "/api/pets/list/");
  assert.equal(latest.markdownHref, "/api/pets/list/index.md");
  assert.equal(record.href, token);
  assert.equal(latest.description, record.description);
  assert.deepEqual(latest.samples, record.samples);
});

test("invalid tokens and missing generated destinations fail instead of linking to latest", () => {
  for (const invalid of [
    "nimbus-ref:v2:abc",
    "nimbus-ref:v1:*",
    "nimbus-ref:v1:_w",
    `nimbus-ref:v1:${Buffer.from("missing").toString("base64url")}`,
  ]) {
    assert.throws(() => resolveApiAssetLinks(invalid, targets[0]!, index()));
  }
});

test("API consumer validates opaque index metadata", () => {
  assert.ok(apiAssetMetadata(index()));
  for (const metadata of [
    null,
    { nav: {}, matches: {} },
    { ...(index().metadata as object), matches: { [id]: 42 } },
    { ...(index().metadata as object), canonicalSlugs: { [id]: 42 } },
  ]) {
    const value = index();
    value.metadata = metadata;
    assert.throws(() => apiAssetMetadata(value));
  }
});

test("upgrade guard finds imported aliases but allows migrated and unrelated pickers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-picker-guard-"));
  const filename = path.join(
    root,
    "components/ui/version-switcher/VersionSwitcher.astro",
  );
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    for (const source of [
      'import { getApiVersionAlternates as eager } from "@cloudflare/nimbus-docs/runtime"; await eager("api", "v1", "x");',
      'import * as nimbus from "@cloudflare/nimbus-docs/runtime"; await nimbus.getApiVersionAlternates("api", "v1", "x");',
    ]) {
      const awaitSource = `---\n${source}\n---\n`;
      await writeFile(filename, awaitSource);
      assert.throws(
        () => assertApiPickerSourceUpgrade(filename, awaitSource, ["api"]),
        /VersionSwitcher\.astro.*api-request-path/,
      );
      assert.doesNotThrow(() =>
        assertApiPickerSourceUpgrade(filename, awaitSource, []),
      );
    }
    await writeFile(
      filename,
      '---\nimport { getVersionSwitchUrl } from "@cloudflare/nimbus-docs/runtime";\n---\n',
    );
    assert.doesNotThrow(() =>
      assertApiPickerSourceUpgrade(
        filename,
        '---\nimport { getVersionSwitchUrl } from "@cloudflare/nimbus-docs/runtime";\n---\n',
        ["api"],
      ),
    );
    assert.doesNotThrow(() =>
      assertApiPickerSourceUpgrade(
        filename,
        '---\nimport { getApiVersionAlternates } from "@cloudflare/nimbus-docs/runtime"; await getApiVersionAlternates("staticApi", "v1", "x");\n---\n',
        ["api"],
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
