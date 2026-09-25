// `nimbus-docs check` pairs `api` entries in the inline Nimbus config with
// `apiCollection()` keys in src/content.config.ts, statically, the same way the
// build and the loader do. Also guards that the recipe's inline shape stays
// statically readable (no config-not-evaluated note, placeholder site caught).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { formatCheckJson } from "../../src/check/format.js";
import { runChecks } from "../../src/check/run.js";
import { parseApiCollections } from "../../src/check/parse-api-collections.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The starter's `astro.config.ts` shape, with `api` in the inline config. */
function site(options: {
  api?: string;
  contentConfig?: string;
  site?: string;
  nimbusConfig?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-check-api-"));
  dirs.push(dir);
  const nimbusConfig =
    options.nimbusConfig ??
    `defineNimbusConfig({
  site: ${JSON.stringify(options.site ?? "https://docs.acme.test")},
  title: "Acme",
  search: false,${options.api ? `\n  api: ${options.api},` : ""}
})`;
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import { defineConfig } from "astro/config";
import nimbus, {
  defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";

const nimbusConfig = ${nimbusConfig};

export default defineConfig({
  output: "static",
  integrations: [nimbus(nimbusConfig)],
});
`,
  );
  if (options.contentConfig !== undefined) {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "content.config.ts"), options.contentConfig);
  }
  return dir;
}

const contentConfig = (collections: string, preamble = "") => `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from "@cloudflare/nimbus-docs/content";
${preamble}
export const collections = {
  docs: defineCollection(docsCollection()),
${collections}
};
`;

const STRUCTURE = { env: false, structure: true, authoring: false, types: false } as const;
const ENV_STRUCTURE = { env: true, structure: true, authoring: false, types: false } as const;

type Json = {
  findings: { code: string; severity: string; file?: string; line?: number; message: string }[];
  scopes: { scope: string; notes: { code: string }[] }[];
};
const check = async (dir: string, scopes = STRUCTURE) =>
  JSON.parse(formatCheckJson(await runChecks(dir, scopes))) as Json;
const apiFindings = (json: Json) =>
  json.findings.filter((finding) => finding.code.startsWith("nimbus/api-collection-"));

test("matching api entries and zero-argument apiCollection() keys pass", async () => {
  const dir = site({
    api: `[
    { collection: "api", spec: "./src/api/a.yaml" },
    { collection: "billing-api", spec: "./src/api/b.yaml" },
  ]`,
    contentConfig: contentConfig(`  api: defineCollection(apiCollection()),
  "billing-api": defineCollection(apiCollection( )),`),
  });
  assert.deepEqual(apiFindings(await check(dir)), []);
});

test("an api entry with no collection key is an error pointing at src/content.config.ts", async () => {
  const dir = site({
    api: `[
    { collection: "api", spec: "./src/api/a.yaml" },
    { collection: "billing", spec: "./src/api/b.yaml" },
  ]`,
    contentConfig: contentConfig(`  api: defineCollection(apiCollection()),`),
  });
  const findings = apiFindings(await check(dir));
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding!.code, "nimbus/api-collection-missing");
  assert.equal(finding!.severity, "error");
  assert.match(finding!.file!, /astro\.config\.ts$/);
  assert.equal(finding!.line, 10, "points at the `api` field");
  assert.match(finding!.message, /"billing"/);
  assert.match(finding!.message, /the Nimbus config \(astro\.config\.\*\)/);
  assert.match(finding!.message, /src\/content\.config\.ts/);
  assert.match(finding!.message, /billing: defineCollection\(apiCollection\(\)\)/);
});

test("a zero-argument apiCollection() key with no api entry is an error naming both files", async () => {
  const dir = site({
    api: `[{ collection: "api", spec: "./src/api/a.yaml" }]`,
    contentConfig: contentConfig(`  api: defineCollection(apiCollection()),
  payments: defineCollection(apiCollection()),`),
  });
  const findings = apiFindings(await check(dir));
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding!.code, "nimbus/api-collection-unconfigured");
  assert.equal(finding!.severity, "error");
  assert.match(finding!.file!, /src\/content\.config\.ts$/);
  assert.equal(finding!.line, 7, "points at the collection key");
  assert.match(finding!.message, /"payments"/);
  assert.match(finding!.message, /Configured api collections: "api"/);
  assert.match(finding!.message, /the Nimbus config \(astro\.config\.\*\)/);
  assert.match(finding!.message, /src\/content\.config\.ts/);
});

test("a zero-argument key with no api config at all reports none configured", async () => {
  const dir = site({
    contentConfig: contentConfig(`  api: defineCollection(apiCollection()),`),
  });
  const findings = apiFindings(await check(dir));
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["nimbus/api-collection-unconfigured"],
  );
  assert.match(findings[0]!.message, /Configured api collections: none/);
});

test("explicit apiCollection(options) is not paired with the api config", async () => {
  // Today's nimbus.config.ts shape: the entry is passed in, and the key
  // happens to match an `api` entry the integration also reads.
  const dir = site({
    api: `[{ collection: "api", spec: "./src/api/a.yaml" }]`,
    contentConfig: contentConfig(
      `  api: defineCollection(apiCollection(apiConfig)),
  legacy: defineCollection(apiCollection({ collection: "legacy", spec: "./legacy.yaml" })),`,
      `const apiConfig = { collection: "api", spec: "./src/api/a.yaml" };\n`,
    ),
  });
  assert.deepEqual(apiFindings(await check(dir)), []);
});

test("shorthand and aliased registrations resolve through local declarations", async () => {
  const dir = site({
    api: `[{ collection: "api", spec: "./src/api/a.yaml" }]`,
    contentConfig: contentConfig(
      `  api,
  orphan: orphanApi,`,
      `const api = defineCollection(apiCollection());
const orphanApi = defineCollection(apiCollection());
`,
    ),
  });
  const findings = apiFindings(await check(dir));
  assert.deepEqual(
    findings.map((finding) => [finding.code, finding.message.match(/"(\w+)"/)?.[1]]),
    [["nimbus/api-collection-unconfigured", "orphan"]],
  );
});

test("opaque registrations only suppress the missing-key direction", async () => {
  const dir = site({
    api: `[{ collection: "api", spec: "./src/api/a.yaml" }]`,
    contentConfig: contentConfig(
      `  ...shared,
  extra: defineCollection(apiCollection()),`,
      `import { shared } from "./shared";\n`,
    ),
  });
  // `api` may come from the spread; `extra` definitely has no entry.
  assert.deepEqual(
    apiFindings(await check(dir)).map((finding) => finding.code),
    ["nimbus/api-collection-unconfigured"],
  );
});

test("a computed api field or config spread skips the cross-check", async () => {
  for (const nimbusConfig of [
    `defineNimbusConfig({ site: "https://docs.acme.test", title: "Acme", search: false, api: loadApis() })`,
    `defineNimbusConfig({ ...base, site: "https://docs.acme.test", title: "Acme", search: false })`,
  ]) {
    const dir = site({
      nimbusConfig,
      contentConfig: contentConfig(`  payments: defineCollection(apiCollection()),`),
    });
    assert.deepEqual(apiFindings(await check(dir)), [], nimbusConfig);
  }
});

test("a missing src/content.config.ts skips the cross-check", async () => {
  const dir = site({ api: `[{ collection: "api", spec: "./src/api/a.yaml" }]` });
  assert.deepEqual(apiFindings(await check(dir)), []);
});

test("the inline recipe shape is statically evaluated and still reports a placeholder site", async () => {
  const dir = site({
    site: "https://example.com",
    api: `[{ collection: "api", spec: "./src/api/openapi.yaml", label: "Example API" }]`,
    contentConfig: contentConfig(`  api: defineCollection(apiCollection()),`),
  });
  const json = await check(dir, ENV_STRUCTURE);
  const notes = json.scopes.flatMap((scope) => scope.notes.map((note) => note.code));
  assert.ok(!notes.includes("nimbus/config-not-evaluated"), `notes: ${notes.join(", ")}`);
  assert.ok(!notes.includes("nimbus/config-unresolved"), `notes: ${notes.join(", ")}`);
  assert.ok(
    json.findings.some((finding) => finding.code === "nimbus/site-placeholder"),
    "the placeholder site is still a finding",
  );
  assert.deepEqual(apiFindings(json), []);
});

test("an api entry whose key uses another loader is an error", async () => {
  for (const collection of [
    `  api: defineCollection(docsCollection({ base: "billing" })),`,
    `  api: defineCollection({ loader: glob({ pattern: "**/*.md", base: "./api" }) }),`,
  ]) {
    const dir = site({
      api: `[{ collection: "api", spec: "./src/api/a.yaml" }]`,
      contentConfig: contentConfig(collection, `import { glob } from "astro/loaders";\n`),
    });
    const findings = apiFindings(await check(dir));
    assert.deepEqual(
      findings.map((finding) => finding.code),
      ["nimbus/api-collection-missing"],
      collection,
    );
    assert.match(
      findings[0]!.message,
      /declares the API collection "api".*src\/content\.config\.ts registers api with a loader other than apiCollection\(\)/,
    );
  }
});

test("apiCollection is recognized only through its import from the content module", async () => {
  const cases: Array<{ name: string; config: string; codes: string[] }> = [
    {
      name: "aliased import",
      config: `import { defineCollection } from "astro:content";
import { apiCollection as makeApi, docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(makeApi()),
  orphan: defineCollection(makeApi()),
};`,
      codes: ["nimbus/api-collection-unconfigured"],
    },
    {
      name: "namespace import",
      config: `import { defineCollection } from "astro:content";
import * as nimbus from "@cloudflare/nimbus-docs/content";
export const collections = {
  docs: defineCollection(nimbus.docsCollection()),
  api: defineCollection(nimbus.apiCollection()),
};`,
      codes: [],
    },
    {
      name: "a string mentioning apiCollection() is not a call",
      config: `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = {
  api: defineCollection(apiCollection()),
  notes: defineCollection(docsCollection({ base: "apiCollection()" })),
  label: defineCollection(docsCollection({ description: "uses apiCollection() for api" })),
};`,
      codes: [],
    },
    {
      name: "an unrelated local function named apiCollection is not trusted",
      config: `import { defineCollection } from "astro:content";
import { docsCollection } from "@cloudflare/nimbus-docs/content";
function apiCollection() { return docsCollection(); }
export const collections = {
  api: defineCollection(apiCollection()),
  orphan: defineCollection(apiCollection()),
};`,
      codes: [],
    },
  ];
  for (const { name, config, codes } of cases) {
    const dir = site({
      api: `[{ collection: "api", spec: "./src/api/a.yaml" }]`,
      contentConfig: config,
    });
    assert.deepEqual(
      apiFindings(await check(dir)).map((finding) => finding.code),
      codes,
      name,
    );
  }
});

test("values the reader can't follow are never reported", async () => {
  const dir = site({
    api: `[
    { collection: "api", spec: "./src/api/a.yaml" },
    { collection: "billing", spec: "./src/api/b.yaml" },
    { collection: "partner", spec: "./src/api/c.yaml" },
  ]`,
    contentConfig: contentConfig(
      `  api: sharedApi,
  billing: defineCollection(makeApi()),
  partner: defineCollection(wrap(() => docsCollection())),`,
      `import { sharedApi } from "./shared";
const makeApi = () => apiCollection();
const wrap = (make: () => unknown) => make();
`,
    ),
  });
  assert.deepEqual(apiFindings(await check(dir)), []);
});

test("parseApiCollections classifies each collection key", async () => {
  const dir = site({
    contentConfig: contentConfig(
      `  api: defineCollection(apiCollection(/* from config */)),
  "v-api": defineCollection(apiCollection(
  )),
  explicit: defineCollection(apiCollection({ collection: "explicit", spec: "./x.yaml" })),
  // commented: defineCollection(apiCollection()),
  shorthand,
  aliased: aliasedApi,
  handWritten: defineCollection({ loader: glob({ pattern: "*.md" }) }),
  imported,
  spreadConfig: defineCollection({ ...shared }),
  ...rest,`,
      `import { glob } from "astro/loaders";
import { imported, shared, rest } from "./shared";
const shorthand = defineCollection(apiCollection());
const aliasedApi = defineCollection(apiCollection());
`,
    ),
  });
  const parsed = await parseApiCollections(path.join(dir, "src", "content.config.ts"));
  assert.deepEqual(
    parsed?.registrations.map(({ key, kind }) => [key, kind]),
    [
      ["docs", "other"],
      ["api", "config"],
      ["v-api", "config"],
      ["explicit", "explicit"],
      ["shorthand", "config"],
      ["aliased", "config"],
      ["handWritten", "other"],
      ["imported", "unknown"],
      ["spreadConfig", "unknown"],
    ],
  );
  assert.equal(await parseApiCollections(path.join(dir, "src", "missing.ts")), null);
});
