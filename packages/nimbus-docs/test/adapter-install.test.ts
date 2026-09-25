import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTER_IDS,
  ADAPTER_RECIPES,
  applyAdapterToConfig,
  alreadyWiredAdapterId,
  isCommonJsConfig,
} from "../src/_internal/adapters.js";

const STARTER_CONFIG = `import { defineConfig } from "astro/config";
import icon from "astro-icon";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";

const nimbusConfig = defineNimbusConfig({
  site: "https://example.com",
  title: "Nimbus",
});

export default defineConfig({
  // nimbus:adapter
  output: "static",
  integrations: [icon(), nimbus(nimbusConfig)],
});
`;

test("flips output and wires each adapter at the marker", () => {
  for (const id of ADAPTER_IDS) {
    const res = applyAdapterToConfig(STARTER_CONFIG, id);
    assert.equal(res.status, "applied", `${id} should apply`);
    if (res.status !== "applied") return;
    const recipe = ADAPTER_RECIPES[id];
    assert.match(res.source, /output:\s*"server"/, `${id} flips output`);
    assert.ok(!/output:\s*"static"/.test(res.source), `${id} removes static`);
    assert.ok(res.source.includes(recipe.importStatement), `${id} adds import`);
    assert.ok(
      res.source.includes(`adapter: ${recipe.adapterExpression},`),
      `${id} adds adapter field`,
    );
    if (id === "cloudflare") {
      assert.match(res.source, /rendering:\s*\{\s*default:\s*"request"/);
    } else {
      assert.doesNotMatch(res.source, /default:\s*"request"/);
    }
    // The adapter field lands directly after the output line.
    assert.match(
      res.source,
      new RegExp(
        `output:\\s*"server",\\n\\s*adapter: ${recipe.adapterExpression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`,
      ),
      `${id} places adapter after output`,
    );
  }
});

test("cloudflare recipe uses node prerender env and pins <14.2.0", () => {
  const cf = ADAPTER_RECIPES.cloudflare;
  assert.match(cf.adapterExpression, /prerenderEnvironment:\s*"node"/);
  assert.match(cf.installSpec, /<\s*14\.2\.0/);
});

test("cloudflare inserts request rendering in a semicolonless Nimbus config", () => {
  const cfg = `import { defineConfig } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs"

const nimbusConfig = defineNimbusConfig({
  site: "https://example.com",
  title: "Nimbus",
})

export default defineConfig({
  // nimbus:adapter
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  integrations: [nimbus(nimbusConfig)],
})
`;
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.match(result.source, /rendering: \{ default: "request" \},/);
  assert.doesNotMatch(result.source, /rendering:.*;/);
});

test("cloudflare inserts request rendering around nested spreads", () => {
  const cfg = `import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";

const versions: string[] = [];
const collectVersions = (...values: string[]) => values;
const nimbusConfig = defineNimbusConfig({
  site: "https://example.com",
  title: "Nimbus",
  versions: {
    current: "v1",
    others: [...versions, ...collectVersions(...versions)],
  },
});

export default defineConfig({
  // nimbus:adapter
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  integrations: [nimbus(nimbusConfig)],
});
`;
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.match(result.source, /rendering: \{ default: "request" \},/);
  assert.match(result.source, /others: \[\.\.\.versions, \.\.\.collectVersions\(\.\.\.versions\)\]/);
});

test("cloudflare preserves every explicit rendering policy", () => {
  for (const rendering of [
    'rendering: { default: "build" },',
    'rendering: { default: "build", collections: { docs: "request" } },',
  ]) {
    const cfg = STARTER_CONFIG.replace(
      '  site: "https://example.com",',
      `  ${rendering}\n  site: "https://example.com",`,
    );
    const result = applyAdapterToConfig(cfg, "cloudflare");
    assert.equal(result.status, "applied");
    if (result.status !== "applied") continue;
    assert.equal((result.source.match(/rendering:/g) ?? []).length, 1);
    assert.ok(result.source.includes(rendering));
    assert.doesNotMatch(result.source, /default:\s*"request"/);
  }
});

test("cloudflare request rendering insertion is idempotent", () => {
  const once = applyAdapterToConfig(STARTER_CONFIG, "cloudflare");
  assert.equal(once.status, "applied");
  if (once.status !== "applied") return;
  const twice = applyAdapterToConfig(once.source, "cloudflare");
  assert.equal(twice.status, "noop");
  if (twice.status !== "noop") return;
  assert.equal(twice.source, once.source);
  assert.equal((once.source.match(/rendering:/g) ?? []).length, 1);
});

test("cloudflare edits the Nimbus config used by the integration, not a decoy", () => {
  const cfg = STARTER_CONFIG.replace(
    "const nimbusConfig = defineNimbusConfig({",
    `const decoy = defineNimbusConfig({ title: "Unused", site: "https://unused.example.com" });

const nimbusConfig = defineNimbusConfig({`,
  );
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.doesNotMatch(
    result.source,
    /const decoy = defineNimbusConfig\(\{ rendering:/,
  );
  assert.match(
    result.source,
    /const nimbusConfig = defineNimbusConfig\(\{\n  rendering:/,
  );
});

test("cloudflare supports an inline Nimbus config and leading comments", () => {
  const cfg = `import { defineConfig } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs"

export default defineConfig({
  // nimbus:adapter
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  integrations: [
    nimbus(defineNimbusConfig({ // Preserve this comment
      site: "https://example.com",
      title: "Nimbus",
      versions: { others: [...versions] },
    })),
  ],
})
`;
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.match(result.source, /\{ \/\/ Preserve this comment\n      rendering:/);
});

test("cloudflare edits rendering in place on the api-reference recipe shape", () => {
  // The recipe adds `api` to the inline config instead of moving the config
  // into nimbus.config.ts, so the installer can still edit it.
  const cfg = STARTER_CONFIG.replace(
    '  title: "Nimbus",\n',
    `  title: "Nimbus",
  api: [
    { collection: "api", spec: "./src/api/openapi.yaml", label: "Example API" },
    { collection: "billing", versions: [{ id: "v2", spec: "./src/api/v2.yaml" }] },
  ],
`,
  );
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.equal(result.requestRendering, "inserted");
  assert.match(
    result.source,
    /const nimbusConfig = defineNimbusConfig\(\{\n  rendering: \{ default: "request" \},\n  site:/,
  );
  assert.equal((result.source.match(/rendering:/g) ?? []).length, 1);
  assert.ok(result.source.includes('{ collection: "api", spec: "./src/api/openapi.yaml"'));

  // Today's shape imports the config from nimbus.config.ts: nothing to edit.
  const imported = applyAdapterToConfig(
    STARTER_CONFIG.replace(
      /const nimbusConfig = defineNimbusConfig\(\{[\s\S]*?\}\);\n/,
      'import nimbusConfig from "./nimbus.config";\n',
    ),
    "cloudflare",
  );
  assert.equal(imported.status, "applied");
  if (imported.status !== "applied") return;
  assert.notEqual(imported.requestRendering, "inserted");
  assert.doesNotMatch(imported.source, /default:\s*"request"/);
});

test("cloudflare leaves spread-provided rendering unresolved", () => {
  const cfg = STARTER_CONFIG.replace(
    '  site: "https://example.com",',
    '  ...sharedConfig,\n  site: "https://example.com",',
  );
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.equal(result.requestRendering, "unresolved");
  assert.doesNotMatch(result.source, /default:\s*"request"/);
});

test("cloudflare evaluates spread overrides in object execution order", () => {
  const finalExplicit = STARTER_CONFIG.replace(
    '  site: "https://example.com",',
    '  ...sharedConfig,\n  rendering: { default: "build" },\n  site: "https://example.com",',
  );
  const preserved = applyAdapterToConfig(finalExplicit, "cloudflare");
  assert.equal(preserved.status, "applied");
  if (preserved.status === "applied") {
    assert.equal(preserved.requestRendering, "explicit");
    assert.doesNotMatch(preserved.source, /default:\s*"request"/);
  }

  const finalSpread = STARTER_CONFIG.replace(
    '  site: "https://example.com",',
    '  rendering: { default: "build" },\n  ...sharedConfig,\n  site: "https://example.com",',
  );
  const unresolved = applyAdapterToConfig(finalSpread, "cloudflare");
  assert.equal(unresolved.status, "applied");
  if (unresolved.status === "applied") {
    assert.equal(unresolved.requestRendering, "unresolved");
    assert.doesNotMatch(unresolved.source, /default:\s*"request"/);
  }
});

test("cloudflare leaves mutable or additionally referenced config bindings unresolved", () => {
  for (const cfg of [
    STARTER_CONFIG.replace("const nimbusConfig", "let nimbusConfig"),
    STARTER_CONFIG.replace(
      "export default defineConfig({",
      "nimbusConfig.title = title;\n\nexport default defineConfig({",
    ),
  ]) {
    const result = applyAdapterToConfig(cfg, "cloudflare");
    assert.equal(result.status, "applied");
    if (result.status !== "applied") continue;
    assert.equal(result.requestRendering, "unresolved");
    assert.doesNotMatch(result.source, /default:\s*"request"/);
  }
});

test("cloudflare ignores block-scoped shadows of the Nimbus integration", () => {
  const cfg = STARTER_CONFIG.replace(
    "const nimbusConfig = defineNimbusConfig({",
    "const decoyConfig = defineNimbusConfig({",
  )
    .replace(
      "export default defineConfig({",
      `{
  const nimbus = (config: unknown) => config;
  nimbus(decoyConfig);
}

export default defineConfig({`,
    )
    .replace("integrations: [icon(), nimbus(nimbusConfig)]", "integrations: [icon()]");
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.equal(result.requestRendering, "unresolved");
  assert.doesNotMatch(result.source, /default:\s*"request"/);
});

test("cloudflare ignores loop-scoped shadows outside the Astro config", () => {
  const cfg = STARTER_CONFIG.replace(
    "const nimbusConfig = defineNimbusConfig({",
    "const decoyConfig = defineNimbusConfig({",
  )
    .replace(
      "export default defineConfig({",
      `for (const nimbus of integrations) {
  nimbus(decoyConfig);
}

export default defineConfig({`,
    )
    .replace("integrations: [icon(), nimbus(nimbusConfig)]", "integrations: [icon()]");
  const result = applyAdapterToConfig(cfg, "cloudflare");
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.equal(result.requestRendering, "unresolved");
  assert.doesNotMatch(result.source, /default:\s*"request"/);
});

test("netlify relies on the adapter's own blobs dependency", () => {
  assert.deepEqual(ADAPTER_RECIPES.netlify.extraDeps, []);
});

test("is idempotent: re-running the same adapter is a no-op", () => {
  const once = applyAdapterToConfig(STARTER_CONFIG, "vercel");
  assert.equal(once.status, "applied");
  if (once.status !== "applied") return;
  const twice = applyAdapterToConfig(once.source, "vercel");
  assert.equal(twice.status, "noop", "second run is a no-op");
  if (twice.status !== "noop") return;
  assert.equal(twice.source, once.source, "no duplicate imports/config");
  // Exactly one import + one adapter field.
  assert.equal((once.source.match(/@astrojs\/vercel/g) ?? []).length, 1);
  assert.equal((once.source.match(/adapter:/g) ?? []).length, 1);
});

test("is conflict-aware: refuses to swap a different adapter", () => {
  const withVercel = applyAdapterToConfig(STARTER_CONFIG, "vercel");
  assert.equal(withVercel.status, "applied");
  if (withVercel.status !== "applied") return;
  const swap = applyAdapterToConfig(withVercel.source, "node");
  assert.equal(swap.status, "error");
  if (swap.status !== "error") return;
  assert.equal(swap.code, "existing-adapter");
  assert.match(swap.message, /already wires a different adapter/);
});

test("errors on a missing marker", () => {
  const noMarker = STARTER_CONFIG.replace("  // nimbus:adapter\n", "");
  const res = applyAdapterToConfig(noMarker, "vercel");
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "missing-marker");
});

test("errors on a non-literal (dirty) output value", () => {
  const dirty = STARTER_CONFIG.replace('output: "static"', "output: mode");
  const res = applyAdapterToConfig(dirty, "vercel");
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "dirty-output");
});

test("does not match a `//` inside a string as the marker", () => {
  const tricky = STARTER_CONFIG.replace(
    'site: "https://example.com",',
    'site: "https://example.com", // real comment, not the marker\n  note: "no // nimbus:adapter here",',
  );
  // The genuine marker is still present, so this still applies; the point is
  // the string-embedded token doesn't corrupt offset math.
  const res = applyAdapterToConfig(tricky, "vercel");
  assert.equal(res.status, "applied");
});

test("inserts the import after a MULTI-LINE import without splitting it (C1)", () => {
  const cfg = `import { defineConfig } from "astro/config";
import {
  foo,
  bar,
} from "./stuff";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // The multi-line import must remain intact and contiguous.
  assert.match(res.source, /import \{\n {2}foo,\n {2}bar,\n\} from ".\/stuff";/);
  // The new import lands after it, on its own line.
  assert.match(res.source, /\} from ".\/stuff";\nimport vercel from "@astrojs\/vercel";/);
});

test("keeps a hashbang as the first line when inserting the first import", () => {
  const cfg = `#!/usr/bin/env node
export default {
  // nimbus:adapter
  output: "static",
};
`;
  const res = applyAdapterToConfig(cfg, "node");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /^#!\/usr\/bin\/env node\nimport \w+ from "@astrojs\/node";/);
});

test("a same-line comment quoting an adapter pkg doesn't spoof conflict detection (F1)", () => {
  // The import range spans same-line comments; reading the specifier from the
  // raw slice would let `// from "@astrojs/vercel"` masquerade as a real vercel
  // import and wire `adapter: foo()` (or falsely report an existing adapter).
  const cfg = `import { defineConfig } from "astro/config";
import foo from "./foo"; // from "@astrojs/vercel"

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied", "commented pkg must not read as an existing adapter");
  if (res.status !== "applied") return;
  assert.ok(res.source.includes(`import vercel from "@astrojs/vercel";`), "real import added");
  assert.match(res.source, /adapter: vercel\(\)/, "wires the real binding, not `foo`");
});

test("a dynamic `import (…)` is not treated as a static import opener (F2)", () => {
  // The space-tolerant opener would otherwise splice the new static import
  // inside the arrow body, producing an illegal nested import.
  const cfg = `import { defineConfig } from "astro/config";
const load = () => import ("./lazy");

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /=> import \("\.\/lazy"\);/, "dynamic import left intact");
  assert.doesNotMatch(res.source, /import \("\.\/lazy"\);\s*import vercel/, "no import spliced inside the arrow");
});

test("a string-literal named import doesn't shift the statement end (F3)", () => {
  // The specifier is the first brace-depth-0 string; a `{ "x" as y }` name sits
  // at depth > 0, so it must not be mistaken for the module specifier when
  // locating the statement end / insertion point.
  const cfg = `import { defineConfig } from "astro/config";
import { "strange-name" as sn, normal } from "./mod";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /import \{ "strange-name" as sn, normal \} from ".\/mod";/, "named import intact");
  assert.match(res.source, /from ".\/mod";\nimport vercel from "@astrojs\/vercel";/, "new import lands after it");
});

test("an inline type-only import of an adapter pkg is not a real value import (F-med)", () => {
  // `import { type X } from "@astrojs/vercel"` binds nothing at runtime, so it
  // must not trip conflict detection when installing a different adapter.
  const cfg = `import { defineConfig } from "astro/config";
import { type AstroAdapter } from "@astrojs/vercel";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "node");
  assert.equal(res.status, "applied", "type-only import must not read as an existing adapter");
  if (res.status !== "applied") return;
  assert.ok(res.source.includes(ADAPTER_RECIPES.node.importStatement), "node import added");
});

test("a mixed named import with a value specifier still counts as a real import (F-med)", () => {
  // At least one non-type specifier → a runtime binding → genuine conflict.
  const cfg = `import { defineConfig } from "astro/config";
import { type AstroAdapter, default as vercel } from "@astrojs/vercel";

export default defineConfig({
  adapter: vercel(),
  // nimbus:adapter
  output: "server",
});
`;
  const res = applyAdapterToConfig(cfg, "node");
  assert.equal(res.status, "error", "value binding of a different adapter must block");
  if (res.status !== "error") return;
  assert.equal(res.code, "existing-adapter");
});

test("a regex literal containing a quote doesn't corrupt output detection (M1)", () => {
  // The quote-bearing regex sits BEFORE the marker/output: if the masker
  // mistook the regex's `'` for a string open, it would swallow the marker and
  // `output:`, flipping this to a missing-marker/no-output error.
  const cfg = `import { defineConfig } from "astro/config";

export default defineConfig({
  vite: { define: { RE: /it's-fine/ } },
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied", "regex quote must not mask out `output:`");
  if (res.status !== "applied") return;
  assert.match(res.source, /output:\s*"server"/);
  assert.match(res.source, /\/it's-fine\//, "regex literal left intact");
});

test("division after a string is not misread as a regex (M-1 prevSig)", () => {
  // If `prevSig` stayed stale (`=`) after the string closed, the `/` would open
  // a regex and swallow the marker + output: that follow.
  const cfg = `import { defineConfig } from "astro/config";

const ratio = "10" / 2;

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
});

test("a commented-out copy of the SAME import is not treated as present (C-1)", () => {
  // The M2 fix routes execution into insertImport here; a raw `includes` dedupe
  // would match the comment and silently skip the real import, emitting a
  // server config whose only `vercel` binding is in a comment.
  const cfg = `import { defineConfig } from "astro/config";
// import vercel from "@astrojs/vercel";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // A REAL (non-comment) import must have been inserted — exactly one such line.
  const realImports = res.source
    .split("\n")
    .filter((l) => /^import vercel from "@astrojs\/vercel";/.test(l));
  assert.equal(realImports.length, 1, "the real import must be inserted, not skipped");
  assert.match(res.source, /adapter: vercel\(\),/);
});

test("an unrelated `adapter:` key does not trip existing-adapter (M2)", () => {
  const cfg = `import { defineConfig } from "astro/config";
import somePlugin from "some-plugin";

export default defineConfig({
  // nimbus:adapter
  output: "static",
  integrations: [somePlugin({ adapter: "not-an-astro-adapter" })],
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
});

test("a commented-out adapter import does not count as wired (M2)", () => {
  const cfg = `import { defineConfig } from "astro/config";
// import vercel from "@astrojs/vercel";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "node");
  assert.equal(res.status, "applied", "commented import must not block a different adapter");
});

test("detects a non-default import form of an adapter (M2 idempotency)", () => {
  const cfg = `import { defineConfig } from "astro/config";
import { default as vercel } from "@astrojs/vercel";

export default defineConfig({
  // nimbus:adapter
  output: "server",
  adapter: vercel(),
});
`;
  // Re-running vercel must be a no-op even with a non-default import clause.
  const same = applyAdapterToConfig(cfg, "vercel");
  assert.equal(same.status, "noop");
  // And a different adapter must be refused, not duplicated.
  const other = applyAdapterToConfig(cfg, "node");
  assert.equal(other.status, "error");
  if (other.status !== "error") return;
  assert.equal(other.code, "existing-adapter");
});

test("wires adapter when output was already flipped to server without an adapter", () => {
  const serverNoAdapter = STARTER_CONFIG.replace('output: "static"', 'output: "server"');
  const res = applyAdapterToConfig(serverNoAdapter, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(res.source.includes("adapter: vercel()"));
  assert.equal(alreadyWiredAdapterId(res.source), "vercel");
});

test("does not treat an adapter import alone as already wired", () => {
  const importedOnly = STARTER_CONFIG.replace(
    'import icon from "astro-icon";\n',
    'import icon from "astro-icon";\nimport vercel from "@astrojs/vercel";\n',
  );
  const res = applyAdapterToConfig(importedOnly, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /output:\s*"server"/);
  assert.match(res.source, /adapter: vercel\(\),/);
  assert.equal((res.source.match(/import vercel from "@astrojs\/vercel";/g) ?? []).length, 1);
});

test("uses an existing same-adapter import when output is server but adapter is missing", () => {
  const importedServer = STARTER_CONFIG.replace(
    'import icon from "astro-icon";\n',
    'import icon from "astro-icon";\nimport vercel from "@astrojs/vercel";\n',
  ).replace('output: "static"', 'output: "server"');
  const res = applyAdapterToConfig(importedServer, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /adapter: vercel\(\),/);
  assert.equal((res.source.match(/import vercel from "@astrojs\/vercel";/g) ?? []).length, 1);
});

test("refuses an existing top-level adapter field from an unknown package", () => {
  const custom = STARTER_CONFIG.replace(
    'output: "static",',
    'output: "server",\n  adapter: customAdapter(),',
  );
  const res = applyAdapterToConfig(custom, "vercel");
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "existing-adapter");
});

test("uses an aliased same-adapter default import instead of emitting an unbound name", () => {
  const aliased = STARTER_CONFIG.replace(
    'import icon from "astro-icon";\n',
    'import icon from "astro-icon";\nimport v from "@astrojs/vercel";\n',
  ).replace('output: "static"', 'output: "server"');
  const res = applyAdapterToConfig(aliased, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /adapter: v\(\),/);
  assert.doesNotMatch(res.source, /adapter: vercel\(\),/);
});

test("ignores type-only adapter imports and inserts a real value import", () => {
  const typeOnly = STARTER_CONFIG.replace(
    'import icon from "astro-icon";\n',
    'import icon from "astro-icon";\nimport type { VercelOptions } from "@astrojs/vercel";\n',
  );
  const res = applyAdapterToConfig(typeOnly, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /import vercel from "@astrojs\/vercel";/);
  assert.match(res.source, /adapter: vercel\(\),/);
});

test("recognizes an existing adapter field before the marker as already wired", () => {
  const beforeMarker = STARTER_CONFIG.replace(
    'import icon from "astro-icon";\n',
    'import icon from "astro-icon";\nimport vercel from "@astrojs/vercel";\n',
  ).replace(
    '  // nimbus:adapter\n  output: "static",',
    '  adapter: vercel(),\n  // nimbus:adapter\n  output: "server",',
  );
  const res = applyAdapterToConfig(beforeMarker, "vercel");
  assert.equal(res.status, "noop");
  if (res.status !== "noop") return;
  assert.equal((res.source.match(/adapter:/g) ?? []).length, 1);
});

test("refuses an unknown adapter field before the marker", () => {
  const beforeMarker = STARTER_CONFIG.replace(
    '  // nimbus:adapter\n  output: "static",',
    '  adapter: customAdapter(),\n  // nimbus:adapter\n  output: "server",',
  );
  const res = applyAdapterToConfig(beforeMarker, "vercel");
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "existing-adapter");
});

test("a regex character class containing slash and quote doesn't hide the marker", () => {
  const cfg = `import { defineConfig } from "astro/config";

const re = /[/']/;

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /output:\s*"server"/);
});

test("comma-terminates an output-last config so the inserted adapter is valid JS", () => {
  const cfg = `import { defineConfig } from "astro/config";

export default defineConfig({
  // nimbus:adapter
  output: "static"
});
`;
  const res = applyAdapterToConfig(cfg, "node");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /output:\s*"server",\n\s*adapter: node\(\{ mode: "standalone" \}\),/);
});

test("does not double-comma an output that already has a trailing comma", () => {
  const res = applyAdapterToConfig(STARTER_CONFIG, "node");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(!/"server",\s*,/.test(res.source), "no dangling double comma");
});

test("refuses a same-package adapter imported without a default binding (namespace)", () => {
  const cfg = `import { defineConfig } from "astro/config";
import * as vercel from "@astrojs/vercel";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "existing-adapter");
  assert.match(res.message, /without a default binding/);
});

test("treats `return /re/` as a regex, not division, when masking the marker", () => {
  const cfg = `import { defineConfig } from "astro/config";

function slugify(s) {
  return /["']/.test(s) ? "" : s;
}

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /output:\s*"server"/);
});

test("handles an indented import when finding the insertion point", () => {
  const cfg = `import { defineConfig } from "astro/config";
  import nimbus from "@cloudflare/nimbus-docs";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(res.source.includes('import vercel from "@astrojs/vercel";'));
});

test("isCommonJsConfig flags module.exports/require/exports. but not ESM", () => {
  assert.equal(
    isCommonJsConfig(`const { defineConfig } = require("astro/config");\nmodule.exports = defineConfig({});\n`),
    true,
  );
  assert.equal(isCommonJsConfig(`exports.default = { output: "static" };\n`), true);
  assert.equal(isCommonJsConfig(STARTER_CONFIG), false);
  assert.equal(
    isCommonJsConfig(`import { value } from "pkg";\nmodule.exports = {};\n`),
    false,
  );
  assert.equal(
    isCommonJsConfig(`export const value = 1;\nmodule.exports = {};\n`),
    false,
  );
  // ESM with a dynamic import() is not CommonJS.
  assert.equal(
    isCommonJsConfig(`export default (async () => (await import("x")).cfg)();\n`),
    false,
  );
});

test("applyAdapterToConfig refuses CommonJS source", () => {
  const cfg = `const { defineConfig } = require("astro/config");
module.exports = defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "error");
  if (res.status !== "error") return;
  assert.equal(res.code, "cjs-config");
});

test("applies through a trailing comment after the output value (comment-aware value)", () => {
  for (const cfg of [
    `import { defineConfig } from "astro/config";\nexport default defineConfig({\n  // nimbus:adapter\n  output: "static" /* keep */,\n});\n`,
    `import { defineConfig } from "astro/config";\nexport default defineConfig({\n  // nimbus:adapter\n  output: "static" // trailing\n});\n`,
    `import { defineConfig } from "astro/config";\nexport default defineConfig({\n  // nimbus:adapter\n  output: "static" /* a, b */\n});\n`,
  ]) {
    const res = applyAdapterToConfig(cfg, "vercel");
    assert.equal(res.status, "applied", cfg);
    if (res.status !== "applied") return;
    assert.match(res.source, /output:\s*"server"/);
    assert.match(res.source, /adapter: vercel\(\),/);
  }
});

test("aliases the adapter import when the recipe name is already bound", () => {
  const cfg = `import { defineConfig } from "astro/config";
import vercel from "./vercel-env";

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // The local `vercel` binding is untouched; the adapter is imported+wired under an alias.
  assert.ok(res.source.includes('import vercel from "./vercel-env";'));
  assert.ok(res.source.includes('import vercelAdapter from "@astrojs/vercel";'));
  assert.match(res.source, /adapter: vercelAdapter\(\),/);
  // Exactly one binding named plain `vercel` (the pre-existing local one).
  assert.equal((res.source.match(/\bimport vercel from\b/g) ?? []).length, 1);
});

test("aliases around a top-level const/function binding, not just imports", () => {
  const cfg = `import { defineConfig } from "astro/config";

const vercel = process.env.VERCEL;
function node() {}

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const v = applyAdapterToConfig(cfg, "vercel");
  assert.equal(v.status, "applied");
  if (v.status !== "applied") return;
  assert.ok(v.source.includes('import vercelAdapter from "@astrojs/vercel";'));
  assert.match(v.source, /adapter: vercelAdapter\(\),/);

  const n = applyAdapterToConfig(cfg, "node");
  assert.equal(n.status, "applied");
  if (n.status !== "applied") return;
  assert.ok(n.source.includes('import nodeAdapter from "@astrojs/node";'));
  assert.match(n.source, /adapter: nodeAdapter\(\{ mode: "standalone" \}\),/);
});

test("aliases around destructuring, comma declarators, and spaced generators", () => {
  const cases: Array<[string, string]> = [
    ["vercel", "const { vercel } = process.env;"],
    ["vercel", "const foo = 1, vercel = 2;"],
    ["vercel", "function * vercel() {}"],
  ];
  for (const [id, decl] of cases) {
    const cfg = `import { defineConfig } from "astro/config";

${decl}

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
    const res = applyAdapterToConfig(cfg, id as "vercel");
    assert.equal(res.status, "applied", decl);
    if (res.status !== "applied") return;
    assert.ok(
      res.source.includes('import vercelAdapter from "@astrojs/vercel";'),
      `should alias around: ${decl}`,
    );
    assert.match(res.source, /adapter: vercelAdapter\(\),/);
    assert.equal((res.source.match(/\bimport vercel from\b/g) ?? []).length, 0);
  }
});

test("a recipe name appearing only in a string or comment does not force an alias", () => {
  const cfg = `import { defineConfig } from "astro/config";
// vercel is our host
const note = "deploy to vercel";
export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(res.source.includes('import vercel from "@astrojs/vercel";'));
  assert.match(res.source, /adapter: vercel\(\),/);
  assert.ok(!res.source.includes("vercelAdapter"), "must not alias for a string/comment token");
});

test("import attributes with `with` and `{` split across lines are kept whole", () => {
  const cfg = `import { defineConfig } from "astro/config";
import data from "./data.json" with
{ type: "json" };

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // The new import goes after the whole attributes clause, never between `with` and `{`.
  assert.match(res.source, /\{ type: "json" \};\nimport vercel from "@astrojs\/vercel";/);
});

test("import attributes with `with` on the line after the specifier are kept whole", () => {
  const cfg = `import { defineConfig } from "astro/config";
import data from "./data.json"
  with { type: "json" };

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // Inserted after the whole declaration, never between the specifier and `with`.
  assert.match(res.source, /with \{ type: "json" \};\nimport vercel from "@astrojs\/vercel";/);
});

test("a following `assert(x)` call is NOT absorbed as an import attributes clause", () => {
  const cfg = `import { defineConfig } from "astro/config";
import data from "./data.json";
assert(data);

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // The new import lands right after the data import, before the assert() statement.
  assert.match(res.source, /import data from "\.\/data\.json";\nimport vercel from "@astrojs\/vercel";\nassert\(data\);/);
});

test("a trailing MULTI-LINE block comment does not swallow the inserted adapter", () => {
  const cfg = `import { defineConfig } from "astro/config";

export default defineConfig({
  // nimbus:adapter
  output: "static" /* keep
     explaining */
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // The adapter line lands before the block comment, not inside it.
  assert.match(res.source, /output:\s*"server",\n\s*adapter: vercel\(\),/);
  const adapterIdx = res.source.indexOf("adapter: vercel()");
  const commentOpen = res.source.indexOf("/* keep");
  assert.ok(adapterIdx < commentOpen, "adapter must precede the block comment");
});

test("inserting an import does not split an import-attributes declaration", () => {
  const cfg = `import { defineConfig } from "astro/config";
import data from "./data.json" with {
  type: "json"
};

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  // The new import goes after the full `with { … }` block, not inside it.
  assert.match(
    res.source,
    /with \{\n\s*type: "json"\n\};\nimport vercel from "@astrojs\/vercel";/,
  );
});

test("a reserved word used as a property key before `/` is division, not a regex", () => {
  const cfg = `import { defineConfig } from "astro/config";

const q = { in: 4 };
const half = q.in / 2;

export default defineConfig({
  // nimbus:adapter
  output: "static",
});
`;
  const res = applyAdapterToConfig(cfg, "vercel");
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.source, /output:\s*"server"/);
});
