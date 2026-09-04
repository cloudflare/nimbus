import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parseNimbusConfig,
  evaluateLiteral,
  rewriteConfigField,
  type ConfigParseResult,
} from "../../src/_internal/parse-nimbus-config.js";

function withConfig<T>(
  source: string,
  body: (dir: string) => T,
  filename = "astro.config.ts",
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cfg-"));
  fs.writeFileSync(path.join(dir, filename), source);
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parse(source: string, filename?: string): ConfigParseResult {
  return withConfig(source, (dir) => parseNimbusConfig(dir), filename);
}

function withProject<T>(files: Record<string, string>, body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cfg-"));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ok(result: ConfigParseResult) {
  assert.ok(result.ok, `expected ok, got ${result.ok ? "" : result.reason}`);
  return result as Extract<ConfigParseResult, { ok: true }>;
}

const IMPORT = `import nimbus from "@cloudflare/nimbus-docs";`;
const WRAP_IMPORT = `import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";`;

test("inline object literal resolves site and title", () => {
  const r = ok(
    parse(`${IMPORT}
export default { integrations: [nimbus({ site: "https://x.dev", title: "X" })] };`),
  );
  assert.equal(r.config.site, "https://x.dev");
  assert.equal(r.config.title, "X");
  assert.equal(r.unresolved.length, 0);
  assert.ok(r.location.fields.has("site"));
});

test("single-arg defineNimbusConfig wrapper resolves", () => {
  const r = ok(
    parse(`${WRAP_IMPORT}
const cfg = defineNimbusConfig({ site: "https://x.dev", title: "X" });
export default { integrations: [nimbus(cfg)] };`),
  );
  assert.equal(r.config.site, "https://x.dev");
});

test("const reference to a plain object resolves", () => {
  const r = ok(
    parse(`${IMPORT}
const cfg = { site: "https://x.dev", title: "X" };
export default { integrations: [nimbus(cfg)] };`),
  );
  assert.equal(r.config.title, "X");
});

test("follows one relative default import and owns the imported spans", () => {
  withProject(
    {
      "astro.config.ts": `${IMPORT}
import nimbusConfig from "./config/nimbus.config";
export default { integrations: [nimbus(nimbusConfig)] };`,
      "config/nimbus.config.ts": `import { defineConfig } from "@cloudflare/nimbus-docs/config";
const config = { site: "https://x.dev", title: "X" };
export default defineConfig(config);`,
    },
    (dir) => {
      const r = ok(parseNimbusConfig(dir));
      assert.equal(r.config.site, "https://x.dev");
      assert.equal(r.location.file, path.join(dir, "config/nimbus.config.ts"));
      assert.match(r.location.source, /const config/);
      assert.equal(r.location.source.slice(r.location.objectStart, r.location.objectEnd + 1), `{ site: "https://x.dev", title: "X" }`);
    },
  );
});

test("follows a semicolonless imported const config", () => {
  withProject(
    {
      "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts"\nexport default { integrations: [nimbus(config)] }`,
      "nimbus.config.ts": `const config = { site: "https://x.dev" }\nexport default config`,
    },
    (dir) => assert.equal(ok(parseNimbusConfig(dir)).config.site, "https://x.dev"),
  );
});

test("rejects mutable and subsequently mutated imported bindings", async (t) => {
  for (const [name, imported] of [
    ["let binding", `let config = { site: "x" }; export default config;`],
    ["direct reassignment", `const config = { site: "x" }; config = { site: "y" }; export default config;`],
    ["property assignment", `const config = { site: "x" }; config.site = "y"; export default config;`],
    ["object assign", `const config = { site: "x" }; Object.assign(config, { site: "y" }); export default config;`],
    ["delete", `const config = { site: "x" }; delete config.site; export default config;`],
    ["increment", `const config = { retries: 1 }; config.retries++; export default config;`],
    ["hoisted mutator", `function mutate() { config.site = "y"; } const config = { site: "x" }; mutate(); export default config;`],
  ] as const) {
    await t.test(name, () =>
      withProject(
        {
          "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`,
          "nimbus.config.ts": imported,
        },
        (dir) => assert.equal(parseNimbusConfig(dir).ok, false),
      ),
    );
  }
});

test("supports explicit JS/TS extensions and the restricted default export forms", async (t) => {
  const cases = [
    ["./nimbus.config.ts", `export default { site: "https://x.dev" };`],
    ["./nimbus.config.js", `const config = { site: "https://x.dev" }; export default config;`],
    [
      "./nimbus.config.mts",
      `import { defineConfig } from "@cloudflare/nimbus-docs/config"; export default defineConfig({ site: "https://x.dev" });`,
    ],
  ] as const;
  for (const [specifier, imported] of cases) {
    await t.test(specifier, () => {
      withProject(
        {
          "astro.config.ts": `${IMPORT}\nimport config from "${specifier}";\nexport default { integrations: [nimbus(config)] };`,
          [specifier.slice(2)]: imported,
        },
        (dir) => assert.equal(ok(parseNimbusConfig(dir)).config.site, "https://x.dev"),
      );
    });
  }
});

test("rejects ambiguous extensionless imports", () => {
  withProject(
    {
      "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config";\nexport default { integrations: [nimbus(config)] };`,
      "nimbus.config.ts": `export default { site: "https://x.dev" };`,
      "nimbus.config.js": `export default { site: "https://other.dev" };`,
    },
    (dir) => assert.equal(parseNimbusConfig(dir).ok, false),
  );
});

test("does not execute an unsupported imported expression", () => {
  withProject(
    {
      "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`,
      "nimbus.config.ts": `import fs from "node:fs"; export default (fs.writeFileSync(new URL("./executed", import.meta.url), ""), { site: "x" });`,
    },
    (dir) => {
      assert.equal(parseNimbusConfig(dir).ok, false);
      assert.equal(fs.existsSync(path.join(dir, "executed")), false);
    },
  );
});

test("rejects package, named, aliased, re-exported, multi-hop, and unsupported imports", async (t) => {
  const cases: Array<[string, Record<string, string>]> = [
    ["package", { "astro.config.ts": `${IMPORT}\nimport config from "some-package";\nexport default { integrations: [nimbus(config)] };` }],
    ["named", { "astro.config.ts": `${IMPORT}\nimport { config } from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`, "nimbus.config.ts": `export const config = { site: "x" };` }],
    ["aliased default", { "astro.config.ts": `${IMPORT}\nimport { default as config } from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`, "nimbus.config.ts": `export default { site: "x" };` }],
    ["re-export", { "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`, "nimbus.config.ts": `export { default } from "./other.ts";`, "other.ts": `export default { site: "x" };` }],
    ["multi-hop", { "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`, "nimbus.config.ts": `import config from "./other.ts"; export default config;`, "other.ts": `export default { site: "x" };` }],
    ["nested binding", { "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`, "nimbus.config.ts": `function build() { const config = { site: "x" }; return config; } export default config;` }],
    ["unsupported expression", { "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`, "nimbus.config.ts": `export default makeConfig({ site: "x" });` }],
    ["aliased wrapper", { "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`, "nimbus.config.ts": `import { defineConfig as wrap } from "@cloudflare/nimbus-docs/config"; export default wrap({ site: "x" });` }],
  ];
  for (const [name, files] of cases) {
    await t.test(name, () => withProject(files, (dir) => assert.equal(parseNimbusConfig(dir).ok, false)));
  }
});

test("rejects outside-root files, directory indexes, and symlink targets", async (t) => {
  await t.test("outside root", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cfg-parent-"));
    const dir = path.join(parent, "project");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(parent, "outside.ts"), `export default { site: "x" };`);
    fs.writeFileSync(path.join(dir, "astro.config.ts"), `${IMPORT}\nimport config from "../outside.ts";\nexport default { integrations: [nimbus(config)] };`);
    try {
      assert.equal(parseNimbusConfig(dir).ok, false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  await t.test("directory index", () => {
    withProject(
      {
        "astro.config.ts": `${IMPORT}\nimport config from "./config";\nexport default { integrations: [nimbus(config)] };`,
        "config/index.ts": `export default { site: "x" };`,
      },
      (dir) => assert.equal(parseNimbusConfig(dir).ok, false),
    );
  });
  await t.test("symlink", () => {
    withProject(
      {
        "astro.config.ts": `${IMPORT}\nimport config from "./nimbus.config.ts";\nexport default { integrations: [nimbus(config)] };`,
        "real.ts": `export default { site: "x" };`,
      },
      (dir) => {
        fs.symlinkSync(path.join(dir, "real.ts"), path.join(dir, "nimbus.config.ts"));
        assert.equal(parseNimbusConfig(dir).ok, false);
      },
    );
  });
});

test("aliased default import is followed", () => {
  const r = ok(
    parse(`import nb, { defineConfig as d } from "@cloudflare/nimbus-docs";
export default { integrations: [nb({ site: "https://x.dev", title: "X" })] };`),
  );
  assert.equal(r.config.site, "https://x.dev");
});

test("`default as` named default import is followed", () => {
  const r = ok(
    parse(`import { default as nimbus } from "@cloudflare/nimbus-docs";
export default { integrations: [nimbus({ site: "https://x.dev", title: "X" })] };`),
  );
  assert.equal(r.config.site, "https://x.dev");
});

test("quoted keys resolve (masked would blank the interior)", () => {
  const r = ok(
    parse(`${IMPORT}
export default { integrations: [nimbus({ "site": "https://x.dev", 'title': "X" })] };`),
  );
  assert.equal(r.config.site, "https://x.dev");
  assert.equal(r.config.title, "X");
});

test("a `site` URL containing // is not treated as a comment", () => {
  const r = ok(
    parse(`${IMPORT}
export default { integrations: [nimbus({ site: "https://x.dev/a", title: "X" })] };`),
  );
  assert.equal(r.config.site, "https://x.dev/a");
});

test("missing config file → no-config-file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cfg-"));
  try {
    const r = parseNimbusConfig(dir);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "no-config-file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no default import of the package → no-import", () => {
  const r = parse(`import { defineConfig } from "@cloudflare/nimbus-docs";
export default defineConfig({});`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-import");
});

test("subpath-only import does not satisfy the default import", () => {
  const r = parse(`import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
export default { integrations: [] };`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-import");
});

test("mismatched import quotes are rejected", () => {
  const r = parse(`import nimbus from "@cloudflare/nimbus-docs';
export default { integrations: [nimbus({ site: "x" })] };`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-import");
});

test("`from \"pkg\"` inside a comment is not a real import", () => {
  const r = parse(`// import nimbus from "@cloudflare/nimbus-docs";
export default { integrations: [] };`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-import");
});

test("empty nimbus() call → no-call (not a false green)", () => {
  const r = parse(`${IMPORT}
export default { integrations: [nimbus()] };`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-call");
});

test("member call x.nimbus({...}) is skipped", () => {
  const r = parse(`${IMPORT}
const x = { nimbus: (c) => c };
export default { integrations: [x.nimbus({ site: "y" })] };`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-call");
});

test("computed config argument → no-object", () => {
  const r = parse(`${IMPORT}
function build() { return { site: "x" }; }
export default { integrations: [nimbus(build())] };`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-object");
});

test("multi-arg wrapper is rejected → no-object", () => {
  const r = parse(`${WRAP_IMPORT}
const cfg = defineNimbusConfig({ site: "x" }, { extra: true });
export default { integrations: [nimbus(cfg)] };`);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "no-object");
});

test("computed field lands in unresolved, not config", () => {
  const r = ok(
    parse(`${IMPORT}
const base = "https://x.dev";
export default { integrations: [nimbus({ site: base, title: "X" })] };`),
  );
  assert.ok(r.unresolved.includes("site"));
  assert.equal(r.config.site, undefined);
  assert.equal(r.config.title, "X");
});

test("spread is reported as ...spread in unresolved", () => {
  const r = ok(
    parse(`${IMPORT}
const base = { title: "X" };
export default { integrations: [nimbus({ ...base, site: "https://x.dev" })] };`),
  );
  assert.ok(r.unresolved.includes("...spread"));
  assert.equal(r.config.site, "https://x.dev");
});

test("nested objects and arrays resolve", () => {
  const r = ok(
    parse(`${IMPORT}
export default { integrations: [nimbus({
  site: "https://x.dev",
  versions: { others: ["v1", "v2"] },
  flags: [true, false, 3],
})] };`),
  );
  assert.deepEqual(r.config.versions, { others: ["v1", "v2"] });
  assert.deepEqual(r.config.flags, [true, false, 3]);
});

test("locates the config even with alternate config filenames", () => {
  const r = ok(
    parse(
      `${IMPORT}
export default { integrations: [nimbus({ site: "https://x.dev" })] };`,
      "astro.config.mjs",
    ),
  );
  assert.equal(r.config.site, "https://x.dev");
});

test("rewriteConfigField replaces a literal value", () => {
  const source = `${IMPORT}
export default { integrations: [nimbus({ site: "https://example.com", title: "X" })] };`;
  const r = ok(parse(source));
  const next = rewriteConfigField(r.location, "site", "https://docs.example.com");
  assert.match(next, /site: "https:\/\/docs\.example\.com"/);
  assert.match(next, /title: "X"/);
  const reparsed = ok(
    withConfig(next, (dir) => parseNimbusConfig(dir)),
  );
  assert.equal(reparsed.config.site, "https://docs.example.com");
});

test("rewriteConfigField throws for an unknown field", () => {
  const r = ok(
    parse(`${IMPORT}
export default { integrations: [nimbus({ site: "https://x.dev" })] };`),
  );
  assert.throws(() => rewriteConfigField(r.location, "title", "Y"));
});
