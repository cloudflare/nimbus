// `api[].extensions`: listed `x-*` fields are copied, unchanged, onto the
// operations and fields that declare them, and nothing else changes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  apiSchemaVersion,
  type ApiFieldView,
  type ApiOperationPage,
  type ApiSchemaPage,
} from "../src/api/index.js";
import { unusedExtensions, warnUnusedExtensions } from "../src/_internal/api/extensions.js";
import { prepareApiAssetFamily, readApiAssetPageForBuild } from "../src/_internal/api/page-assets-build.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";
import { resolveApiFamily, resolveApiVersion } from "../src/_internal/api/resolve-versions.js";
import { resolveSpecSource } from "../src/_internal/api/resolve-spec.js";
import type { ApiSpec } from "../src/types.js";

const LISTED = ["x-acme-plans", "x-acme-confirm", "x-acme-sensitive", "x-acme-meta"];

// Every surface that carries extensions, with values of every JSON kind, and
// an unlisted `x-acme-other` that must never appear.
const spec = {
  openapi: "3.1.0",
  info: { title: "Acme", version: "1" },
  paths: {
    "/projects/{id}": {
      delete: {
        operationId: "deleteProject",
        "x-acme-confirm": true,
        "x-acme-plans": ["pro", "enterprise"],
        "x-acme-other": "hidden",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", "x-acme-meta": "schema" }, "x-acme-meta": "param" },
          { name: "force", in: "query", schema: { type: "boolean", "x-acme-meta": 0 } },
        ],
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Project" } },
            "application/xml": { schema: { type: "object", properties: { reason: { type: "string", "x-acme-meta": null } } } },
          },
        },
        responses: {
          "200": {
            description: "Deleted",
            content: {
              "application/json": { schema: { type: "object", properties: { token: { type: "string", "x-acme-sensitive": true } } } },
              "text/csv": { schema: { type: "object", properties: { row: { type: "string", "x-acme-meta": { nested: [1, { deep: false }] } } } } },
            },
          },
        },
      },
    },
  },
  webhooks: {
    projectDeleted: {
      post: {
        operationId: "projectDeleted",
        "x-acme-plans": [],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string", "x-acme-meta": false } } } } } },
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Owner: { type: "object", "x-acme-meta": "from-ref", properties: { email: { type: "string", "x-acme-sensitive": true } } },
      Project: {
        type: "object",
        properties: {
          owner: { $ref: "#/components/schemas/Owner", "x-acme-meta": "from-property" },
          archived: { allOf: [{ type: "boolean", "x-acme-meta": "base" }, { "x-acme-meta": "override" }] },
          plain: { type: "string" },
        },
      },
    },
  },
};

async function pages(extensions: string[] | null = LISTED, schemaPages = true) {
  const model = await buildApiModel({ collection: "acme", spec, schemaPages, ...(extensions ? { extensions } : {}) });
  return {
    model,
    op: getApiPageProps(model, "deleteProject") as ApiOperationPage,
    webhook: getApiPageProps(model, "projectDeleted") as ApiOperationPage,
    project: schemaPages ? (getApiPageProps(model, "Project") as ApiSchemaPage) : undefined,
  };
}

const field = (fields: ApiFieldView[], name: string) => {
  for (const f of fields) {
    if (f.name === name) return f;
    const nested = field(f.children, name);
    if (nested) return nested;
  }
  return undefined;
};

describe("api[].extensions values", () => {
  test("every surface carries exactly the listed values, unchanged", async () => {
    const { op, webhook, project } = await pages();
    assert.deepEqual(op.extensions, { "x-acme-plans": ["pro", "enterprise"], "x-acme-confirm": true });
    assert.deepEqual(webhook.extensions, { "x-acme-plans": [] });
    const params = op.parameters.flatMap((group) => group.fields);
    assert.deepEqual(field(params, "id")?.extensions, { "x-acme-meta": "param" }, "the parameter object wins over its schema");
    assert.deepEqual(field(params, "force")?.extensions, { "x-acme-meta": 0 });
    assert.deepEqual(field(op.additionalBodies![0]!.fields, "reason")?.extensions, { "x-acme-meta": null });
    assert.deepEqual(field(op.responses[0]!.fields, "token")?.extensions, { "x-acme-sensitive": true });
    assert.deepEqual(field(op.responses[0]!.additionalMedia![0]!.fields, "row")?.extensions, { "x-acme-meta": { nested: [1, { deep: false }] } });
    assert.deepEqual(field(webhook.body, "id")?.extensions, { "x-acme-meta": false });
    assert.deepEqual(field(project!.fields, "email")?.extensions, { "x-acme-sensitive": true }, "schema page fields");
    assert.equal(field(op.body, "plain")?.extensions, undefined, "no empty object");
    assert.ok(!JSON.stringify([op, webhook, project]).includes("x-acme-other"));
  });

  test("a property's own value wins over its $ref target's, and allOf merges like description", async () => {
    const { op } = await pages();
    assert.deepEqual(field(op.body, "owner")?.extensions, { "x-acme-meta": "from-property" });
    assert.deepEqual(field(op.body, "email")?.extensions, { "x-acme-sensitive": true });
    assert.deepEqual(field(op.body, "archived")?.extensions, { "x-acme-meta": "override" });
  });

  test("unset, nothing is carried and Markdown never shows values", async () => {
    const { op } = await pages(null);
    const json = JSON.stringify(op);
    assert.ok(!json.includes("extensions"), json.slice(Math.max(0, json.indexOf("extensions") - 120), json.indexOf("extensions") + 40));
    const listed = await pages();
    assert.equal(renderApiPageMarkdown(listed.op), renderApiPageMarkdown(op));
    assert.equal(apiSchemaVersion, 1);
  });

  test("two versions with the same spec and different lists don't share a model", async () => {
    const a = getApiPageProps(await buildApiModel({ collection: "acme", spec, extensions: ["x-acme-confirm"] }), "deleteProject") as ApiOperationPage;
    const b = getApiPageProps(await buildApiModel({ collection: "acme", spec, extensions: ["x-acme-plans"] }), "deleteProject") as ApiOperationPage;
    assert.deepEqual(a.extensions, { "x-acme-confirm": true });
    assert.deepEqual(b.extensions, { "x-acme-plans": ["pro", "enterprise"] });
  });

  test("unused names are found per model", async () => {
    const { model } = await pages([...LISTED, "x-acme-typo"]);
    assert.deepEqual(unusedExtensions(model, [...LISTED, "x-acme-typo"]), ["x-acme-typo"]);
    const messages: string[] = [];
    warnUnusedExtensions("unused-test", "v1", ["x-acme-typo"], (m) => messages.push(m));
    warnUnusedExtensions("unused-test", "v1", ["x-acme-typo"], (m) => messages.push(m));
    warnUnusedExtensions("unused-test", "v2", ["x-acme-typo"], (m) => messages.push(m));
    assert.equal(messages.length, 2, "once per collection and version");
    assert.match(messages[0]!, /"unused-test" version "v1": extensions lists "x-acme-typo", but no operation or field carries it/);
  });
});

describe("api[].extensions in prepared page assets", () => {
  const family = (extensions: string[] | undefined, v1?: string[]): ApiSpec => ({
    collection: "acme-assets",
    versionUrl: { in: "query" },
    samples: { generate: [] },
    ...(extensions ? { extensions } : {}),
    versions: [
      { version: "v2", default: true, spec },
      { version: "v1", spec, ...(v1 ? { extensions: v1 } : {}) },
    ],
  });
  const operation = async (root: string, result: Awaited<ReturnType<typeof prepareApiAssetFamily>>, version: number) => {
    const row = result.versions[version]!.prepared.rows.find((r) => r.id.endsWith("deleteProject"))!;
    return (await readApiAssetPageForBuild(root, row)) as unknown as ApiOperationPage;
  };

  test("stored pages carry the values; a version's list replaces the family's; a new name re-prepares", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nimbus-extensions-"));
    try {
      const warnings: string[] = [];
      const first = await prepareApiAssetFamily(root, family(["x-acme-confirm"], ["x-acme-plans", "x-acme-missing"]), (m) => warnings.push(m));
      assert.deepEqual((await operation(root, first, 0)).extensions, { "x-acme-confirm": true });
      assert.deepEqual((await operation(root, first, 1)).extensions, { "x-acme-plans": ["pro", "enterprise"] });
      assert.equal(warnings.filter((w) => w.includes("x-acme-missing")).length, 1);

      const again = await prepareApiAssetFamily(root, family(["x-acme-confirm"], ["x-acme-plans", "x-acme-missing"]), (m) => warnings.push(m));
      assert.ok(again.versions.every(({ prepared }) => prepared.reused));
      assert.deepEqual(again.versions[1]!.prepared.unusedExtensions, ["x-acme-missing"], "kept with the cached version");

      const widened = await prepareApiAssetFamily(root, family(["x-acme-confirm", "x-acme-plans"], ["x-acme-plans", "x-acme-missing"]));
      assert.equal(widened.versions[0]!.prepared.reused, false);
      assert.deepEqual((await operation(root, widened, 0)).extensions, { "x-acme-plans": ["pro", "enterprise"], "x-acme-confirm": true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("api[].extensions resolution", () => {
  // Request rendering (`getApiModel`) and every loader resolve a version, then
  // its spec source, before building the model; both steps keep the list.
  test("a version's list replaces the family's, through to the spec source", async () => {
    const entry: ApiSpec = {
      collection: "acme",
      extensions: ["x-acme-confirm"],
      versions: [
        { version: "v2", default: true, spec },
        { version: "v1", spec, extensions: ["x-acme-plans"] },
      ],
    };
    assert.deepEqual(resolveApiFamily(entry).map((t) => t.extensions), [["x-acme-confirm"], ["x-acme-plans"]]);
    const v1 = resolveApiVersion([entry], "acme", "v1")!;
    const source = await resolveSpecSource({ collection: v1.namespace, spec: v1.spec, extensions: v1.extensions }, tmpdir());
    assert.deepEqual(source.extensions, ["x-acme-plans"]);
    const page = getApiPageProps(await buildApiModel(source), "deleteProject") as ApiOperationPage;
    assert.deepEqual(page.extensions, { "x-acme-plans": ["pro", "enterprise"] });
    assert.equal(resolveApiFamily({ collection: "acme", spec })[0]!.extensions, undefined);
  });
});

describe("api[].extensions config", () => {
  const site = { site: "https://docs.example.com", title: "Acme" };
  const config = (extensions: unknown) => ({ ...site, api: [{ collection: "acme", spec: "./openapi.json", extensions }] });
  for (const [names, message] of [
    [["acme-plans"], /"api\[\]\.extensions" entry "acme-plans" must start with "x-"/],
    [["x-nimbus-thing"], /entry "x-nimbus-thing" is reserved/],
    [["x-acme", "x-acme"], /entry "x-acme" is listed twice/],
  ] as const) {
    test(`rejects ${JSON.stringify(names)}`, () => {
      assert.throws(() => validateNimbusConfig(config(names)), message);
    });
  }

  test("accepts x- names and a per-version list", () => {
    assert.doesNotThrow(() => validateNimbusConfig(config(["x-acme-plans", "x-Acme.v2_beta"])));
    assert.doesNotThrow(() => validateNimbusConfig({
      ...site,
      api: [{ collection: "acme", extensions: ["x-a"], versions: [{ version: "v1", spec: "./a.json", extensions: ["x-b"] }] }],
    }));
  });
});

describe("ApiExtensions types", () => {
  test("a site's declaration types its values, and a wrong use fails", async () => {
    const pkg = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
    const dir = await mkdtemp(path.join(tmpdir(), "nimbus-extension-types-"));
    try {
      await mkdir(path.join(dir, "node_modules", "@cloudflare"), { recursive: true });
      await symlink(pkg, path.join(dir, "node_modules", "@cloudflare", "nimbus-docs"), "dir");
      await writeFile(path.join(dir, "env.d.ts"), `export {};
declare module "@cloudflare/nimbus-docs/types" {
  interface ApiExtensions {
    "x-acme-plans": string[];
  }
}
`);
      await writeFile(path.join(dir, "ok.ts"), `import type { ApiOperationPage } from "@cloudflare/nimbus-docs/api";
declare const page: ApiOperationPage;
const plans: string[] | undefined = page.extensions?.["x-acme-plans"];
const other: unknown = page.extensions?.["x-acme-other"];
export { plans, other };
`);
      await writeFile(path.join(dir, "wrong.ts"), `import type { ApiOperationPage } from "@cloudflare/nimbus-docs/api";
declare const page: ApiOperationPage;
const wrong: number | undefined = page.extensions?.["x-acme-plans"];
export { wrong };
`);
      const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        skipLibCheck: true,
        types: [],
      };
      const errors = (file: string) =>
        ts.getPreEmitDiagnostics(ts.createProgram([path.join(dir, "env.d.ts"), path.join(dir, file)], options))
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      assert.deepEqual(errors("ok.ts"), []);
      const wrong = errors("wrong.ts");
      assert.equal(wrong.length, 1, wrong.join("\n"));
      assert.match(wrong[0]!, /string\[\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
