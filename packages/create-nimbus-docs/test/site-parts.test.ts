// `--api` and `--template api`: the site's parts come from the template's own
// `.nimbus-parts/`, the payload never stays in the site, and nimbus.json records
// what `outdated` needs to rebuild the same starter tree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { bytesHash } from "../../nimbus-docs/src/cli/nimbus-json.ts";
import { generateTemplates } from "../scripts/copy-template.mjs";
import { specProblem } from "../src/transformers/site.ts";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  engines: { node: string };
};
const DEFINES = `data:text/javascript,globalThis.__MIN_NODE_VERSION__=${JSON.stringify(PKG.engines.node.replace(/^>=/, ""))};globalThis.__APP_VERSION__=${JSON.stringify(PKG.version)};`;

let templates = "";
let work = "";
before(() => {
  templates = mkdtempSync(join(tmpdir(), "nimbus-site-parts-tpl-"));
  generateTemplates(templates);
  work = mkdtempSync(join(tmpdir(), "nimbus-site-parts-"));
});
after(() => {
  rmSync(templates, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function scaffold(name: string, ...flags: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--import", DEFINES, fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      name, "--yes", "--skip-install", "--no-git", "--template-dir", templates, ...flags],
    { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  return { site: join(work, name), output: result.stdout + result.stderr, status: result.status };
}

/** Files under `dir`, relative to it. */
const files = (dir: string, sub = ""): string[] =>
  readdirSync(join(dir, sub), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      return entry.isDirectory() ? files(dir, rel) : [rel];
    })
    .sort();

test("a docs site is the template's src, with no parts payload or site record", () => {
  const { site, status, output } = scaffold("docs");
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /API reference/);
  assert.ok(!existsSync(join(site, ".nimbus-parts")));
  const nimbus = JSON.parse(readFileSync(join(site, "nimbus.json"), "utf8"));
  assert.equal(nimbus.site, undefined);
  assert.deepEqual(nimbus.components, []);
  const template = join(templates, "template");
  const src = (root: string) => files(join(root, "src"));
  assert.deepEqual(src(site), src(template));
  for (const file of src(template)) {
    assert.equal(readFileSync(join(site, "src", file), "utf8"), readFileSync(join(template, "src", file), "utf8"), file);
  }
});

test("--api with your own spec copies it, points the config at it, and records the installed components", () => {
  const original = join(work, "my-api.json");
  writeFileSync(original, JSON.stringify({ openapi: "3.1.0", info: { title: "Mine", version: "1" }, paths: {} }));
  const spec = join(work, "linked-api.json");
  symlinkSync(original, spec);
  const { site, status, output } = scaffold("own-spec", "--api", spec);
  assert.equal(status, 0, output);
  assert.match(output, /The API reference is at \/api, from src\/api\/openapi\.json\./);
  assert.equal(readFileSync(join(site, "src/api/openapi.json"), "utf8"), readFileSync(original, "utf8"));
  assert.ok(!lstatSync(join(site, "src/api/openapi.json")).isSymbolicLink(), "a symlinked spec is copied, not linked");
  assert.ok(!existsSync(join(site, "src/api/openapi.yaml")));
  assert.match(readFileSync(join(site, "astro.config.ts"), "utf8"), /spec: "\.\/src\/api\/openapi\.json"/);
  const guide = readFileSync(join(site, "AGENT.md"), "utf8");
  assert.match(guide, /## API reference\n\nThe reference at `\/api` is generated from `src\/api\/openapi\.json`/);
  assert.doesNotMatch(guide, /openapi\.yaml/);
  const nimbus = JSON.parse(readFileSync(join(site, "nimbus.json"), "utf8"));
  assert.deepEqual(nimbus.site, { template: "docs", api: { spec: "src/api/openapi.json" } });
  for (const component of nimbus.components) {
    // The hash `add` would record: what's on disk is the registry's bytes.
    const onDisk = component.files.map((file: string) => ({
      path: relative("src", file),
      content: readFileSync(join(site, file), "utf8"),
    }));
    assert.equal(bytesHash(onDisk), component.hash, component.slug);
    assert.equal(component.source, "https://nimbus-docs.com/registry");
  }
});

test("--template api serves the API at the root and drops the docs part", () => {
  const { site, status, output } = scaffold("api-only", "--template", "api");
  assert.equal(status, 0, output);
  assert.match(output, /The API reference is at \/, from the sample spec in src\/api\/openapi\.yaml: replace it with yours\./);
  const guide = readFileSync(join(site, "AGENT.md"), "utf8");
  assert.match(guide, /The reference at `\/` is generated from `src\/api\/openapi\.yaml`/);
  assert.doesNotMatch(guide, /src\/content\/docs|docsCollection|## Writing docs|## Sidebar/);
  assert.match(readFileSync(join(site, "src/pages/[...slug].astro"), "utf8"), /getApiRoute\(Astro, "api"/);
  assert.ok(!existsSync(join(site, "src/pages/api")));
  assert.ok(!existsSync(join(site, "src/content/docs")));
  assert.ok(existsSync(join(site, "src/api/openapi.yaml")));
  const config = readFileSync(join(site, "astro.config.ts"), "utf8");
  assert.doesNotMatch(config, /sidebar:/);
  assert.match(config, /collection: "api"/);
});

test("an API-only site is named after its spec; a docs site keeps its own name", () => {
  const spec = join(work, "acme.yaml");
  writeFileSync(spec, `openapi: 3.1.0\ninfo:\n  title: Acme "Payments"\n  description: |\n    Move money\n    between accounts.\n\n    Second paragraph.\n  version: "1"\npaths: {}\n`);
  const own = scaffold("acme-api", "--template", "api", "--api", spec);
  assert.equal(own.status, 0, own.output);
  const config = readFileSync(join(own.site, "astro.config.ts"), "utf8");
  assert.match(config, /title: "Acme \\"Payments\\"",/);
  assert.match(config, /description: "Move money between accounts\.",/);

  const sample = scaffold("sample-api", "--template", "api");
  assert.equal(sample.status, 0, sample.output);
  const sampleConfig = readFileSync(join(sample.site, "astro.config.ts"), "utf8");
  assert.doesNotMatch(sampleConfig, /title: "Nimbus",/);
  assert.match(sampleConfig, /title: "Weather API",/);

  const docs = scaffold("acme-docs", "--api", spec);
  assert.equal(docs.status, 0, docs.output);
  assert.match(readFileSync(join(docs.site, "astro.config.ts"), "utf8"), /title: "Nimbus",/);
});

test("a spec is recognised by its OpenAPI version in any YAML or JSON style", () => {
  const specs = {
    "bom.yaml": "\uFEFFopenapi: 3.1.0\npaths: {}\n",
    "flow.yaml": "---\n{openapi: 3.1.0, paths: {}}\n",
    "indented.yml": "  openapi: '3.0.3'\r\n  paths: {}\r\n",
    "spec.json": '{"openapi":"3.1.0","paths":{}}',
    "migrated.yaml": "# Migrated from swagger: 2.0\nopenapi: 3.1.0\npaths: {}\n",
    "merged.yaml": "x-base: &base\n  openapi: 3.1.0\n<<: *base\npaths: {}\n",
  };
  for (const [name, text] of Object.entries(specs)) {
    writeFileSync(join(work, name), text);
    assert.equal(specProblem(join(work, name)), undefined, name);
  }
  writeFileSync(join(work, "commented.yaml"), "# openapi: 3.1.0\ntitle: Not OpenAPI\n");
  writeFileSync(join(work, "wrapped.json"), '{"spec":{"openapi":"3.1.0"}}');
  for (const name of ["commented.yaml", "wrapped.json"]) assert.match(specProblem(join(work, name)) ?? "", /isn't an OpenAPI 3\.x document/, name);
});

test("--api with something that isn't an OpenAPI 3.x file, and an unknown --template, fail before writing", () => {
  writeFileSync(join(work, "not-openapi.yaml"), "title: Not OpenAPI\n");
  writeFileSync(join(work, "swagger.json"), JSON.stringify({ swagger: "2.0", paths: {} }));
  for (const [flags, expected] of [
    [["--api", "site-two"], /--api "site-two" isn't an OpenAPI file: .*put the project directory first \(create-nimbus-docs site-two --api\)/],
    [["--template", "blog"], /Unknown template "blog"\. Expected one of: docs, api\./],
    [["--api", "./specs/missing.yaml"], /--api "\.\/specs\/missing\.yaml": .*specs\/missing\.yaml doesn't exist\./],
    [["--api", "./not-openapi.yaml"], /not-openapi\.yaml isn't an OpenAPI 3\.x document: it has no top-level openapi: 3\.x\. Pass an OpenAPI 3\.x file, or --api alone for a sample\./],
    [["--api", "./swagger.json"], /swagger\.json is Swagger 2\.0; convert it to OpenAPI 3\.x first\./],
    [["--api", "./notes.txt"], /--api "\.\/notes\.txt" isn't an OpenAPI file: pass a \.yaml, \.yml or \.json, or --api alone for a sample\./],
    [["--template", "api", "--content", "empty"], /--content doesn't apply to --template api/],
  ] as const) {
    const { site, status, output } = scaffold("refused", ...flags);
    assert.equal(status, 1, output);
    assert.match(output, expected);
    assert.ok(!existsSync(site));
  }
});
