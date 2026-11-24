import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runChecks } from "../../src/check/run.js";
import { exitCodeFor } from "../../src/check/finding.js";

function project(config: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-run-"));
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";
export default { integrations: [nimbus(${config})] };`,
  );
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("placeholder site warns; missing search still errors with exit 1", async () => {
  const dir = project(`{ site: "https://example.com", title: "X" }`);
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    const severity = (code: string) => r.findings.find((f) => f.code === code)?.severity;
    assert.equal(severity("nimbus/site-placeholder"), "warn");
    assert.equal(severity("nimbus/pagefind-missing"), "error");
    assert.equal(exitCodeFor(r.summary), 1);
  } finally {
    cleanup(dir);
  }
});

test("a spread after search: false leaves search unknown, not missing", async () => {
  for (const config of [
    `{ site: "https://docs.example.com", title: "X", search: false, ...shared }`,
    `{ site: "https://docs.example.com", title: "X", ...shared }`,
  ]) {
    const dir = project(config);
    try {
      const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
      assert.ok(!r.findings.some((f) => f.code === "nimbus/pagefind-missing"), config);
    } finally {
      cleanup(dir);
    }
  }
});

test("real site with search disabled passes env with exit 0", async () => {
  const dir = project(`{ site: "https://docs.example.com", title: "X", search: false }`);
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    assert.equal(r.summary.errors, 0);
    assert.equal(exitCodeFor(r.summary), 0);
    assert.ok(r.location, "config object should be locatable");
  } finally {
    cleanup(dir);
  }
});

test("agents.mcp without the MCP server SDK is an error until it is installed", async () => {
  const dir = project(`{ site: "https://docs.example.com", title: "X", search: false, agents: { mcp: true } }`);
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    const sdk = r.findings.find((f) => f.code === "nimbus/mcp-sdk-missing");
    assert.ok(sdk);
    assert.equal(sdk.severity, "error");
    assert.match(sdk.message, /@modelcontextprotocol\/server@2/);
    assert.equal(exitCodeFor(r.summary), 1);

    const pkg = path.join(dir, "node_modules", "@modelcontextprotocol", "server");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), `{ "name": "@modelcontextprotocol/server" }`);
    const installed = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    assert.equal(installed.summary.errors, 0);
  } finally {
    cleanup(dir);
  }
});

test("wrangler config without wrangler installed is a warning, not an error", async () => {
  const dir = project(`{ site: "https://docs.example.com", title: "X", search: false }`);
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), `{ "name": "x" }`);
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    const wrangler = r.findings.find((f) => f.code === "nimbus/wrangler-missing");
    assert.ok(wrangler);
    assert.equal(wrangler.severity, "warn");
    assert.equal(r.summary.errors, 0);
    assert.equal(exitCodeFor(r.summary), 0);
  } finally {
    cleanup(dir);
  }
});

test("a Zod-invalid literal is flagged build-free as config-invalid", async () => {
  const dir = project(`{ site: 123, title: "X", search: false }`);
  try {
    const r = await runChecks(dir, { env: false, structure: true, authoring: false, types: false });
    assert.ok(r.findings.some((f) => f.code === "nimbus/config-invalid"));
    assert.equal(exitCodeFor(r.summary), 1);
  } finally {
    cleanup(dir);
  }
});

test("a missing package.json is flagged as an env error (wrong cwd guard)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-run-"));
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";
export default { integrations: [nimbus({ site: "https://docs.example.com", title: "X", search: false })] };`,
  );
  try {
    const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
    assert.ok(r.findings.some((f) => f.code === "nimbus/no-package-json"));
    assert.equal(exitCodeFor(r.summary), 1);
  } finally {
    cleanup(dir);
  }
});

test("scopes gate which categories run", async () => {
  const dir = project(`{ site: "https://example.com", title: "X" }`);
  try {
    const r = await runChecks(dir, { env: false, structure: true, authoring: true, types: false });
    assert.ok(
      !r.findings.some((f) => f.scope === "env"),
      "env findings should be suppressed when env scope is off",
    );
  } finally {
    cleanup(dir);
  }
});

test("an installed adapter outside the supported range warns with the install command", async () => {
  const adapterProject = (declared: boolean, installed: string | null, lockfile = "package-lock.json") => {
    const dir = project(`{ site: "https://docs.example.com", title: "X", search: false }`);
    if (declared) {
      fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture", "dependencies": { "@astrojs/cloudflare": "^14.1.0" } }`);
    }
    fs.writeFileSync(path.join(dir, lockfile), lockfile.endsWith(".json") ? "{}" : "");
    if (installed) {
      const pkgDir = path.join(dir, "node_modules", "@astrojs", "cloudflare");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@astrojs/cloudflare", version: installed }));
    }
    return dir;
  };
  const adapterFinding = async (dir: string) => {
    try {
      const r = await runChecks(dir, { env: true, structure: false, authoring: false, types: false });
      return r.findings.find((f) => f.code === "nimbus/adapter-version");
    } finally {
      cleanup(dir);
    }
  };

  const finding = await adapterFinding(adapterProject(true, "14.1.2"));
  assert.equal(finding?.severity, "warn");
  assert.equal(finding?.fixable, false);
  assert.match(finding?.message ?? "", /@astrojs\/cloudflare@14\.1\.2 is installed, but Nimbus supports >=14\.3\.0 <14\.5\.0/);
  assert.match(finding?.message ?? "", /`npm install @astrojs\/cloudflare@~14\.3\.0`/);
  // pnpm saves a tilde as a tilde; it rewrote the old `>=14.3.0 <14.4.0` spec to `^14.3.x`.
  const pnpm = await adapterFinding(adapterProject(true, "14.1.2", "pnpm-lock.yaml"));
  assert.match(pnpm?.message ?? "", /`pnpm add (--ignore-workspace-root-check )?@astrojs\/cloudflare@~14\.3\.0`/);

  assert.match(finding?.message ?? "", /`astro dev` and server builds can fail/);
  // 14.2.x builds fine; only a cold `astro dev` can fail.
  const near = await adapterFinding(adapterProject(true, "14.2.4"));
  assert.match(near?.message ?? "", /a cold `astro dev` can fail to start\. Builds aren't affected\./);

  assert.equal(await adapterFinding(adapterProject(true, "14.3.2")), undefined);
  // 14.4 needs Astro 7.4, so it's accepted but not what `add` installs.
  assert.equal(await adapterFinding(adapterProject(true, "14.4.7")), undefined);
  const next = await adapterFinding(adapterProject(true, "14.5.0"));
  assert.match(next?.message ?? "", /14\.5\.0 is installed, but Nimbus supports >=14\.3\.0 <14\.5\.0/);
  assert.equal(await adapterFinding(adapterProject(true, null)), undefined);
  assert.equal(await adapterFinding(adapterProject(false, "14.1.2")), undefined);
});

test("static Cloudflare site with trailingSlash always and file format: check warns before the deploy", async () => {
  const write = (astroFields: string, wrangler: string | null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-run-slash-"));
    fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
    fs.writeFileSync(
      path.join(dir, "astro.config.ts"),
      `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";
export default defineConfig({ ${astroFields} integrations: [nimbus({ site: "https://docs.example.com", title: "X", search: false })] });`,
    );
    if (wrangler !== null) fs.writeFileSync(path.join(dir, "wrangler.jsonc"), wrangler);
    return dir;
  };
  const finding = async (dir: string) => {
    try {
      const r = await runChecks(dir, { env: false, structure: true, authoring: false, types: false });
      return r.findings.find((f) => f.code === "nimbus/cloudflare-trailing-slash");
    } finally {
      cleanup(dir);
    }
  };
  const assets = `{ "assets": { "directory": "./dist" } }`;
  const warned = await finding(write(`trailingSlash: "always", build: { format: "file" },`, assets));
  assert.equal(warned?.severity, "warn");
  assert.match(warned?.message ?? "", /force-trailing-slash/);

  assert.equal(await finding(write(`trailingSlash: "always",`, assets)), undefined);
  assert.equal(await finding(write(`trailingSlash: "always", build: { format: "file" },`, null)), undefined);
  assert.equal(await finding(write(`trailingSlash: slash, build: { format: "file" },`, assets)), undefined);
  // A wrapper other than defineConfig may rewrite the config, so it isn't read.
  const wrapped = (wrapper: string) => {
    const dir = write(`trailingSlash: "always", build: { format: "file" },`, assets);
    const file = path.join(dir, "astro.config.ts");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("defineConfig({", `defineConfig(${wrapper}({`).replace("] });", "] }));"));
    return dir;
  };
  assert.equal(await finding(wrapped("withDefaults")), undefined);
  assert.equal(await finding(write(`trailingSlash: "always", build: { format: "file" }, ...overrides,`, assets)), undefined);
  assert.equal(await finding(write(`trailingSlash: "always", build: { format: "file", ...build },`, assets)), undefined);
  assert.equal(await finding(write(`trailingSlash: "always", build: { format: "file" }, trailingSlash: "never",`, assets)), undefined);
  assert.equal(
    await finding(write(`trailingSlash: "always", build: { format: "file" },`, `{ "assets": { "html_handling": "force-trailing-slash" } }`)),
    undefined,
  );
});

const API = `{ site: "https://docs.example.com", title: "X", search: false, api: [{ collection: "api", spec: "./openapi.yaml" }] }`;
const ENV_ONLY = { env: true, structure: false, authoring: false, types: false } as const;

function fakePackage(dir: string, name: string, manifest: Record<string, unknown> = { main: "index.js" }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
  fs.writeFileSync(path.join(dir, "index.js"), "export {};\n");
}

const parserFinding = async (dir: string) =>
  (await runChecks(dir, ENV_ONLY)).findings.find((f) => f.code === "nimbus/openapi-parser-missing");

test("an api collection without the OpenAPI parser is a fixable error naming the install line", async () => {
  const dir = project(API);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@9.0.0" }));
  try {
    const finding = await parserFinding(dir);
    assert.ok(finding);
    assert.equal(finding.severity, "error");
    assert.equal(finding.fixable, true);
    assert.equal(finding.fix?.kind, "install-dep");
    assert.match(finding.message, /`pnpm add [^`]*@scalar\/openapi-parser`/);
    assert.match(finding.message, /`pnpm add [^`]*openapi-sampler`/);
    fakePackage(path.join(dir, "node_modules/@scalar/openapi-parser"), "@scalar/openapi-parser");
    assert.equal(await parserFinding(dir), undefined);
  } finally {
    cleanup(dir);
  }
});

test("the parser is found where the build finds it: through Nimbus's own links, with any exports shape", async () => {
  const dir = project(API);
  try {
    // pnpm: the site links Nimbus from the store, and the parser sits beside it there.
    const store = path.join(dir, "store/node_modules");
    fakePackage(path.join(store, "@cloudflare/nimbus-docs"), "@cloudflare/nimbus-docs");
    fakePackage(path.join(store, "@scalar/openapi-parser"), "@scalar/openapi-parser", {
      type: "module",
      exports: { ".": { import: "./index.js" } },
    });
    fs.mkdirSync(path.join(dir, "node_modules/@cloudflare"), { recursive: true });
    fs.symlinkSync(path.join(store, "@cloudflare/nimbus-docs"), path.join(dir, "node_modules/@cloudflare/nimbus-docs"), "dir");
    assert.equal(await parserFinding(dir), undefined);
  } finally {
    cleanup(dir);
  }
});

test("a parser installed after a check is found by the next check in the same process", async () => {
  const dir = project(API);
  try {
    // npm: Nimbus and another @scalar package are already installed when `check --fix` adds the parser.
    fakePackage(path.join(dir, "node_modules/@cloudflare/nimbus-docs"), "@cloudflare/nimbus-docs");
    fakePackage(path.join(dir, "node_modules/@scalar/json-magic"), "@scalar/json-magic");
    assert.ok(await parserFinding(dir));
    // Its entry only in `dist/`, like the real package: Node's resolver remembers the missing package.json.
    const parser = path.join(dir, "node_modules/@scalar/openapi-parser");
    fs.mkdirSync(path.join(parser, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(parser, "package.json"),
      JSON.stringify({ name: "@scalar/openapi-parser", type: "module", exports: { ".": "./dist/index.js" } }),
    );
    fs.writeFileSync(path.join(parser, "dist/index.js"), "export {};\n");
    assert.equal(await parserFinding(dir), undefined);
  } finally {
    cleanup(dir);
  }
});

test("no parser finding without api collections or under Plug'n'Play", async () => {
  const none = project(`{ site: "https://docs.example.com", title: "X", search: false }`);
  const pnp = project(API);
  fs.writeFileSync(path.join(pnp, ".pnp.cjs"), "");
  try {
    assert.equal(await parserFinding(none), undefined);
    assert.equal(await parserFinding(pnp), undefined);
  } finally {
    cleanup(none);
    cleanup(pnp);
  }
});

test("check and the build name the same install line for a missing parser", async () => {
  const dir = project(API);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@9.0.0" }));
  const cwd = process.cwd();
  try {
    const finding = await parserFinding(dir);
    process.chdir(dir);
    const { openApiParserMissing } = await import("../../src/_internal/api/parser-missing.js");
    assert.equal(await openApiParserMissing(), finding?.message);
  } finally {
    process.chdir(cwd);
    cleanup(dir);
  }
});
