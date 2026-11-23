// `nimbus(config, { api: { <collection>: { transform } } })`: a spec read from
// a URL source and transformed at build time, the authored spec (never the
// last output) as every run's input, version families, preview reading the
// last build's record, and the misconfigurations that fail.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { build } from "astro";

import {
  applySpecTransforms,
  collectSpecTransforms,
  holdBuildSpecLeases,
  invalidateBuiltSpecTransforms,
  recordBuiltSpecTransforms,
  releaseDevSpecLeases,
  restoreBuiltSpecTransforms,
  serveDevSpecLeases,
  stageDevSpecLeases,
  SPEC_TRANSFORMS_DIR,
} from "../src/_internal/api/spec-transform.ts";
import { releaseLeaseFiles } from "../src/_internal/content-sources.ts";
import type { ApiSpec, ApiSpecTransform } from "../src/types.ts";
import { paritySite, src } from "./fixtures/parity-site.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Widgets API", version: "1.0.0" },
  tags: [{ name: "widgets" }],
  paths: {
    "/widgets": {
      get: { operationId: "listWidgets", summary: "List widgets", tags: ["widgets"], responses: { "200": { description: "OK" } } },
    },
  },
};

/** Renames the operation, and fails if it is handed its own output. */
const rename: ApiSpecTransform = (document) => {
  const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
  const operation = paths["/widgets"]!["get"]!;
  if (operation["x-transformed"]) throw new Error("got a transformed spec as input");
  return { ...document, paths: { "/widgets": { get: { ...operation, summary: "Every widget", "x-transformed": true } } } };
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("a spec from a URL source is transformed at build time, from the source on every build", async () => {
  let served = 0;
  const server = createServer((_req, res) => {
    served += 1;
    res.writeHead(200, { "content-type": "application/json", etag: '"v1"' }).end(JSON.stringify(SPEC));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}/openapi.json`;
  const site = await paritySite({
    extraCollections: ["widgets: defineCollection(apiCollection())"],
    routes: {
      "src/pages/widgets/[...slug].astro": [
        "---",
        `import { getApiStaticPaths } from ${src("runtime.ts")};`,
        "export const prerender = true;",
        'export const getStaticPaths = getApiStaticPaths("widgets");',
        "const { page } = Astro.props;",
        "---",
        "<html><body><h1>{page?.operation?.summary ?? page?.kind}</h1></body></html>",
      ].join("\n"),
    },
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const calls: unknown[] = [];
    const transform: ApiSpecTransform = (document, context) => {
      calls.push(context);
      return rename(document, context);
    };
    const config = () =>
      site.configure({
        sources: { widgets: { url } },
        nimbus: {
          api: [
            { collection: "api", spec: path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml"), label: "SmallCo API" },
            { collection: "widgets", spec: { source: "widgets" } },
          ],
        },
        integration: { api: { widgets: { transform } } },
      });
    await build(config());
    assert.deepEqual(calls, [{ collection: "widgets", version: null }]);
    const outputs = readdirSync(path.join(site.root, SPEC_TRANSFORMS_DIR, "widgets")).filter((name) => name.endsWith(".json"));
    assert.equal(outputs.length, 1);
    const output = JSON.parse(readFileSync(path.join(site.root, SPEC_TRANSFORMS_DIR, "widgets", outputs[0]!), "utf8"));
    assert.equal(output.paths["/widgets"].get.summary, "Every widget");
    const built = JSON.parse(readFileSync(path.join(site.root, SPEC_TRANSFORMS_DIR, "built.json"), "utf8"));
    assert.deepEqual(built, { version: 1, specs: { widgets: `${SPEC_TRANSFORMS_DIR}/widgets/${outputs[0]}` } });
    const pages = filesUnder(path.join(site.root, "dist/widgets")).map((file) => readFileSync(file, "utf8")).join("\n");
    assert.match(pages, /Every widget/);
    assert.doesNotMatch(pages, /List widgets/);

    // The second build transforms the source's file again, not the output
    // the first build pointed the spec at; the transform would throw.
    await build(config());
    assert.equal(calls.length, 2);
    assert.equal(served, 2, "the second build revalidates the source once");
    assert.deepEqual(readdirSync(path.join(site.root, SPEC_TRANSFORMS_DIR, "widgets")).filter((name) => name.endsWith(".json")), outputs);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await site.remove();
  }
});

test("each version of a family is transformed with its version id, from its file as authored", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-spec-transform-"));
  try {
    writeFileSync(path.join(root, "v1.json"), JSON.stringify(SPEC));
    writeFileSync(path.join(root, "v2.yaml"), "openapi: 3.1.0\ninfo:\n  title: Widgets API\n  version: '2'\npaths:\n  /widgets:\n    get:\n      operationId: listWidgets\n      summary: List widgets\n      responses:\n        '200':\n          description: OK\n");
    const api = [
      { collection: "widgets", versions: [{ version: "v1", spec: "v1.json" }, { version: "v2", spec: "v2.yaml" }] },
      { collection: "other", spec: { ...SPEC } },
    ] as ApiSpec[];
    const seen: string[] = [];
    const targets = collectSpecTransforms(api, {
      widgets: { transform: (document, { version }) => (seen.push(`${version}:${(document["info"] as { version: string }).version}`), rename(document, { collection: "widgets", version })) },
      other: { transform: (document) => ({ ...document, info: { title: "Other", version: "1" } }) },
    });
    let leases = new Set<string>();
    for (let run = 0; run < 2; run++) leases = await applySpecTransforms(targets, root);
    assert.deepEqual(seen, ["v1:1.0.0", "v2:2", "v1:1.0.0", "v2:2"]);
    const [v1, v2] = (api[0]!.versions ?? []).map((version) => version.spec as string);
    assert.match(v1!, new RegExp(`^${SPEC_TRANSFORMS_DIR}/widgets/[0-9a-f]{64}\\.json$`));
    assert.notEqual(v1, v2);
    assert.match(api[1]!.spec as string, new RegExp(`^${SPEC_TRANSFORMS_DIR}/other/`));
    assert.equal(JSON.parse(readFileSync(path.join(root, api[1]!.spec as string), "utf8")).info.title, "Other");

    // Preview reads what the last build recorded; a later run doesn't move it.
    await recordBuiltSpecTransforms(targets, root, leases);
    const recorded = targets.map((target) => target.holder.spec);
    writeFileSync(path.join(root, "v1.json"), JSON.stringify({ ...SPEC, info: { title: "Widgets API", version: "1.1.0" } }));
    await applySpecTransforms(targets, root);
    assert.notEqual(targets[0]!.holder.spec, recorded[0]);
    // The recorded output survives the run's cleanup.
    assert.ok(existsSync(path.join(root, recorded[0] as string)));
    await restoreBuiltSpecTransforms(targets, root);
    assert.deepEqual(targets.map((target) => target.holder.spec), recorded);

    // A build that starts removes the record, so one that fails leaves none.
    invalidateBuiltSpecTransforms(root);
    await assert.rejects(restoreBuiltSpecTransforms(targets, root), /has a transform, and no build recorded its result; run astro build first/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transform for no api entry, a non-function, and a result that isn't an object fail", async () => {
  const api = [{ collection: "widgets", spec: { ...SPEC } }] as ApiSpec[];
  assert.throws(
    () => collectSpecTransforms(api, { widget: { transform: rename } }),
    /names "widget", which no api entry in the Nimbus config declares \(declared: "widgets"\)/,
  );
  assert.throws(() => collectSpecTransforms(api, { widgets: { transform: "x" as never } }), /api\.widgets\.transform must be a function/);
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-spec-transform-bad-"));
  try {
    const bad = collectSpecTransforms(api, { widgets: { transform: () => [] as never } });
    await assert.rejects(applySpecTransforms(bad, root), /the transform of api collection "widgets" must return the spec as an object/);
    const throwing = collectSpecTransforms(api, { widgets: { transform: () => { throw new Error("boom"); } } });
    await assert.rejects(applySpecTransforms(throwing, root), /the transform of api collection "widgets" failed: boom/);

    // When a later version fails, the leases the run already took are released.
    const family = [{ collection: "family", versions: [{ version: "v1", spec: { ...SPEC } }, { version: "v2", spec: { ...SPEC } }] }] as ApiSpec[];
    const halfway = collectSpecTransforms(family, {
      family: { transform: (document, { version }) => { if (version === "v2") throw new Error("v2 broke"); return document; } },
    });
    await assert.rejects(applySpecTransforms(halfway, root), /version "v2" failed: v2 broke/);
    const leaseDirs = readdirSync(path.join(root, SPEC_TRANSFORMS_DIR, "family")).filter((name) => name.endsWith(".leases"));
    assert.deepEqual(leaseDirs.flatMap((name) => readdirSync(path.join(root, SPEC_TRANSFORMS_DIR, "family", name))), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup removes an output only once nothing that reads it holds a lease, and no build recorded it", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-spec-transform-prune-"));
  try {
    const api = [{ collection: "widgets", spec: { ...SPEC } }] as ApiSpec[];
    const dir = path.join(root, SPEC_TRANSFORMS_DIR, "widgets");
    const outputs = () => readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    const run = async (title: string) => {
      const targets = collectSpecTransforms(api, { widgets: { transform: (document) => ({ ...document, info: { title, version: "1" } }) } });
      return { targets, leases: await applySpecTransforms(targets, root) };
    };

    // A dev server serves A.
    stageDevSpecLeases(root, (await run("A")).leases);
    serveDevSpecLeases(root);
    const [a] = outputs();
    // A restart's setup makes B, then fails before its server is made: the
    // running server keeps A.
    stageDevSpecLeases(root, (await run("B")).leases);
    // A build in the same process makes C and records it; it releases only its own lease.
    const build = await run("C");
    await recordBuiltSpecTransforms(build.targets, root, build.leases);
    await run("C");
    assert.ok(outputs().includes(a!), "the dev server's A survives the build");
    // The next restart's setup makes D and its server is made: A and B go.
    stageDevSpecLeases(root, (await run("D")).leases);
    serveDevSpecLeases(root);
    const after = await run("D");
    assert.equal(outputs().length, 2, "the recorded C, and D, which the server reads");
    assert.ok(!outputs().includes(a!));

    // The server stops: D is released and goes on the next run; C stays recorded.
    releaseDevSpecLeases(root);
    releaseLeaseFiles(root, "api-specs", after.leases);
    const last = await run("E");
    assert.equal(outputs().length, 2, "C, and E, which this run leases");

    // A programmatic build that fails after its transforms, or a sync, never
    // records; the next run in the process releases what it left.
    const failed = await run("F");
    holdBuildSpecLeases(root, failed.leases);
    const next = await run("G");
    holdBuildSpecLeases(root, next.leases);
    await recordBuiltSpecTransforms(next.targets, root, next.leases);
    await run("G");
    assert.ok(!outputs().some((name) => readFileSync(path.join(dir, name), "utf8").includes('"title":"F"')), "F is gone");

    // Writes a crash abandoned are removed by the next run.
    writeFileSync(path.join(dir, `${"0".repeat(64)}.json.tmp-abc123`), "{");
    writeFileSync(path.join(root, SPEC_TRANSFORMS_DIR, "built.json.tmp-abc123"), "{");
    await run("E");
    assert.ok(!readdirSync(dir).some((name) => name.includes(".tmp-")));
    assert.ok(!readdirSync(path.join(root, SPEC_TRANSFORMS_DIR)).some((name) => name.includes(".tmp-")));
    await recordBuiltSpecTransforms(last.targets, root, last.leases);
  } finally {
    releaseDevSpecLeases(root);
    rmSync(root, { recursive: true, force: true });
  }
});
