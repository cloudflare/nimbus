import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { formatCheckJson } from "../../src/check/format.js";
import { runChecks } from "../../src/check/run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ENV_STRUCT = { env: true, structure: true, authoring: false, types: false } as const;

function site(options: {
  api?: string;
  registration: string;
  collections: string[];
  routes: string[];
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-check-computed-api-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";
export default { adapter: cloudflare(), integrations: [nimbus({
  site: "https://docs.example.com", title: "X", search: false,
  rendering: { default: "request" },
  api: ${options.api ?? "[await loadApi()]"},
})] };
`,
  );
  fs.mkdirSync(path.join(dir, "src", "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "pages", "[...slug].astro"), "");
  for (const route of options.routes) {
    fs.mkdirSync(path.join(dir, "src", "pages", route), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "pages", route, "[...slug].astro"), "");
  }
  fs.writeFileSync(
    path.join(dir, "src", "content.config.ts"),
    `import { apiCollection, docsCollection } from "@cloudflare/nimbus-docs/content";
export const collections = { docs: docsCollection(), ${options.registration} };
`,
  );
  fs.mkdirSync(path.join(dir, ".nimbus"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".nimbus", "page-collections.json"),
    JSON.stringify({ version: 1, collections: options.collections, mdxFiles: [] }),
  );
  return dir;
}

async function check(dir: string) {
  return JSON.parse(formatCheckJson(await runChecks(dir, ENV_STRUCT))) as {
    scopes: { scope: string; notes: { code: string; reason: string }[] }[];
    findings: { code: string; message: string }[];
  };
}

const uncovered = (result: Awaited<ReturnType<typeof check>>) =>
  result.findings.filter((finding) => finding.code === "nimbus/rendering-policy-invalid");
const notes = (result: Awaited<ReturnType<typeof check>>) =>
  result.scopes.find((scope) => scope.scope === "structure")!.notes;

test("a zero-argument apiCollection() under a computed api is covered, with a note", async () => {
  const result = await check(
    site({ registration: "api: apiCollection()", collections: ["docs", "api"], routes: ["api"] }),
  );
  assert.deepEqual(uncovered(result), []);
  const assumed = notes(result).find((note) => note.code === "nimbus/api-collections-assumed");
  assert.match(assumed?.reason ?? "", /taken as API collections: "api"\. A build enforces them\./);
  assert.ok(notes(result).some((note) => note.code === "nimbus/api-collections-skipped"));
});

test("a collection that is neither API nor covered is still an error", async () => {
  const result = await check(
    site({
      registration: "api: apiCollection(), blog: docsCollection()",
      collections: ["docs", "api", "blog"],
      routes: ["api", "blog"],
    }),
  );
  assert.equal(uncovered(result).length, 1);
  assert.match(uncovered(result)[0]!.message, /doesn't cover page collection "blog"/);
});

test("an explicit apiCollection({ … }) is not assumed", async () => {
  const result = await check(
    site({ registration: 'api: apiCollection({ collection: "api", spec: "./x.json" })', collections: ["docs", "api"], routes: ["api"] }),
  );
  assert.equal(uncovered(result).length, 1);
  assert.match(uncovered(result)[0]!.message, /doesn't cover page collection "api"/);
  assert.ok(!notes(result).some((note) => note.code === "nimbus/api-collections-assumed"));
});

test("a spread content config assumes nothing: today's error, no note", async () => {
  const dir = site({ registration: "api: apiCollection()", collections: ["docs", "api"], routes: ["api"] });
  fs.writeFileSync(path.join(dir, "src", "content.config.ts"), "export const collections = { ...loadCollections() };\n");
  const result = await check(dir);
  assert.equal(uncovered(result).length, 1);
  assert.match(uncovered(result)[0]!.message, /doesn't cover page collection "api"/);
  assert.ok(!notes(result).some((note) => note.code === "nimbus/api-collections-assumed"));
});
