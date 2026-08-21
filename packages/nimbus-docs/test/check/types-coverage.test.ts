import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkTypes } from "../../src/check/types.js";
import { deriveScopeStatus } from "../../src/check/finding.js";

const TS_PKG_DIR = path.resolve(
  path.dirname(createRequire(import.meta.url).resolve("typescript")),
  "..",
);

interface ProjectOpts {
  tsconfig?: boolean;
  astroTypes?: boolean;
  typescript?: boolean;
  body?: string;
}

function project(opts: ProjectOpts = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-types-"));
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    opts.body ?? "export const n: number = 1;\n",
  );
  if (opts.tsconfig !== false) {
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          strict: true,
          target: "esnext",
          types: [],
        },
        include: ["index.ts"],
      }),
    );
  }
  if (opts.astroTypes !== false) {
    fs.mkdirSync(path.join(dir, ".astro"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".astro", "types.d.ts"), "");
  }
  if (opts.typescript !== false) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.symlinkSync(TS_PKG_DIR, path.join(dir, "node_modules", "typescript"), "dir");
  }
  return dir;
}

const NOT_EVAL = "nimbus/types-not-evaluated";

test("no tsconfig.json → whole-scope not_evaluated (not a false pass)", () => {
  const dir = project({ tsconfig: false });
  try {
    const r = checkTypes(dir);
    assert.equal(r.evaluated, false);
    assert.equal(deriveScopeStatus(r), "not_evaluated");
    assert.deepEqual(r.findings, []);
    assert.equal(r.notes[0]?.code, NOT_EVAL);
    assert.match(r.reason ?? "", /tsconfig\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("typescript not installed → not_evaluated", () => {
  const dir = project({ typescript: false });
  try {
    const r = checkTypes(dir);
    assert.equal(r.evaluated, false);
    assert.match(r.reason ?? "", /typescript/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no .astro/types.d.ts → not_evaluated with requiresBuild note (won't fabricate the artifact)", () => {
  const dir = project({ astroTypes: false });
  try {
    const r = checkTypes(dir);
    assert.equal(r.evaluated, false);
    assert.equal(r.notes[0]?.requiresBuild, true);
    assert.match(r.reason ?? "", /\.astro\/types\.d\.ts/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// By spec, file-absent is the ONLY whole-scope not_evaluated
// trigger. Once .astro/types.d.ts EXISTS (here, empty/stale), an unresolved
// astro:* import is a real finding, never a scope-blanking bail.
test("present-but-empty .astro/types.d.ts + astro:content import → evaluated, unresolved import is a ts/2307 finding", () => {
  const dir = project({
    body: 'import { getCollection } from "astro:content";\nexport const x = getCollection;\n',
  });
  try {
    const r = checkTypes(dir);
    assert.equal(r.evaluated, true, "the artifact exists — the scope is evaluated, not blanked");
    assert.ok(
      r.findings.some((f) => f.code === "ts/2307"),
      "the unresolved astro:content surfaces as its own finding",
    );
    assert.ok(!r.notes.some((n) => n.code === NOT_EVAL));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed tsconfig.json pre-build → tsconfig-invalid finding, not a coverage gap", () => {
  const dir = project({ astroTypes: false });
  try {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), '{ "compilerOptions": { ');
    const r = checkTypes(dir);
    assert.equal(r.evaluated, true, "a broken config is evaluated, not a gap");
    assert.ok(r.findings.some((f) => f.code === "nimbus/tsconfig-invalid" && f.severity === "error"));
    assert.ok(!r.notes.some((n) => n.code === NOT_EVAL));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clean project → evaluated, no findings (Types ✓)", () => {
  const dir = project({ body: "export const n: number = 1;\n" });
  try {
    const r = checkTypes(dir);
    assert.equal(r.evaluated, true);
    assert.equal(deriveScopeStatus(r), "passed");
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a .ts re-exporting a .astro component is not false-flagged as a missing module", () => {
  const dir = project({
    body: 'export { default as Foo } from "./Foo.astro";\n',
  });
  try {
    fs.writeFileSync(path.join(dir, "Foo.astro"), "");
    const r = checkTypes(dir);
    assert.ok(
      !r.findings.some((f) => f.code === "ts/2307"),
      "the .astro import must resolve via the ambient shim, not error",
    );
    assert.equal(r.evaluated, true);
    assert.deepEqual(r.findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a real type error is caught as an error-severity finding with file/line", () => {
  const dir = project({ body: 'export const n: number = "not a number";\n' });
  try {
    const r = checkTypes(dir);
    const err = r.findings.find((f) => f.scope === "types" && f.severity === "error");
    assert.ok(err, "the assignability error must surface");
    assert.equal(err.code, "ts/2322");
    assert.equal(err.file, "index.ts");
    assert.equal(err.line, 1);
    assert.equal(err.fixable, false);
    assert.equal(r.evaluated, true);
    assert.ok(!r.notes.some((n) => n.code === NOT_EVAL));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A coverage gap must never blank an evaluated error. With types.d.ts
// present, an UNKNOWN astro:* specifier is a user typo (a real ts/2307), not a
// staleness signal — it must coexist with an independent ts/2322, and the scope
// must stay evaluated rather than collapsing to types-not-evaluated alone.
test("typoed astro:contennt + a TS2322 → both surface, evaluated, never types-not-evaluated alone", () => {
  const dir = project({
    body:
      'import { getCollection } from "astro:contennt";\n' +
      "export const use = getCollection;\n" +
      'export const n: number = "not a number";\n',
  });
  try {
    const r = checkTypes(dir);
    assert.equal(r.evaluated, true, "a typo is not staleness — the scope was evaluated");
    assert.ok(
      r.findings.some((f) => f.code === "ts/2322"),
      "the independent assignability error must survive",
    );
    assert.ok(
      r.findings.some((f) => f.code === "ts/2307"),
      "the unresolved unknown astro:* specifier surfaces as its own finding",
    );
    assert.ok(
      !r.notes.some((n) => n.code === NOT_EVAL),
      "must not fall back to the whole-scope not-evaluated note",
    );
    assert.equal(deriveScopeStatus(r), "failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
