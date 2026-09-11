import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { discoverMigrations, resolveMigrationSrcDir } from "../src/_internal/migrations.js";
import nimbus from "../src/index.js";
import {
  getCollectionPage,
  getCollectionPageProps,
  getDocsPage,
  getDocsPageProps,
} from "../src/runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(options: { route?: string; config?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-migrate-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "pages", "[...slug].astro"),
    options.route ?? `---
import { getDocsPageProps } from "@cloudflare/nimbus-docs";
const page = await getDocsPageProps(Astro, {
  partialHeadings: {
    resolvePartialId: ({ file, product }) => {
      if (!file) return undefined;
      return product ? \`${"${product}"}/${"${file}"}\` : file;
    },
  },
});
---
<p>{page.entry.id}</p>
`,
  );
  fs.writeFileSync(
    path.join(root, "astro.config.ts"),
    options.config ?? `import { defineConfig } from "astro/config";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
const config = defineNimbusConfig({ site: "https://example.com", title: "Docs" });
export default defineConfig({
  integrations: [nimbus(config, {
    markdown: { processor: "keep-me" },
  })],
});
`,
  );
  return root;
}

test("plans the canonical resolver as two byte-preserving edits", () => {
  const root = project();
  const discovery = discoverMigrations({ projectRoot: root });
  assert.equal(discovery.coverage, undefined);
  assert.equal(discovery.plans.length, 1);
  const plan = discovery.plans[0]!;
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.changes.map((change) => change.file), ["astro.config.ts", "src/pages/[...slug].astro"]);

  const config = plan.changes[0]!.after;
  assert.match(config, /processor: "keep-me"/);
  assert.match(config, /revision: "partial-resolver-v1"/);
  assert.match(config, /product \? `\$\{product\}\/\$\{file\}` : file/);
  const route = plan.changes[1]!.after;
  assert.match(route, /getDocsPageProps\(Astro\)/);
  assert.doesNotMatch(route, /partialHeadings|resolvePartialId/);
  assert.match(route, /<p>\{page\.entry\.id\}<\/p>/);
});

test("plans the documented expression-bodied resolver", () => {
  const root = project();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.writeFileSync(
    route,
    fs.readFileSync(route, "utf8").replace(
      `{\n      if (!file) return undefined;\n      return product ? \`${"${product}"}/${"${file}"}\` : file;\n    }`,
      `product ? \`${"${product}"}/${"${file}"}\` : file`,
    ),
  );
  assert.deepEqual(discoverMigrations({ projectRoot: root }).plans[0]!.blockers, []);
});

test("does not globalize a route resolver when another direct prose route exists", () => {
  const root = project();
  fs.writeFileSync(
    path.join(root, "src", "pages", "other.astro"),
    `---\nimport * as docs from "@cloudflare/nimbus-docs/runtime";\nconst page = docs.getDocsPage(Astro);\n---\n`,
  );
  const plan = discoverMigrations({ projectRoot: root }).plans[0]!;
  assert.deepEqual(plan.changes, []);
  assert.ok(plan.blockers.some((blocker) => blocker.code === "multiple-callsites"));
});

test("skips customized resolver behavior without proposing edits", () => {
  const root = project();
  const route = path.join(root, "src", "pages", "[...slug].astro");
  fs.writeFileSync(route, fs.readFileSync(route, "utf8").replace("return product ?", "return prefix + file || product ?"));
  const beforeRoute = fs.readFileSync(route, "utf8");
  const beforeConfig = fs.readFileSync(path.join(root, "astro.config.ts"), "utf8");
  const plan = discoverMigrations({ projectRoot: root }).plans[0]!;
  assert.ok(plan.blockers.some((blocker) => blocker.code === "captured-binding"));
  assert.deepEqual(plan.changes, []);
  assert.equal(fs.readFileSync(route, "utf8"), beforeRoute);
  assert.equal(fs.readFileSync(path.join(root, "astro.config.ts"), "utf8"), beforeConfig);
});

test("skips dynamic and conflicting integration destinations", () => {
  const configs = [
    `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";
export default defineConfig({ integrations: [nimbus({}, { ...options })] });
`,
    `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";
export default defineConfig({ integrations: [nimbus({}, { markdown: { partialResolver: existing } })] });
`,
  ];
  for (const config of configs) {
    const plan = discoverMigrations({ projectRoot: project({ config }) }).plans[0]!;
    assert.deepEqual(plan.changes, []);
    assert.ok(plan.blockers.some((blocker) => blocker.code === "dynamic-config" || blocker.code === "config-conflict"));
  }
});

test("identifies an indirect integrations option without rejecting unrelated shorthand", () => {
  const root = project({
    config: `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";
const markdown = {};
const integrations = [nimbus({})];
export default defineConfig({ markdown, integrations });
`,
  });
  const plan = discoverMigrations({
    projectRoot: root,
    srcDirOverride: "src",
  }).plans[0]!;
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.blockers[0]?.code, "dynamic-config");
  assert.match(plan.blockers[0]?.message ?? "", /integrations option references an indirect value/);
  assert.ok(plan.locations.some((location) => location.file === "astro.config.ts" && location.line === 5));
});

test("blocks only remaining partialHeadings properties in contained source ASTs", () => {
  const route = `---
import { getDocsPageProps } from "@cloudflare/nimbus-docs";
import { options } from "../options";
const page = await getDocsPageProps(Astro, options);
---
<p>{page.entry.id}</p>
`;
  const currentRoute = route.replace(", options)", ")");
  const cases = [
    {
      name: "TypeScript options",
      route,
      file: "src/options.ts",
      source: "export const options = { partialHeadings: {} };\n",
      blocker: "unsupported-source",
    },
    {
      name: "malformed candidate",
      route: currentRoute,
      file: "src/options.ts",
      source: "export const options = { partialHeadings: ;\n",
      blocker: "parse-error",
    },
    {
      name: "Astro markup, comment, and string mentions",
      route: currentRoute,
      file: "src/pages/example.astro",
      source: `---\n// partialHeadings\nconst example = "partialHeadings";\nconst broken = ;\n---\n<p>partialHeadings</p>\n`,
    },
    {
      name: "source outside srcDir",
      route: currentRoute,
      file: "options.ts",
      source: "export const options = { partialHeadings: {} };\n",
    },
  ];

  for (const example of cases) {
    const root = project({ route: example.route });
    fs.mkdirSync(path.dirname(path.join(root, example.file)), { recursive: true });
    fs.writeFileSync(path.join(root, example.file), example.source);
    const discovery = discoverMigrations({ projectRoot: root });
    if (!example.blocker) {
      assert.deepEqual(discovery.plans, [], example.name);
      continue;
    }
    const plan = discovery.plans[0]!;
    assert.deepEqual(plan.changes, [], example.name);
    assert.ok(plan.blockers.some((blocker) => blocker.code === example.blocker && blocker.file === example.file), example.name);
    assert.ok(plan.locations.some((location) => location.file === example.file), example.name);
  }
});

test("reports symlinked Astro files and route directories as uncertain coverage", () => {
  const root = project();
  const canonical = path.join(root, "src", "pages", "[...slug].astro");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-migrate-symlink-"));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, "linked.astro"), fs.readFileSync(canonical, "utf8"));
  fs.rmSync(canonical);
  fs.symlinkSync(path.join(outside, "linked.astro"), canonical);
  fs.symlinkSync(outside, path.join(root, "src", "pages", "linked-directory"), "dir");
  const plan = discoverMigrations({ projectRoot: root }).plans[0]!;
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.blockers.filter((blocker) => blocker.code === "symlink-escape").length, 2);
});

test("parses JavaScript config candidates as JavaScript", () => {
  const root = project();
  const config = path.join(root, "astro.config.ts");
  const javascript = path.join(root, "astro.config.js");
  fs.renameSync(config, javascript);
  fs.writeFileSync(javascript, fs.readFileSync(javascript, "utf8").replace("const config =", "const config: unknown ="));
  const discovery = discoverMigrations({ projectRoot: root });
  assert.equal(discovery.coverage?.code, "project-layout-unresolved");
  assert.equal(discovery.plans[0]?.blockers[0]?.code, "project-layout-unresolved");
});

test("preserves CRLF in every planned output", () => {
  const root = project();
  for (const file of ["astro.config.ts", "src/pages/[...slug].astro"]) {
    const absolute = path.join(root, file);
    fs.writeFileSync(absolute, fs.readFileSync(absolute, "utf8").replace(/\n/g, "\r\n"));
  }
  for (const change of discoverMigrations({ projectRoot: root }).plans[0]!.changes) {
    assert.doesNotMatch(change.after, /\r\r\n/);
    assert.doesNotMatch(change.after.replace(/\r\n/g, ""), /\n/);
  }
});

test("computed srcDir requires a contained explicit override", () => {
  const root = project({
    config: `import { defineConfig } from "astro/config";
const srcDir = process.env.SRC;
export default defineConfig({ srcDir });
`,
  });
  assert.match(resolveMigrationSrcDir(root).error ?? "", /--src-dir/);
  assert.equal(resolveMigrationSrcDir(root, "src").srcDir, path.join(root, "src"));
  assert.match(resolveMigrationSrcDir(root, "missing").error ?? "", /Could not resolve --src-dir/);
  assert.match(resolveMigrationSrcDir(root, "../outside").error ?? "", /inside/);
});

test("refuses a source tree that resolves outside the project", () => {
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-migrate-outside-"));
  roots.push(outside);
  fs.rmSync(path.join(root, "src"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "src"), "dir");
  const discovery = discoverMigrations({ projectRoot: root });
  assert.equal(discovery.coverage?.code, "project-layout-unresolved");
});

test("Astro integration reports the shared migration ID and location", () => {
  const root = project();
  const errors: string[] = [];
  const integration = nimbus({ site: "https://example.com", title: "Docs" } as never, {
    validateMdx: false,
    admonitions: false,
    sitemap: false,
    markdown: { processor: {} as never },
  });
  const hook = integration.hooks["astro:config:done"];
  assert.ok(hook);
  assert.throws(
    () => hook!({
      config: {
        root: pathToFileURL(`${root}${path.sep}`),
        srcDir: pathToFileURL(`${path.join(root, "src")}${path.sep}`),
        output: "static",
        redirects: {},
      },
      injectTypes: () => {},
      logger: { error: (message: string) => errors.push(message) },
    } as never),
    /nimbus-docs migrate/,
  );
  assert.match(errors[0] ?? "", /partial-resolver-to-markdown/);
  assert.match(errors[0] ?? "", /src\/pages\/\[\.\.\.slug\]\.astro/);
});

test("Astro integration blocks a stable project with no reviewed baseline", () => {
  const root = project({
    route: `---
import { getDocsPageProps } from "@cloudflare/nimbus-docs";
const page = await getDocsPageProps(Astro);
---
<p>{page.entry.id}</p>
`,
    config: `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";
export default defineConfig({ integrations: [nimbus({ site: "https://example.com", title: "Docs" })] });
`,
  });
  const integration = nimbus({ site: "https://example.com", title: "Docs" } as never, {
    validateMdx: false,
    admonitions: false,
    sitemap: false,
    markdown: { processor: {} as never },
  });
  const hook = integration.hooks["astro:config:done"];
  assert.ok(hook);
  assert.throws(
    () => hook!({
      config: {
        root: pathToFileURL(`${root}${path.sep}`),
        srcDir: pathToFileURL(`${path.join(root, "src")}${path.sep}`),
        output: "static",
        redirects: {},
      },
      injectTypes: () => {},
      logger: { error: () => {} },
    } as never),
    /no reviewed upgrade baseline/,
  );
});

test("runtime tombstones reject removed partial resolver options on every prose helper", async () => {
  await assert.rejects(
    (getDocsPageProps as (...args: unknown[]) => Promise<unknown>)({}, {}),
    /nimbus-docs migrate/,
  );
  assert.throws(
    () => (getDocsPage as (...args: unknown[]) => Promise<unknown>)({}, {}),
    /nimbus-docs migrate/,
  );
  await assert.rejects(
    (getCollectionPageProps as (...args: unknown[]) => Promise<unknown>)({}, {}),
    /nimbus-docs migrate/,
  );
  assert.throws(
    () => (getCollectionPage as (...args: unknown[]) => Promise<unknown>)({}, {}),
    /nimbus-docs migrate/,
  );
});
