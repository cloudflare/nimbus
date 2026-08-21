// Measures rendered field count, nesting depth, twin-markdown bytes, and ref
// "reducibility" across every page of the Cloudflare fixture — the derivation
// behind the inline-field ceiling and depth bound. Run:
//   node --max-old-space-size=6144 --import tsx scripts/measure-api-pages.mts
// To expose the UNCENSORED depth distribution, temporarily raise
// `SCHEMA_FIELD_DEPTH` in src/_internal/api/parse.ts before running.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildApiModel,
  getApiPageProps,
  getApiPageSlugs,
  renderApiPageMarkdown,
} from "../src/api/index.js";

const path = fileURLToPath(new URL("../test/fixtures/api/production/cloudflare.json", import.meta.url));

function countFields(
  node: unknown,
  acc: { max: number; reducible: number; underRef: boolean },
  depth = 0,
): number {
  if (!node || typeof node !== "object") return 0;
  const anyNode = node as Record<string, unknown>;
  let n = 0;
  const children = anyNode.children;
  const fields = anyNode.fields;
  const kids = (Array.isArray(children) ? children : Array.isArray(fields) ? fields : []) as unknown[];
  for (const k of kids) {
    n += 1;
    const k2 = k as Record<string, unknown>;
    // A field is "reducible" if it (or an ancestor) is a named ref (has typeRef)
    // — its whole inlined subtree could collapse to a single link.
    const underRef = acc.underRef || Boolean(k2.typeRef);
    if (acc.underRef) acc.reducible += 1;
    if (depth + 1 > acc.max) acc.max = depth + 1;
    const saved = acc.underRef;
    acc.underRef = underRef;
    n += countFields(k, acc, depth + 1);
    acc.underRef = saved;
  }
  return n;
}

function collectFieldContainers(props: unknown, out: unknown[]): void {
  // Walk the page props for any object carrying `fields` (param groups, request,
  // responses, schema field lists) so we count every rendered field tree.
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object" || seen.has(v as object)) return;
    seen.add(v as object);
    const anyV = v as Record<string, unknown>;
    if (Array.isArray(anyV.fields)) out.push({ fields: anyV.fields });
    for (const val of Object.values(anyV)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object") walk(val);
    }
  };
  walk(props);
}

const model = await buildApiModel({
  collection: "cloudflare",
  spec: readFileSync(path, "utf8"),
  label: "cloudflare.json",
});

const slugs = getApiPageSlugs(model);
const fieldCounts: number[] = [];
const byteSizes: number[] = [];
const depths: number[] = [];
const reducibles: number[] = [];
let opPages = 0;
let schemaPages = 0;

for (const { coordinate } of slugs) {
  let props;
  try {
    props = getApiPageProps(model, coordinate);
  } catch {
    continue;
  }
  const kind = (props as Record<string, unknown>).kind ?? (props as Record<string, unknown>).node;
  if (kind === "operation") opPages += 1;
  if (kind === "schema") schemaPages += 1;

  const containers: unknown[] = [];
  collectFieldContainers(props, containers);
  const acc = { max: 0, reducible: 0, underRef: false };
  let total = 0;
  for (const c of containers) total += countFields(c, acc);
  fieldCounts.push(total);
  depths.push(acc.max);
  reducibles.push(acc.reducible);

  const md = renderApiPageMarkdown(props);
  byteSizes.push(Buffer.byteLength(md, "utf8"));
}

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}
function stat(label: string, arr: number[]) {
  const total = arr.reduce((a, b) => a + b, 0);
  console.log(
    `${label.padEnd(14)} n=${arr.length} mean=${(total / arr.length).toFixed(1)} p50=${pct(arr, 50)} p90=${pct(arr, 90)} p95=${pct(arr, 95)} p99=${pct(arr, 99)} p999=${pct(arr, 99.9)} max=${Math.max(...arr)}`,
  );
}

console.log(`pages=${slugs.length} operationPages=${opPages} schemaPages=${schemaPages}`);
stat("fields/page", fieldCounts);
stat("depth/page", depths);
stat("bytes/page", byteSizes);

for (const t of [30, 40, 50, 60, 75, 100, 150, 200]) {
  const over = fieldCounts.filter((c) => c > t).length;
  console.log(`fields > ${String(t).padEnd(3)}: ${over} pages (${((over / fieldCounts.length) * 100).toFixed(2)}%)`);
}
for (const t of [6, 8, 10, 12]) {
  const over = depths.filter((d) => d > t).length;
  console.log(`depth  > ${String(t).padEnd(3)}: ${over} pages (${((over / depths.length) * 100).toFixed(2)}%)`);
}

// Does link-out shrink the monster pages? For each threshold, on pages OVER it,
// how many fields would collapse to a link (reducible) vs stay (anonymous)?
for (const t of [50, 100, 200]) {
  const idx = fieldCounts.map((c, i) => [c, i] as const).filter(([c]) => c > t);
  if (idx.length === 0) continue;
  const tot = idx.reduce((a, [c]) => a + c, 0);
  const red = idx.reduce((a, [, i]) => a + reducibles[i], 0);
  const residual = idx.map(([c, i]) => c - reducibles[i]);
  console.log(
    `large>${String(t).padEnd(3)}: ${idx.length} pages; mean fields=${(tot / idx.length).toFixed(0)} reducible=${((red / tot) * 100).toFixed(0)}% residual(after link-out) mean=${(residual.reduce((a, b) => a + b, 0) / residual.length).toFixed(0)} p95=${pct(residual, 95)} max=${Math.max(...residual)}`,
  );
}
