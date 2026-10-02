// `schemaPages: false` (the default) keeps every schema node (so operation pages
// still show their fields and union previews) but publishes no schema page;
// `true` restores schema pages exactly as before the option existed. Pins the four
// consequences: no schema routes, links follow pages rather than nodes,
// citations to a schema fail with a reason that names the option, and schema
// identities still claim their slugs so turning pages back on never collides.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ApiBuildError,
  buildApiModel,
  getApiPageProps,
  getApiPageSlugs,
  renderApiPageMarkdown,
  type ApiOperationPage,
  type ApiVariant,
} from "../src/api/index.js";
import { buildCitationIndex } from "../src/_internal/api/citation-index.ts";
import { resolveCitations } from "../src/_internal/api/citations.ts";
import { createAuthoredCitationResolver } from "../src/_internal/api/authored-citations.ts";
import { parseOpenApi } from "../src/_internal/api/parse.ts";
import { validateNimbusConfig } from "../src/_internal/validate.ts";
import type { ApiSpec } from "../src/types.ts";

const SMALLCO = fileURLToPath(new URL("./fixtures/api/smallco.yaml", import.meta.url));
const root = fileURLToPath(new URL(".", import.meta.url));

const MAP_SPEC = `
openapi: 3.1.0
info: { title: Maps, version: "1" }
paths:
  /envs:
    post:
      operationId: putEnvs
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                envs:
                  type: object
                  additionalProperties: { $ref: "#/components/schemas/Env" }
      responses:
        "200": { description: ok }
components:
  schemas:
    Env: { type: object, properties: { value: { type: string } } }
`;

const SMALLCO_TEXT = readFileSync(SMALLCO, "utf8");

async function model(schemaPages?: boolean, spec = SMALLCO_TEXT) {
  return buildApiModel({
    collection: "api",
    spec,
    ...(schemaPages === undefined ? {} : { schemaPages }),
  });
}

function allVariants(page: ApiOperationPage): ApiVariant[] {
  const out: ApiVariant[] = [];
  const unions = [
    page.bodyUnion,
    ...page.body.map((f) => f.union),
    ...page.responses.map((r) => r.bodyUnion),
  ];
  for (const u of unions) {
    if (!u) continue;
    out.push(...u.variants, ...(u.mapping ?? []).map((m) => m.variant));
  }
  return out;
}

describe("schemaPages: config", () => {
  test("validation accepts a boolean and rejects anything else", () => {
    const base = { site: "https://example.test", title: "T", description: "D" };
    assert.doesNotThrow(() =>
      validateNimbusConfig({ ...base, api: [{ collection: "api", spec: "./a.yaml", schemaPages: false }] }),
    );
    assert.throws(
      () => validateNimbusConfig({ ...base, api: [{ collection: "api", spec: "./a.yaml", schemaPages: "no" }] }),
      /"api\[\]\.schemaPages" must be a boolean/,
    );
  });

  test("the model cache keys on schemaPages (same spec bytes never alias)", async () => {
    const on = await model(true);
    const off = await model(false);
    assert.notEqual(on, off);
    assert.equal(await model(), off, "unset is the default (false)");
  });
});

describe("schemaPages: false — parse", () => {
  test("no schema page is registered; operation and root pages are unchanged", async () => {
    const on = getApiPageSlugs(await model(true));
    const off = getApiPageSlugs(await model());
    assert.ok(on.some((p) => p.slug.startsWith("schemas/")), "schemaPages: true publishes schema pages");
    assert.deepEqual(getApiPageSlugs(await model(false)), off, "false is the default");
    assert.deepEqual(
      off,
      on.filter((p) => !p.slug.startsWith("schemas/")),
    );
  });

  test("a spec with only schemas builds just its root page and warns once", async () => {
    const spec = `
openapi: 3.1.0
info: { title: Types, version: "1" }
paths: {}
components:
  schemas:
    Thing: { type: object, properties: { id: { type: string } } }
`;
    const off = await parseOpenApi({ collection: "api", spec, schemaPages: false });
    assert.deepEqual([...off.model.pages.pages], ["api"]);
    const warnings = off.diagnostics.filter((d) => d.code === "schema-pages-only-root");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /schemas appear on no page/);

    const on = await parseOpenApi({ collection: "api", spec, schemaPages: true });
    assert.equal(on.diagnostics.filter((d) => d.code === "schema-pages-only-root").length, 0);
  });

  test("the schemas-only warning makes no page-count claim when tag pages exist", async () => {
    const spec = `
openapi: 3.1.0
info: { title: Types, version: "1" }
paths: {}
tags:
  - name: Types
components:
  schemas:
    Thing: { type: string }
`;
    const off = await parseOpenApi({ collection: "api", spec, schemaPages: false });
    assert.deepEqual([...off.model.pages.pages].sort(), ["api", "tags.Types"]);
    const warning = off.diagnostics.find((d) => d.code === "schema-pages-only-root");
    assert.ok(warning, "still warns: the schemas appear on no page");
    assert.doesNotMatch(warning.message, /root page/);
  });

  test("schema identities still claim their slug: operationId schemas/User collides with schema User", async () => {
    const spec = `
openapi: 3.1.0
info: { title: Clash, version: "1" }
paths:
  /users:
    get:
      operationId: schemas/User
      responses:
        "200": { description: ok }
components:
  schemas:
    User: { type: object, properties: { id: { type: string } } }
`;
    for (const schemaPages of [true, false]) {
      await assert.rejects(
        parseOpenApi({ collection: "api", spec, schemaPages }),
        (err: unknown) => {
          assert.ok(err instanceof ApiBuildError);
          assert.match(err.message, /both map to the\s+route slug "schemas\/User"/);
          return true;
        },
        `collides with schemaPages: ${schemaPages}`,
      );
    }
  });
});

describe("schemaPages: false — view model", () => {
  test("union variants and discriminator mappings render without an href", async () => {
    const off = await model(false);
    for (const op of ["create", "openDispute"]) {
      const variants = allVariants(getApiPageProps(off, op) as ApiOperationPage);
      assert.ok(variants.length > 0, `${op} has union variants`);
      for (const v of variants) assert.equal(v.href, undefined, `${op}: ${v.label} has no href`);
    }
  });

  test("inline variant property previews are unchanged", async () => {
    const strip = (variants: ApiVariant[]) => variants.map(({ href: _href, ...rest }) => rest);
    for (const op of ["create", "openDispute"]) {
      const on = allVariants(getApiPageProps(await model(true), op) as ApiOperationPage);
      const off = allVariants(getApiPageProps(await model(false), op) as ApiOperationPage);
      assert.ok(on.every((v) => typeof v.href === "string"), `${op}: schemaPages: true links every variant`);
      assert.deepEqual(strip(off), strip(on));
    }
  });

  test("a map<Name> value type keeps its label but drops the link", async () => {
    const field = async (schemaPages?: boolean) =>
      (getApiPageProps(await model(schemaPages, MAP_SPEC), "putEnvs") as ApiOperationPage).body.find(
        (f) => f.name === "envs",
      )!;
    const on = await field(true);
    const off = await field(false);
    assert.equal(on.typeRef?.label, "Env");
    assert.equal(off.type, "map<Env>");
    assert.equal(off.typeRef, undefined);
  });

  test("Markdown renders variants as inline code and map types as text, unlinked", async () => {
    const off = await model(false);
    const create = renderApiPageMarkdown(getApiPageProps(off, "create"));
    assert.doesNotMatch(create, /\/schemas\//);
    assert.match(create, /`Card`/);
    const envs = renderApiPageMarkdown(getApiPageProps(await model(false, MAP_SPEC), "putEnvs"));
    assert.doesNotMatch(envs, /\/schemas\//);
    assert.match(envs, /\(map<Env>, optional\)/, "an unlinked field type reads like any other unlinked type");
  });
});

describe("page props for a coordinate without a page", () => {
  test("a schema under schemaPages: false is rejected, not given the root's URLs", async () => {
    const off = await model(false);
    assert.throws(
      () => getApiPageProps(off, "Dispute"),
      /Coordinate "Dispute" is a schema node, which is not a page \(schema pages are off for this collection\)/,
    );
    assert.equal(getApiPageProps(await model(true), "Dispute").kind, "schema", "schemaPages: true projects it");
  });

  test("an x-tagGroups category (nav-only) is rejected too", async () => {
    const spec = `
openapi: 3.1.0
info: { title: Grouped, version: "1" }
x-tagGroups:
  - name: Compute
    tags: [Workers]
tags:
  - name: Workers
paths:
  /workers:
    get:
      operationId: listWorkers
      tags: [Workers]
      responses:
        "200": { description: ok }
`;
    const grouped = await model(undefined, spec);
    assert.throws(() => getApiPageProps(grouped, "tags.Compute"), /Coordinate "tags\.Compute" is a section node, which is not a page\.$/);
    assert.equal(getApiPageProps(grouped, "tags.Workers").kind, "section");
  });
});

describe("schemaPages: false — citations", () => {
  const off: ApiSpec[] = [{ collection: "api", spec: SMALLCO, schemaPages: false }];

  test("the index and coordinates manifest leave out schemas and schema fields", async () => {
    const on = await buildCitationIndex([{ collection: "api", spec: SMALLCO, schemaPages: true }], root);
    const result = await buildCitationIndex(off, root);
    assert.ok(on.index.has("api:Dispute") && on.index.has("api:Dispute.status"));
    assert.ok(!result.index.has("api:Dispute") && !result.index.has("api:Dispute.status"));
    assert.ok(result.index.has("api:create"), "operations still resolve");
    const manifestCoords = result.manifest.collections.api!.pages.flatMap((g) => Object.keys(g.entries));
    assert.ok(!manifestCoords.some((c) => c === "Dispute" || c.startsWith("Dispute.")));
    assert.equal(on.unpublished.size, 0);
    assert.equal(result.unpublished.get("api:Dispute"), "Dispute");
    assert.equal(result.unpublished.get("api:Dispute.status"), "Dispute");
  });

  test("an authored citation to a schema or schema field fails with a named reason", async () => {
    const { index, unpublished } = await buildCitationIndex(off, root);
    const schema = resolveCitations("[d](api.ref:api:Dispute)", { mode: "author", citationIndex: index, unpublished });
    assert.equal(schema.code, "[d](#)");
    assert.equal(schema.diagnostics[0]?.level, "error");
    assert.match(
      schema.diagnostics[0]!.message,
      /"Dispute" is a schema, and schema pages are off for "api" \(`schemaPages: false`\)/,
    );
    const field = resolveCitations("[s](api.ref:api:Dispute.status)", { mode: "author", citationIndex: index, unpublished });
    assert.match(field.diagnostics[0]!.message, /"Dispute\.status" is a field of schema "Dispute"/);

    const resolve = createAuthoredCitationResolver({
      contentDirs: ["/tmp/nimbus-content"],
      getCitationIndex: () => index,
      getUnpublishedCitations: () => unpublished,
    });
    assert.throws(
      () => resolve("[d](api.ref:api:Dispute)", "/tmp/nimbus-content/guide.md"),
      /schema pages are off for "api"/,
    );
  });

  test("derived Markdown keeps today's warning and renders #", async () => {
    const { index, unpublished } = await buildCitationIndex(off, root);
    const derived = resolveCitations("[d](api.ref:api:Dispute)", { mode: "derived", citationIndex: index, unpublished });
    assert.equal(derived.code, "[d](#)");
    assert.equal(derived.diagnostics[0]?.level, "warning");
    assert.match(derived.diagnostics[0]!.message, /does not resolve; rendering "#"/);
  });

  test("versioned families key unpublished citations per version", async () => {
    const { unpublished } = await buildCitationIndex(
      [{ collection: "svc", schemaPages: false, versions: [
        { version: "v2", default: true, spec: SMALLCO },
        { version: "v1", spec: SMALLCO },
      ] }],
      root,
    );
    for (const key of ["svc:Dispute", "svc@v2:Dispute", "svc@v1:Dispute"]) {
      assert.equal(unpublished.get(key), "Dispute", key);
    }
  });
});
