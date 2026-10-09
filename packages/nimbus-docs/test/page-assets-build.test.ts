import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  cp,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PageAssetWriter } from "../src/_internal/page-assets-build.js";
import {
  apiPreparationEnvironment,
  preparationPackages,
  clearApiPageAssetManifest,
  prepareApiAssetFamily,
  readApiAssetPageForBuild,
  externalReferenceReason,
  pruneApiPageAssetCache,
  stagePageAssetDeployment,
  apiPageAssetDeploymentFiles,
  getApiAssetPreparationMetrics,
  resetApiAssetPreparationMetrics,
} from "../src/_internal/api/page-assets-build.js";
import {
  clearCodeStyleRegistry,
  getCodeStyleCSS,
} from "../src/_internal/code-style-registry.js";
import { configurePageAssetCollections } from "../src/_internal/page-assets-config.js";
import { setLinkPolicy } from "../src/_internal/url.js";
import type { ApiSpec } from "../src/types.js";

async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-page-assets-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const spec = (description = "unchanged") => ({
  openapi: "3.0.3",
  info: { title: "Example", version: "1" },
  paths: {
    "/cats": {
      get: {
        operationId: "listCats",
        description,
        responses: { "200": { description: "Success" } },
      },
    },
  },
});
const family = (first: unknown, second = first): ApiSpec => ({
  collection: "api",
  versionMode: "query",
  samples: { generate: [] },
  versions: [
    { version: "v2", default: true, spec: second as Record<string, unknown> },
    { version: "v1", spec: first as Record<string, unknown> },
  ],
});

test("sealed bounded packs share records across runs and never rewrite an earlier pack", async () =>
  temporary(async (root) => {
    const writer = new PageAssetWriter(root, 1024);
    const a = await writer.add({ text: "a".repeat(500) });
    const b = await writer.add({ text: "b".repeat(500) });
    await writer.finishVersion();
    await writer.saveCatalog();
    const before = writer.location(a);
    assert.notEqual(before.filename, writer.location(b).filename);
    assert.ok(
      (
        await readFile(
          path.join(writer.cacheDirectory, "assets", before.filename),
        )
      ).length <= 1024,
    );
    const next = new PageAssetWriter(root, 1024);
    assert.equal(await next.add({ text: "a".repeat(500) }), a);
    await next.add({ text: "new" });
    await next.finishVersion();
    assert.deepEqual(next.location(a), before);
    assert.equal(next.metrics.recordsReused, 1);
  }));

test("API preparation reuses versions, shares unchanged records and keeps URL context out", async () =>
  temporary(async (root) => {
    const first = await prepareApiAssetFamily(root, family(spec()));
    assert.equal(first.versions[0]!.prepared.reused, false);
    assert.equal(first.versions[1]!.prepared.reused, true);
    const operation = first.versions[0]!.prepared.rows.find((row) =>
      row.id.endsWith("listCats"),
    )!;
    assert.ok(operation);
    const page = await readApiAssetPageForBuild(root, operation);
    assert.match(page.href, /^nimbus-ref:v1:/);
    assert.equal(page.markdownHref, undefined);
    const second = await prepareApiAssetFamily(root, family(spec()));
    assert.ok(second.versions.every(({ prepared }) => prepared.reused));
    assert.deepEqual(second.manifest, first.manifest);
    const changed = await prepareApiAssetFamily(
      root,
      family(spec(), spec("changed")),
    );
    assert.equal(changed.versions[0]!.prepared.reused, false);
    assert.equal(changed.versions[1]!.prepared.reused, true);
    assert.notEqual(changed.manifest.v2, first.manifest.v2);
  }));

test("corrupt packed cache rebuilds from the spec; restored CI caches relocate", async () =>
  temporary(async (root) => {
    const first = await prepareApiAssetFamily(root, family(spec()));
    const location = first.versions[0]!.prepared.rows[0]!.location;
    await writeFile(
      path.join(root, ".nimbus/cache/page-assets/assets", location.filename),
      "corrupt",
    );
    const restored = await prepareApiAssetFamily(root, family(spec()));
    assert.equal(restored.versions[0]!.prepared.reused, false);
    assert.deepEqual(restored.manifest, first.manifest);
    await temporary(async (otherRoot) => {
      await cp(path.join(root, ".nimbus"), path.join(otherRoot, ".nimbus"), {
        recursive: true,
      });
      const relocated = await prepareApiAssetFamily(otherRoot, family(spec()));
      assert.ok(relocated.versions.every(({ prepared }) => prepared.reused));
      assert.ok(
        relocated.versions[0]!.prepared.citationSummaryPath.startsWith(
          otherRoot,
        ),
      );
    });
  }));

test("dependency checks see escaped JSON keys, YAML aliases and token collisions", () => {
  assert.equal(
    externalReferenceReason('{"$ref":"#/components/schemas/Cat"}'),
    undefined,
  );
  assert.match(
    externalReferenceReason(
      '{"\\u0024ref":"https://example.test/spec.json#/Cat"}',
    )!,
    /external reference/,
  );
  assert.match(
    externalReferenceReason('source: &ref { $ref: "./cat.yaml" }\ncopy: *ref')!,
    /external reference/,
  );
  assert.throws(
    () => externalReferenceReason('{"description":"nimbus-\\u0072ef:v1:abc"}'),
    /reserved/,
  );
  assert.throws(
    () =>
      externalReferenceReason(
        '{"properties":{"nimbus-\\u0072ef:v1:YXBp":{"type":"string"}}}',
      ),
    /reserved/,
  );
  assert.throws(
    () =>
      externalReferenceReason(
        'properties:\n  "nimbus-\\u0072ef:v1:YXBp": {type: string}',
      ),
    /reserved/,
  );
});

test("a catalog cannot redirect a record hash into a different valid pack", async () =>
  temporary(async (root) => {
    const writer = new PageAssetWriter(root, 1024);
    const a = await writer.add({ id: "a", text: "a".repeat(600) });
    const b = await writer.add({ id: "b", text: "b".repeat(600) });
    await writer.finishVersion();
    await writer.saveCatalog();
    const catalog = path.join(writer.cacheDirectory, "catalog.json");
    await writeFile(
      catalog,
      JSON.stringify({
        revision: 1,
        records: [[a, { filename: writer.location(b).filename, key: a }]],
      }),
    );
    const next = new PageAssetWriter(root, 1024);
    await next.add({ id: "a", text: "a".repeat(600) });
    await next.finishVersion();
    assert.deepEqual(next.location(a), writer.location(a));
    assert.equal(next.metrics.recordsReused, 0);
  }));

test("successful-build pruning keeps every current family and excludes stale deployment files", async () =>
  temporary(async (root) => {
    const old = await prepareApiAssetFamily(root, family(spec()));
    const other = await prepareApiAssetFamily(root, {
      ...family(spec()),
      collection: "other",
    });
    await prepareApiAssetFamily(root, family(spec("new retained history")));
    await stagePageAssetDeployment(root, path.join(root, "dist/client"));
    const reachable = await apiPageAssetDeploymentFiles(root);
    assert.deepEqual(
      (await readdir(path.join(root, "dist/client/_nimbus/pages"))).sort(),
      reachable,
    );
    await pruneApiPageAssetCache(root);
    await assert.rejects(
      readFile(
        path.join(
          root,
          ".nimbus/cache/page-assets/versions",
          `${old.versions[0]!.prepared.inputHash}.json`,
        ),
      ),
      /ENOENT/,
    );
    assert.ok(await readFile(other.versions[0]!.prepared.citationSummaryPath));
    const again = await prepareApiAssetFamily(root, {
      ...family(spec()),
      collection: "other",
    });
    assert.ok(again.versions.every(({ prepared }) => prepared.reused));
  }));

test("restored version artifacts restore CSS for their highlighted samples", async () =>
  temporary(async (root) => {
    clearCodeStyleRegistry();
    const input = spec();
    Object.assign(input.paths["/cats"].get, {
      "x-codeSamples": [
        { lang: "javascript", source: "const cats = await api.list();" },
      ],
    });
    const first = await prepareApiAssetFamily(root, family(input));
    const before = getCodeStyleCSS();
    assert.match(before, /nb-shiki-/);
    clearCodeStyleRegistry();
    assert.equal(getCodeStyleCSS(), "");
    const second = await prepareApiAssetFamily(root, family(input));
    assert.ok(second.versions.every(({ prepared }) => prepared.reused));
    assert.deepEqual(second.manifest, first.manifest);
    assert.equal(getCodeStyleCSS(), before);
  }));

test("concurrent family rebuilds serialize and observe each caller's changed source", async () =>
  temporary(async (root) => {
    const [first, second] = await Promise.all([
      prepareApiAssetFamily(root, family(spec("first"))),
      prepareApiAssetFamily(root, family(spec("second"))),
    ]);
    assert.notEqual(first.manifest.v2, second.manifest.v2);
    for (const result of [first, second]) {
      const operation = result.versions[0]!.prepared.rows.find((row) =>
        row.id.endsWith("listCats"),
      )!;
      assert.match(
        (await readApiAssetPageForBuild(root, operation)).href,
        /^nimbus-ref:v1:/,
      );
    }
  }));

test("cold history prepares identical projected pages once per writer", async () =>
  temporary(async (root) => {
    const first = spec("before");
    const second = spec("after");
    for (const document of [first, second])
      Object.assign(document.paths, {
        "/dogs": {
          get: {
            operationId: "listDogs",
            description: "unchanged",
            responses: { "200": { description: "Success" } },
          },
        },
      });
    resetApiAssetPreparationMetrics();
    await prepareApiAssetFamily(root, family(first, second));
    const metrics = getApiAssetPreparationMetrics();
    assert.equal(metrics.modelPreparations, 2);
    assert.equal(metrics.pageProjections, 6);
    assert.equal(metrics.pagePreparations, 4);
    assert.equal(metrics.preparedRecordCacheHits, 2);
  }));

test("an archived CI cache restores in a fresh process without preparation or highlighting", async () =>
  temporary(async (root) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const input = spec();
    Object.assign(input.paths["/cats"].get, {
      "x-codeSamples": [
        { lang: "javascript", source: "const cats = await api.list();" },
      ],
    });
    await prepareApiAssetFamily(root, family(input));
    const archive = path.join(root, "ci-cache.tgz");
    await run("tar", [
      "-czf",
      archive,
      "-C",
      root,
      ".nimbus/cache/page-assets",
    ]);
    await temporary(async (restoredRoot) => {
      await run("tar", ["-xzf", archive, "-C", restoredRoot]);
      const buildModule = new URL(
        "../src/_internal/api/page-assets-build.ts",
        import.meta.url,
      ).href;
      const codeModule = new URL(
        "../src/_internal/api-loader.ts",
        import.meta.url,
      ).href;
      const styleModule = new URL(
        "../src/_internal/code-style-registry.ts",
        import.meta.url,
      ).href;
      const source = `import {prepareApiAssetFamily,getApiAssetPreparationMetrics} from ${JSON.stringify(buildModule)};
      import {getApiCodePreparationMetrics} from ${JSON.stringify(codeModule)};
      import {getCodeStyleCSS} from ${JSON.stringify(styleModule)};
      const result = await prepareApiAssetFamily(process.argv[1], ${JSON.stringify(family(input))});
      console.log(JSON.stringify({preparation:getApiAssetPreparationMetrics(),code:getApiCodePreparationMetrics(),css:getCodeStyleCSS(),reused:result.versions.every(({prepared})=>prepared.reused)}));`;
      const output = await run(process.execPath, [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        source,
        restoredRoot,
      ]);
      const report = JSON.parse(output.stdout.trim());
      assert.equal(report.reused, true);
      assert.equal(report.preparation.modelPreparations, 0);
      assert.equal(report.preparation.pagePreparations, 0);
      assert.equal(report.code.highlightCalls, 0);
      assert.match(report.css, /nb-shiki-/);
    });
  }));

test("one build prepares an externally referenced version once; dev prepares it again", async () =>
  temporary(async (root) => {
    await writeFile(
      path.join(root, "schemas.json"),
      JSON.stringify({
        Cat: { type: "object", properties: { name: { type: "string" } } },
      }),
    );
    await writeFile(
      path.join(root, "openapi.json"),
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Example", version: "1" },
        paths: {
          "/cats": {
            get: {
              operationId: "listCats",
              responses: {
                "200": {
                  description: "Success",
                  content: {
                    "application/json": {
                      schema: { $ref: "./schemas.json#/Cat" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    const entry: ApiSpec = {
      collection: "api",
      spec: "./openapi.json",
      samples: { generate: [] },
    };
    for (const building of [true, false]) {
      clearApiPageAssetManifest(root);
      configurePageAssetCollections(root, ["api"], building);
      resetApiAssetPreparationMetrics();
      await prepareApiAssetFamily(root, entry);
      await prepareApiAssetFamily(root, entry);
      assert.equal(
        getApiAssetPreparationMetrics().modelPreparations,
        building ? 1 : 2,
      );
    }
  }));

test("an unrelated dependency bump keeps every prepared version reusable", async () =>
  temporary(async (root) => {
    const before = await apiPreparationEnvironment(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
    );
    await writeFile(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    assert.equal(await apiPreparationEnvironment(root), before);
  }));

test("the preparation key covers every output-shaping package and its dependencies", async () => {
  const packages = await preparationPackages();
  for (const name of [
    "@scalar/json-magic",
    "hast-util-sanitize",
    "satteri",
    "shiki",
  ]) {
    assert.ok(
      packages.some(
        (entry) =>
          /@\d/.test(entry) &&
          entry.startsWith(`${name}@`) &&
          !entry.endsWith("@absent"),
      ),
      name,
    );
  }
  // A fix in a sanitiser dependency must invalidate prepared HTML too.
  assert.ok(packages.some((entry) => entry.startsWith("unist-util-position@")));
});

test("an unreadable package layout reuses nothing, unlike an absent optional tool", async () => {
  const packages = await preparationPackages();
  assert.ok(
    !packages.some((entry) => entry.includes("@unknown:")),
    "this repository's layout is readable",
  );
  assert.deepEqual(
    await preparationPackages(),
    packages,
    "stable within a process",
  );
});

test("an unchanged version reuses its index; a new link policy rebuilds it", async () =>
  temporary(async (root) => {
    const indexFile = (manifest: Record<string, string>) =>
      path.join(root, ".nimbus/cache/page-assets/assets", manifest.v2!);
    const first = await prepareApiAssetFamily(root, family(spec()));
    const written = (await stat(indexFile(first.manifest))).mtimeMs;
    const again = await prepareApiAssetFamily(root, family(spec()));
    assert.deepEqual(again.manifest, first.manifest);
    assert.equal((await stat(indexFile(again.manifest))).mtimeMs, written);
    try {
      setLinkPolicy({ trailingSlash: "never", format: "directory" });
      const never = await prepareApiAssetFamily(root, family(spec()));
      assert.notEqual(never.manifest.v2, first.manifest.v2);
      const index = await readFile(indexFile(never.manifest), "utf8");
      assert.ok(
        !/"href":"[^"?]+\/(?:\?|")/.test(index),
        "links follow the new policy",
      );
    } finally {
      setLinkPolicy({ trailingSlash: "ignore", format: "directory" });
    }
  }));
