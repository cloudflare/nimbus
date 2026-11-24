// docsCollection({ markdownFields }): named schema fields reach each page's
// .md and .mdx frontmatter, baked at build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import ts from "typescript";

import {
  beginPreparedMarkdownLoad,
  beginPreparedMarkdownSession,
  clearPreparedMarkdownRegistry,
  commitPreparedMarkdownCollection,
  getPreparedMarkdownRevision,
  preparedMarkdownRootKey,
} from "../src/_internal/prepared-markdown-registry.ts";
import {
  AGENT_ENDPOINT_ASSET_GENERATION,
  bakeAgentEndpointAssets,
  configureAgentEndpointAssetRoot,
  readMarkdownEndpointPayload,
} from "../src/_internal/agent-endpoint-assets.ts";
import { docsCollection } from "../src/content.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const capability = { generation: AGENT_ENDPOINT_ASSET_GENERATION, base: "/" };

afterEach(async () => {
  clearPreparedMarkdownRegistry();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function project(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "nimbus-markdown-fields-"));
  roots.push(value);
  beginPreparedMarkdownSession(value);
  return value;
}

function commit(
  root: string,
  entries: Array<{ id: string; data: Record<string, unknown> }>,
  markdownFields?: string[],
): void {
  const key = preparedMarkdownRootKey(root);
  const epoch = beginPreparedMarkdownLoad(key, "changelog", false);
  assert.equal(
    commitPreparedMarkdownCollection(
      key,
      "changelog",
      epoch,
      capability,
      entries.map((entry) => ({
        id: entry.id,
        body: "Notes.",
        filePath: `src/content/changelog/${entry.id}.md`,
        data: entry.data,
      })) as never,
      new Map(entries.map((entry) => [entry.id, []])),
      "page",
      { markdownFields },
    ),
    true,
  );
}

async function bake(root: string) {
  const options = {
    root,
    base: "/",
    site: "https://example.test",
    title: "Test",
    collectionUrls: { changelog: "/changelog" },
  };
  configureAgentEndpointAssetRoot(root, "build", () => bakeAgentEndpointAssets(options));
  await bakeAgentEndpointAssets(options);
  const read = (surface: "markdown" | "source") =>
    readMarkdownEndpointPayload(root, { collection: "changelog", id: "batch", surface }).then(
      (payload) => payload.body.slice(0, payload.body.indexOf("\n---\n") + 4),
    );
  return { markdown: await read("markdown"), source: await read("source") };
}

const release = {
  title: "Batch forecasts",
  description: "Up to 50 locations.",
  version: "2.4.0",
  date: new Date("2026-07-02"),
  tags: ["api", "forecasts"],
};

test("named fields follow Nimbus's keys, in list order, in .md and .mdx alike", async () => {
  const root = await project();
  commit(root, [{ id: "batch", data: release }], ["tags", "date"]);
  const { markdown, source } = await bake(root);
  assert.equal(
    markdown,
    [
      "---",
      'title: "Batch forecasts"',
      'description: "Up to 50 locations."',
      'version: "2.4.0"',
      'tags: ["api", "forecasts"]',
      'date: "2026-07-02"',
      "---",
    ].join("\n"),
  );
  assert.equal(source, markdown);
});

test("values: instants, empty arrays, scalars and escaping; missing values left out", async () => {
  const root = await project();
  commit(
    root,
    [
      {
        id: "batch",
        data: {
          title: "Batch",
          date: new Date("2026-07-02T09:30:00+02:00"),
          tags: [],
          note: 'Quote " and\nnewline, 東京',
          count: 3,
          beta: false,
          owner: undefined,
          reviewer: null,
        },
      },
    ],
    ["date", "tags", "note", "count", "beta", "owner", "reviewer"],
  );
  const { markdown } = await bake(root);
  assert.equal(
    markdown,
    [
      "---",
      'title: "Batch"',
      'date: "2026-07-02T07:30:00.000Z"',
      "tags: []",
      'note: "Quote \\" and\\nnewline, 東京"',
      "count: 3",
      "beta: false",
      "---",
    ].join("\n"),
  );
});

test("a value that isn't a scalar, date or array of those fails the build naming it", async () => {
  const root = await project();
  commit(root, [{ id: "batch", data: { title: "Batch", author: { name: "Ada" } } }], ["author"]);
  await assert.rejects(bake(root), /"changelog:batch" can't write markdownFields "author"/);
});

test("a collection without markdownFields writes only Nimbus's keys", async () => {
  const root = await project();
  commit(root, [{ id: "batch", data: release }]);
  const { markdown } = await bake(root);
  assert.equal(
    markdown,
    ['---', 'title: "Batch forecasts"', 'description: "Up to 50 locations."', 'version: "2.4.0"', "---"].join("\n"),
  );
});

test("adding, reordering and removing markdownFields each move the registry revision", async () => {
  const root = await project();
  const key = preparedMarkdownRootKey(root);
  const entries = [{ id: "batch", data: release }];
  const revisions: number[] = [];
  for (const fields of [undefined, undefined, ["date"], ["date", "tags"], ["tags", "date"], undefined]) {
    commit(root, entries, fields);
    revisions.push(getPreparedMarkdownRevision(key)!);
  }
  const [first, unchanged, added, extended, reordered, removed] = revisions;
  assert.equal(unchanged, first);
  assert.ok(added! > unchanged!);
  assert.ok(extended! > added!);
  assert.ok(reordered! > extended!);
  assert.ok(removed! > reordered!);
});

test("Nimbus's keys and fields outside schemaFields can't be named", async () => {
  const { z } = await import("astro/zod");
  for (const field of ["title", "description", "image", "version"]) {
    assert.throws(
      () => docsCollection({ schemaFields: { version: z.string() }, markdownFields: [field as never] }),
      new RegExp(`names "${field}", which Nimbus already writes`),
    );
  }
  assert.throws(
    () => docsCollection({ schemaFields: { date: z.date() }, markdownFields: ["tags" as never] }),
    /names "tags", which isn't in schemaFields/,
  );
  assert.throws(
    () => docsCollection({ schemaFields: { "release: channel": z.string() }, markdownFields: ["release: channel"] }),
    /can't be a frontmatter key/,
  );
  assert.throws(
    () => docsCollection({ schemaFields: { date: z.date() }, markdownFields: ["date", "date"] }),
    /names "date" twice/,
  );
  // Declaring Nimbus's keys in schemaFields stays valid, with or without the option.
  docsCollection({ schemaFields: { version: z.string() } });
  docsCollection({ schemaFields: { version: z.string(), date: z.date() }, markdownFields: ["date"] });
});

test("markdownFields only type-checks with schemaFields keys", async () => {
  const dir = await mkdtemp(path.join(here, ".markdown-fields-types-"));
  roots.push(dir);
  const file = path.join(dir, "check.ts");
  await writeFile(
    file,
    [
      `import { z } from "astro/zod";`,
      `import { docsCollection } from ${JSON.stringify(path.join(here, "../src/content.ts"))};`,
      `docsCollection({ schemaFields: { date: z.date() }, markdownFields: ["date"] });`,
      `// @ts-expect-error not a schemaFields key`,
      `docsCollection({ schemaFields: { date: z.date() }, markdownFields: ["tags"] });`,
      `// @ts-expect-error no schemaFields at all`,
      `docsCollection({ markdownFields: ["date"] });`,
    ].join("\n"),
  );
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(here, "../tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )!;
  const program = ts.createProgram([file], { ...config.options, noEmit: true, allowImportingTsExtensions: true });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === file)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  assert.deepEqual(diagnostics, []);
});

test("date-only and offset dates write the same whatever the build's timezone", () => {
  const script = `
    import { z } from "astro/zod";
    const date = z.coerce.date();
    console.log(JSON.stringify([
      date.parse("2026-07-02").toISOString(),
      date.parse("2026-07-02T09:30:00+02:00").toISOString(),
      date.parse("2026-07-02T09:30:00").toISOString(),
    ]));
  `;
  const run = (TZ: string) =>
    JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: here,
        env: { ...process.env, TZ },
        encoding: "utf8",
      }),
    ) as string[];
  const utc = run("UTC");
  const la = run("America/Los_Angeles");
  assert.deepEqual(utc.slice(0, 2), ["2026-07-02T00:00:00.000Z", "2026-07-02T07:30:00.000Z"]);
  assert.deepEqual(la.slice(0, 2), utc.slice(0, 2));
  // An offsetless datetime is read in the build machine's timezone, as the docs say.
  assert.notEqual(la[2], utc[2]);
});
