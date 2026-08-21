// Parser externality. The heavy OpenAPI tooling (`@scalar/openapi-parser`,
// `@readme/httpsnippet`, `openapi-sampler`) is optional: a prose-only site must
// never resolve or install it. Two things enforce that, and this suite asserts
// both so a regression can't quietly pull the parser into the static graph:
//
//   1. Manifest — the three packages are declared as OPTIONAL peer dependencies,
//      never `dependencies`/`optionalDependencies`, so `npm install nimbus-docs`
//      in a prose project pulls none of them.
//   2. Source graph — no module under `src/` statically imports them. The engine
//      reaches them only through a computed-specifier `await import(...)`
//      (`parse.ts` / `samples.ts`), which the bundler cannot hoist, so a
//      prose-only build's graph excludes them.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OPTIONAL_TOOLING = [
  "@scalar/openapi-parser",
  "@readme/httpsnippet",
  "openapi-sampler",
] as const;

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** A static binding to `spec` — `import … from "spec"`, bare `import "spec"`,
 *  `export … from "spec"`, or a literal `import("spec")` / `require("spec")`.
 *  A computed `await import(specifier)` (the lazy path) matches none of these.
 *  Matches subpath forms too (`"spec/dist/x.js"`), which bundle the package just
 *  the same. `import type` is intentionally NOT excluded: the engine declares
 *  local interfaces instead of importing the parser's types, so even a type
 *  import here is a regression worth flagging. */
function staticallyImports(source: string, spec: string): boolean {
  const q = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:/[^'\"]*)?";
  const patterns = [
    new RegExp(`\\bfrom\\s+['"]${q}['"]`),
    new RegExp(`\\bimport\\s+['"]${q}['"]`),
    new RegExp(`\\bimport\\s*\\(\\s*['"]${q}['"]\\s*\\)`),
    new RegExp(`\\brequire\\s*\\(\\s*['"]${q}['"]\\s*\\)`),
  ];
  return patterns.some((re) => re.test(source));
}

describe("api parser externality", () => {
  test("optional tooling is an optional peer, never a hard dependency", () => {
    for (const dep of OPTIONAL_TOOLING) {
      assert.ok(
        !(pkg.dependencies && dep in pkg.dependencies),
        `${dep} must not be in "dependencies" (prose-only installs would pull it)`,
      );
      assert.ok(
        !(pkg.optionalDependencies && dep in pkg.optionalDependencies),
        `${dep} must not be in "optionalDependencies" — it is a peer`,
      );
      assert.ok(
        pkg.peerDependencies && dep in pkg.peerDependencies,
        `${dep} must be declared in "peerDependencies"`,
      );
      assert.equal(
        pkg.peerDependenciesMeta?.[dep]?.optional,
        true,
        `${dep} must be marked optional in "peerDependenciesMeta"`,
      );
    }
  });

  test("no module under src/ statically imports the optional tooling", () => {
    const files = collectTsFiles(SRC_ROOT);
    assert.ok(files.length > 0, "expected to scan some source files");
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const dep of OPTIONAL_TOOLING) {
        if (staticallyImports(source, dep)) {
          offenders.push(`${file.slice(SRC_ROOT.length + 1)} → ${dep}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `optional tooling must be reached only via a lazy computed import; static imports found:\n${offenders.join("\n")}`,
    );
  });

  // Pin the lazy indirection for every optional dep: a variable specifier fed to
  // a `/* @vite-ignore */` dynamic import. This is what keeps each module out of
  // the static graph; if any becomes a literal import the scan above fails, and
  // if the `@vite-ignore` marker is dropped the bundler could hoist it, so both
  // the variable and the marked dynamic import are asserted per file.
  const LAZY_SITES = [
    { file: "../src/_internal/api/parse.ts", specifierVar: "specifier", packageName: "@scalar/openapi-parser" },
    { file: "../src/_internal/api/samples.ts", specifierVar: "samplerSpec", packageName: "openapi-sampler" },
    { file: "../src/_internal/api/samples.ts", specifierVar: "snippetSpec", packageName: "@readme/httpsnippet" },
  ] as const;

  for (const { file, specifierVar, packageName } of LAZY_SITES) {
    test(`${packageName} is reached through a lazy computed specifier`, () => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      const q = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(
        src,
        new RegExp(`const\\s+${specifierVar}\\s*=\\s*["']${q}["']`),
        `${file} should assign the ${packageName} specifier to a variable`,
      );
      assert.match(
        src,
        new RegExp(`await\\s+import\\(\\s*\\/\\*[^*]*\\*\\/\\s*${specifierVar}\\s*\\)`),
        `${file} should dynamically import via the computed ${specifierVar}`,
      );
    });
  }
});
