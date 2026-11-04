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
  const field = (f: ApiFieldView) => {
    out.push(f.coordinate);
    if (f.union) union(f.union);
    else for (const c of f.children) field(c);
  };
  const ops = (list: ApiOperationRef[]) => {
    for (const op of list) out.push(op.label, op.webhook ? op.path : `${op.method.toUpperCase()} ${op.path}`);
  };
  switch (props.kind) {
    case "operation":
      for (const g of props.parameters) g.fields.forEach(field);
      props.body.forEach(field);
      if (props.bodyUnion) union(props.bodyUnion);
      for (const r of props.responses) {
        r.fields.forEach(field);
        if (r.bodyUnion) union(r.bodyUnion);
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

for (const [name, file] of [
  ["smallco", "smallco.yaml"],
  ["fidelity", "fidelity.yaml"],
  ["deviant", "deviant.yaml"],
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
          assert.ok(flat.includes(want), `${coordinate}: ${JSON.stringify(want)} missing from its Markdown`);
          checked++;
        }
      }
      assert.ok(checked > 0);
    });
  }
}
