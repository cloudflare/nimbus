// An API page's Markdown carries what its HTML shows. Every fact the page
// renders comes from its view model, so walk the props the page renders and
// require each field, branch, method and path in the Markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildApiModel,
  getApiPageProps,
  getApiPageSlugs,
  renderApiPageMarkdown,
  type ApiFieldView,
  type ApiOperationRef,
  type ApiPageProps,
  type ApiUnionView,
} from "../src/api/index.js";

const spec = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/api/${name}`, import.meta.url)), "utf8");

/** What a page shows, as the strings its Markdown must contain. */
function facts(props: ApiPageProps): string[] {
  const out: string[] = [];
  const union = (u: ApiUnionView) => {
    const entries = u.mapping && u.mapping.length > 0 ? u.mapping.map((m) => m.variant) : u.variants;
    for (const v of [...entries, ...u.variants]) {
      out.push(v.label);
      for (const f of v.fields ?? []) field(f);
      if (v.union) union(v.union);
    }
    for (const m of u.mapping ?? []) out.push(m.value);
  };
  // A field shows its children, then its union's options: both, when the spec
  // declares fields beside a union.
  const field = (f: ApiFieldView) => {
    out.push(f.coordinate);
    for (const c of f.children) field(c);
    if (f.union) union(f.union);
  };
  const body = (b: { fields: ApiFieldView[]; union?: ApiUnionView; scalar?: { type: string }; mediaType?: string }) => {
    b.fields.forEach(field);
    if (b.union) union(b.union);
    if (b.scalar) out.push(b.scalar.type);
  };
  const ops = (list: ApiOperationRef[]) => {
    for (const op of list) out.push(op.label, `${op.method.toUpperCase()} ${op.path}`);
  };
  switch (props.kind) {
    case "operation":
      for (const g of props.parameters) g.fields.forEach(field);
      body({ fields: props.body, union: props.bodyUnion, scalar: props.bodyScalar });
      for (const b of props.additionalBodies ?? []) body(b);
      for (const r of props.responses) {
        body({ fields: r.fields, union: r.bodyUnion, scalar: r.scalar });
        for (const m of r.additionalMedia ?? []) body(m);
        r.headers?.forEach(field);
      }
      break;
    case "schema":
      props.fields.forEach(field);
      if (props.union) union(props.union);
      break;
    case "section":
      ops(props.operations);
      break;
    case "api": {
      const sections = (list: typeof props.index.groups[number]["sections"]): void => {
        for (const s of list) {
          out.push(s.ref.label);
          if (s.description) out.push(s.description);
          ops(s.operations);
          sections(s.sections);
        }
      };
      for (const g of props.index.groups) {
        if (g.label) out.push(g.label);
        ops(g.operations);
        sections(g.sections);
      }
      ops(props.index.operations);
      ops(props.index.webhooks);
      break;
    }
  }
  return out;
}

/** A field every union branch shares prints once, citing `<option>.path`; its
 *  coordinate is still in the Markdown if some split `prefix.path` has both
 *  the cited `<option>.path` and the option `prefix` it stands for, as code
 *  or as a link's text. */
function cited(flat: string, coordinate: string): boolean {
  for (let i = coordinate.indexOf("."); i > 0; i = coordinate.indexOf(".", i + 1)) {
    const prefix = coordinate.slice(0, i);
    const named = flat.includes(`\`${prefix}\``) || flat.includes(`[${prefix}](`);
    if (named && flat.includes(`\`<option>${coordinate.slice(i)}\``)) return true;
  }
  return false;
}

for (const [name, file] of [
  ["smallco", "smallco.yaml"],
  ["fidelity", "fidelity.yaml"],
  ["deviant", "deviant.yaml"],
  ["shapes", "shapes.yaml"],
] as const) {
  for (const schemaPages of [true, false]) {
    test(`${name}, schemaPages ${schemaPages}: every page's Markdown carries what the page shows`, async () => {
      const model = await buildApiModel({ schemaPages, collection: name, spec: spec(file), label: file });
      let checked = 0;
      for (const { coordinate } of getApiPageSlugs(model)) {
        const props = getApiPageProps(model, coordinate);
        const md = renderApiPageMarkdown(props);
        // Markdown collapses whitespace in inline prose; compare likewise.
        const flat = md.replace(/\s+/g, " ");
        for (const fact of facts(props)) {
          const want = fact.replace(/\s+/g, " ").trim();
          assert.ok(flat.includes(want) || cited(flat, want), `${coordinate}: ${JSON.stringify(want)} missing from its Markdown`);
          checked++;
        }
      }
      assert.ok(checked > 0);
    });
  }
}

test("an unnamed branch whose label matches a mapped schema's keeps its own fields", async () => {
  const spec = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/object"
                - type: object
                  properties:
                    alternativeOnly: { type: string }
              discriminator:
                propertyName: kind
                mapping:
                  mapped: "#/components/schemas/object"
      responses:
        "204": { description: Done }
components:
  schemas:
    object:
      type: object
      properties:
        kind: { type: string }
        mappedOnly: { type: string }
`;
  const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec, schemaPages: false });
  const md = renderApiPageMarkdown(getApiPageProps(model, "createThing") as never);
  assert.match(md, /mappedOnly/);
  assert.match(md, /alternativeOnly/, "the unnamed branch isn't folded into the mapped one");
});

test("a large API's home lists each section with its endpoint count; a small one lists every endpoint", async () => {
  const spec = (count: number) =>
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      tags: [{ name: "Pets", description: "Pets you can adopt." }, { name: "Stores" }],
      paths: {
        ...Object.fromEntries(
          Array.from({ length: count }, (_, n) => [
            `/things/${n}`,
            { get: { operationId: `get${n}`, summary: `Get thing ${n}`, tags: [n % 2 ? "Pets" : "Stores"], responses: { "200": { description: "OK" } } } },
          ]),
        ),
        "/untagged": { get: { operationId: "untagged", summary: "Untagged", responses: { "200": { description: "OK" } } } },
      },
    });
  const home = async (count: number) => {
    const model = await buildApiModel({ collection: "api", label: "spec.json", spec: spec(count) });
    return renderApiPageMarkdown(getApiPageProps(model, "api") as never);
  };
  const large = await home(160);
  assert.match(large, /\[Pets\]\([^)]*\)\n\nPets you can adopt\.\n\n80 endpoints\n/);
  assert.match(large, /\[Stores\]\([^)]*\)\n\n80 endpoints\n/);
  assert.doesNotMatch(large, /Get thing 7\b/, "section endpoints are on the section's own page");
  assert.match(large, /## Other endpoints\n\n- \[Untagged\]/, "untagged endpoints have no page of their own");
  const small = await home(10);
  assert.match(small, /Get thing 7\b/);
  assert.doesNotMatch(small, /\d+ endpoints\n/);
});

const RECORDS = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /records:
    post:
      operationId: createRecord
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/ARecord"
                - $ref: "#/components/schemas/MXRecord"
                - $ref: "#/components/schemas/CNAMERecord"
      responses:
        "204": { description: Done }
components:
  schemas:
    Shared:
      type: object
      properties:
        name: { type: string, description: Record name., maxLength: 255 }
        ttl: { type: integer, default: 1 }
        settings:
          type: object
          properties:
            ipv4_only: { type: boolean }
    ARecord:
      allOf:
        - $ref: "#/components/schemas/Shared"
        - type: object
          properties:
            content: { type: string, description: An IPv4 address. }
    MXRecord:
      allOf:
        - $ref: "#/components/schemas/Shared"
        - type: object
          properties:
            content: { type: string, description: A mail server. }
            priority: { type: integer }
    CNAMERecord:
      allOf:
        - $ref: "#/components/schemas/Shared"
        - type: object
          properties:
            content: { type: string, description: A hostname. }
            settings:
              type: object
              properties:
                flatten_cname: { type: boolean }
`;

for (const schemaPages of [true, false]) {
  test(`union branches: shared fields print once, differing ones stay with their branch (schemaPages ${schemaPages})`, async () => {
    const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec: RECORDS, schemaPages });
    const md = renderApiPageMarkdown(getApiPageProps(model, "createRecord") as never);
    const shared = md.slice(md.indexOf("Every option has:"), md.indexOf("each adding:"));
    assert.match(shared, /`name` \(`<option>\.name`; string, optional\) — Record name\./);
    assert.match(shared, /`ttl` \(`<option>\.ttl`;/);
    assert.doesNotMatch(shared, /`content`/, "content differs in every branch");
    assert.doesNotMatch(shared, /`settings`/, "CNAMERecord redefines settings");
    assert.equal(md.match(/`<option>\.name`/g)?.length, 1, "printed once, not per branch");
    const branches = md.slice(md.indexOf("each adding:"));
    for (const [record, own] of [["ARecord", "An IPv4 address."], ["MXRecord", "A mail server."], ["CNAMERecord", "A hostname."]] as const) {
      assert.ok(branches.includes(record), record);
      assert.ok(branches.includes(own), `${record} keeps its own content`);
    }
    assert.match(branches, /`MXRecord\.priority`/);
    assert.match(branches, /`ARecord\.settings\.ipv4_only`/, "settings stays per branch, with its coordinates");
    assert.match(branches, /`CNAMERecord\.settings\.flatten_cname`/);
    assert.doesNotMatch(branches, /`ARecord\.name`/, "shared fields aren't repeated");
  });
}

test("union branches that share nothing render as before", async () => {
  const spec = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /records:
    post:
      operationId: createRecord
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - { type: object, properties: { ip: { type: string } } }
                - { type: object, properties: { host: { type: string } } }
      responses:
        "204": { description: Done }
`;
  const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec, schemaPages: false });
  const md = renderApiPageMarkdown(getApiPageProps(model, "createRecord") as never);
  assert.doesNotMatch(md, /Every option has|<option>/);
  assert.match(md, /One of the following:/);
});

test("authored values named like view-model keys are compared as written", async () => {
  const spec = `
openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: "#/components/schemas/Left"
                - $ref: "#/components/schemas/Right"
      responses:
        "204": { description: Done }
components:
  schemas:
    Left:
      type: object
      properties:
        layout: { type: object, default: { anchor: left, coordinate: a } }
        same: { type: object, example: { anchor: top, coordinate: z } }
    Right:
      type: object
      properties:
        layout: { type: object, default: { anchor: right, coordinate: b } }
        same: { type: object, example: { anchor: top, coordinate: z } }
`;
  const model = await buildApiModel({ collection: "api", label: "spec.yaml", spec, schemaPages: false });
  const md = renderApiPageMarkdown(getApiPageProps(model, "createThing") as never);
  const shared = md.slice(md.indexOf("Every option has:"), md.indexOf("each adding:"));
  assert.match(shared, /`same`/, "identical authored examples are shared");
  assert.match(shared, /"anchor":"top","coordinate":"z"/, "and printed as written");
  assert.doesNotMatch(shared, /`layout`/, "different authored defaults stay per branch");
  assert.match(md, /"anchor":"left"/);
  assert.match(md, /"anchor":"right"/);
});

test("a large API's home counts a tag group's endpoints when the group has a page", async () => {
  const ops = (tag: string, n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`/${tag.toLowerCase()}/${i}`, { get: { operationId: `${tag}${i}`, summary: `${tag} ${i}`, tags: [tag], responses: { "200": { description: "OK" } } } }]));
  const spec = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    tags: [{ name: "Core", description: "Core endpoints." }, { name: "Extra" }],
    "x-tagGroups": [{ name: "Core", tags: ["Core", "Extra"] }],
    paths: { ...ops("Core", 200), ...ops("Extra", 5) },
  });
  const model = await buildApiModel({ collection: "api", label: "spec.json", spec });
  const md = renderApiPageMarkdown(getApiPageProps(model, "api") as never);
  assert.doesNotMatch(md, /Core 17\b/, "the group's endpoints are on its own page");
  assert.match(md, /\b200 endpoints\b|\b5 endpoints\b/);
});
