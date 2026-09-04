import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADAPTER_RECIPES,
  buildServerWranglerConfig,
  isNimbusServerWrangler,
  isNimbusStaticWrangler,
  sanitizeWorkerName,
} from "../src/_internal/adapters.js";
import { installAdapter, type DepInstaller } from "../src/cli/adapter.js";
import { writeFileAtomic } from "../src/cli/fs-atomic.js";

const STARTER_CONFIG = `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";

export default defineConfig({
  // nimbus:adapter
  output: "static",
  integrations: [nimbus()],
});
`;

const STATIC_WRANGLER = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "my-docs",
  compatibility_date: "2025-01-01",
  assets: { directory: "./dist", not_found_handling: "404-page" },
};

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-wrangler-"));
}

function project(dir: string): void {
  writeFileSync(join(dir, "astro.config.ts"), STARTER_CONFIG);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "docs", dependencies: { astro: "^7.0.0" } }),
  );
}

const okInstaller: DepInstaller = async () => ({ ok: true });

function readWrangler(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8"));
}

// ---- pure recipe + emitter -------------------------------------------------

test("only the cloudflare recipe carries a server wrangler recipe", () => {
  assert.ok(ADAPTER_RECIPES.cloudflare.serverWrangler);
  assert.equal(ADAPTER_RECIPES.vercel.serverWrangler, undefined);
  assert.equal(ADAPTER_RECIPES.node.serverWrangler, undefined);
  assert.equal(ADAPTER_RECIPES.netlify.serverWrangler, undefined);
  const sw = ADAPTER_RECIPES.cloudflare.serverWrangler!;
  assert.deepEqual([...sw.compatibilityFlags], ["nodejs_compat"]);
  assert.match(sw.wranglerFloor, /^wrangler@/);
});

test("buildServerWranglerConfig omits adapter-derived main/assets.directory", () => {
  const cfg = buildServerWranglerConfig(ADAPTER_RECIPES.cloudflare, {
    name: "docs",
    compatibilityDate: "2025-06-01",
  })!;
  assert.equal(cfg.name, "docs");
  assert.equal(cfg.compatibility_date, "2025-06-01");
  assert.deepEqual(cfg.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(cfg.assets, { not_found_handling: "none" });
  assert.ok(!("main" in cfg), "the adapter derives main");
});

test("buildServerWranglerConfig is null for adapters whose platform owns deploy config", () => {
  for (const id of ["vercel", "node", "netlify"] as const) {
    assert.equal(
      buildServerWranglerConfig(ADAPTER_RECIPES[id], {
        name: "x",
        compatibilityDate: "2025-01-01",
      }),
      null,
    );
  }
});

test("sanitizeWorkerName stays valid after truncating a boundary dash", () => {
  const name = sanitizeWorkerName(`${"a".repeat(62)}-suffix`);
  assert.equal(name, "a".repeat(62));
  assert.ok(isNimbusServerWrangler(buildServerWranglerConfig(ADAPTER_RECIPES.cloudflare, {
    name,
    compatibilityDate: "2025-01-01",
  })));
});

test("isNimbusStaticWrangler recognizes only the exact static shape", () => {
  assert.ok(isNimbusStaticWrangler(STATIC_WRANGLER));
  assert.ok(!isNimbusStaticWrangler({ ...STATIC_WRANGLER, vars: {} }), "extra key");
  assert.ok(
    !isNimbusStaticWrangler({
      ...STATIC_WRANGLER,
      assets: { directory: "./out", not_found_handling: "404-page" },
    }),
    "changed directory",
  );
  assert.ok(
    !isNimbusStaticWrangler({
      ...STATIC_WRANGLER,
      assets: { directory: "./dist", not_found_handling: "none" },
    }),
    "changed not-found handling",
  );
  assert.ok(
    !isNimbusStaticWrangler(
      buildServerWranglerConfig(ADAPTER_RECIPES.cloudflare, {
        name: "x",
        compatibilityDate: "2025-01-01",
      }),
    ),
    "server shape is not static",
  );
  assert.ok(!isNimbusStaticWrangler(null));
  assert.ok(!isNimbusStaticWrangler([STATIC_WRANGLER]));
  assert.ok(!isNimbusStaticWrangler({ ...STATIC_WRANGLER, name: "" }));
  assert.ok(!isNimbusStaticWrangler({ ...STATIC_WRANGLER, name: "bad_name" }));
  assert.ok(!isNimbusStaticWrangler({ ...STATIC_WRANGLER, name: "-bad" }));
  assert.ok(!isNimbusStaticWrangler({ ...STATIC_WRANGLER, name: "x".repeat(64) }));
  assert.ok(
    !isNimbusStaticWrangler({ ...STATIC_WRANGLER, compatibility_date: "2025-02-30" }),
  );
});

test("isNimbusServerWrangler recognizes only the emitted server shape", () => {
  const server = buildServerWranglerConfig(ADAPTER_RECIPES.cloudflare, {
    name: "x",
    compatibilityDate: "2025-01-01",
  })!;
  assert.ok(isNimbusServerWrangler(server));
  assert.ok(!isNimbusServerWrangler(STATIC_WRANGLER));
  assert.ok(!isNimbusServerWrangler({ ...server, vars: {} }), "extra key");
  for (const invalid of [
    { ...server, name: "" },
    { ...server, compatibility_date: "not-a-date" },
    { ...server, compatibility_date: "2025-02-30" },
    { ...server, compatibility_flags: [] },
    { ...server, compatibility_flags: ["nodejs_compat", "extra"] },
    { ...server, compatibility_flags: ["wrong"] },
    { ...server, assets: {} },
    { ...server, assets: { not_found_handling: "404-page" } },
    { ...server, assets: { not_found_handling: "none", extra: true } },
  ]) {
    assert.ok(!isNimbusServerWrangler(invalid), JSON.stringify(invalid));
  }
});

// ---- installAdapter wrangler management ------------------------------------

test("cloudflare with no wrangler.jsonc writes the server config", async () => {
  const dir = scratch();
  project(dir);
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "written");
  const w = readWrangler(dir);
  assert.deepEqual(w.compatibility_flags, ["nodejs_compat"]);
  assert.ok(!("directory" in (w.assets as object)), "no static assets.directory");
  assert.ok(!("main" in w));
});

for (const filename of ["wrangler.json", "wrangler.toml"]) {
  test(`cloudflare preserves an existing ${filename} instead of adding a second config`, async () => {
    const dir = scratch();
    project(dir);
    const path = join(dir, filename);
    const before = filename.endsWith(".toml")
      ? 'name = "custom"\ncompatibility_date = "2025-01-01"\n'
      : '{"name":"custom","compatibility_date":"2025-01-01"}\n';
    writeFileSync(path, before);

    const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    assert.equal(res.wrangler?.action, "skipped-foreign");
    assert.equal(res.wrangler?.path, path);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.ok(!existsSync(join(dir, "wrangler.jsonc")));
    assert.ok(
      res.warnings.some(
        (warning) =>
          warning.includes(filename) && /Nimbus only.*wrangler\.jsonc/.test(warning),
      ),
    );
    const warning = res.warnings.join("\n");
    if (filename === "wrangler.json") {
      assert.match(warning, /"name": "custom"/);
      assert.match(warning, /"compatibility_date": "2025-01-01"/);
    } else {
      assert.match(warning, /Preserve every other setting/);
      assert.match(warning, /Add `nodejs_compat`.*`compatibility_flags`/);
      assert.match(warning, /`assets\.not_found_handling = "none"`/);
    }
  });
}

test("cloudflare preserves a long JSON Worker name when workers.dev is disabled", async () => {
  const dir = scratch();
  project(dir);
  const name = "a".repeat(100);
  const before = JSON.stringify({
    name,
    compatibility_date: "2025-01-01",
    workers_dev: false,
  });
  writeFileSync(join(dir, "wrangler.json"), before);

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.match(res.warnings.join("\n"), new RegExp(`"name": "${name}"`));
  assert.equal(readFileSync(join(dir, "wrangler.json"), "utf8"), before);
});

test("cloudflare preserves root configs when worker and env resolution differ", async () => {
  const dir = scratch();
  project(dir);
  const json = '{"name":"active"}\n';
  const jsonc = JSON.stringify(STATIC_WRANGLER, null, 2);
  const toml = 'name = "inactive"\n';
  writeFileSync(join(dir, "wrangler.json"), json);
  writeFileSync(join(dir, "wrangler.jsonc"), jsonc);
  writeFileSync(join(dir, "wrangler.toml"), toml);

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.equal(res.wrangler?.path, join(dir, "wrangler.jsonc"));
  assert.equal(readFileSync(join(dir, "wrangler.json"), "utf8"), json);
  assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), jsonc);
  assert.equal(readFileSync(join(dir, "wrangler.toml"), "utf8"), toml);
  const warning = res.warnings.join("\n");
  assert.match(warning, /worker build resolves wrangler\.jsonc/);
  assert.match(warning, /environment loading resolves wrangler\.toml/);
});

test("ancestor wrangler.json does not block the project build config", async () => {
  const root = scratch();
  const dir = join(root, "docs");
  mkdirSync(dir);
  project(dir);
  const parentJson = '{"name":"parent","compatibility_date":"2025-01-01"}\n';
  const childJsonc = JSON.stringify(STATIC_WRANGLER, null, 2);
  writeFileSync(join(root, "wrangler.json"), parentJson);
  writeFileSync(join(dir, "wrangler.jsonc"), childJsonc);

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "rewritten");
  assert.equal(res.wrangler?.path, join(dir, "wrangler.jsonc"));
  assert.equal(readFileSync(join(root, "wrangler.json"), "utf8"), parentJson);
  assert.deepEqual(readWrangler(dir).assets, { not_found_handling: "none" });
  const warning = res.warnings.join("\n");
  assert.match(warning, /Wrangler resolves \.\.\/wrangler\.json outside this project/);
  assert.match(warning, /generated deploy redirect/);
});

test("ancestor wrangler.jsonc outranks a project wrangler.toml", async () => {
  const root = scratch();
  const dir = join(root, "docs");
  mkdirSync(dir);
  project(dir);
  const parentJsonc = '{"name":"parent","compatibility_date":"2025-01-01"}\n';
  const childToml = 'name = "child"\n';
  writeFileSync(join(root, "wrangler.jsonc"), parentJsonc);
  writeFileSync(join(dir, "wrangler.toml"), childToml);

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.equal(res.wrangler?.path, join(dir, "wrangler.toml"));
  assert.equal(readFileSync(join(root, "wrangler.jsonc"), "utf8"), parentJsonc);
  assert.equal(readFileSync(join(dir, "wrangler.toml"), "utf8"), childToml);
  assert.ok(!existsSync(join(dir, "wrangler.jsonc")));
  const warning = res.warnings.join("\n");
  assert.match(warning, /Cloudflare build resolves wrangler\.toml/);
  assert.match(warning, /Wrangler resolves \.\.\/wrangler\.jsonc outside this project/);
});

test("ancestor-only configs do not block creating the project build config", async () => {
  const root = scratch();
  const parent = join(root, "site");
  const dir = join(parent, "docs");
  mkdirSync(parent);
  mkdirSync(dir);
  project(dir);
  const far = '{"name":"far"}\n';
  const near = '{"name":"near"}\n';
  writeFileSync(join(root, "wrangler.json"), far);
  writeFileSync(join(parent, "wrangler.json"), near);

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "written");
  assert.equal(res.wrangler?.path, join(dir, "wrangler.jsonc"));
  assert.ok(existsSync(join(dir, "wrangler.jsonc")));
  const warning = res.warnings.join("\n");
  assert.match(warning, /Wrangler resolves \.\.\/wrangler\.json outside this project/);
  assert.equal(readFileSync(join(root, "wrangler.json"), "utf8"), far);
  assert.equal(readFileSync(join(parent, "wrangler.json"), "utf8"), near);
});

test("a directory named wrangler.json causes conflicting root config refusal", async () => {
  const dir = scratch();
  project(dir);
  mkdirSync(join(dir, "wrangler.json"));
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(STATIC_WRANGLER, null, 2));

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), JSON.stringify(STATIC_WRANGLER, null, 2));
  assert.match(res.warnings.join("\n"), /environment loading resolves wrangler\.json/);
});

test("cloudflare never replaces a symlinked wrangler.jsonc", async () => {
  const root = scratch();
  const dir = join(root, "docs");
  mkdirSync(dir);
  project(dir);
  const target = join(root, "source.jsonc");
  const before = JSON.stringify(STATIC_WRANGLER, null, 2);
  writeFileSync(target, before);
  symlinkSync("../source.jsonc", join(dir, "wrangler.jsonc"));

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.equal(readlinkSync(join(dir, "wrangler.jsonc")), "../source.jsonc");
  assert.equal(readFileSync(target, "utf8"), before);
  assert.ok(res.warnings.some((warning) => /does not rewrite symlinked configs/.test(warning)));
});

test("cloudflare reports partial configuration without replacing a dangling symlink", async () => {
  const dir = scratch();
  project(dir);
  symlinkSync("missing.jsonc", join(dir, "wrangler.jsonc"));

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "write-failed");
  assert.equal(readlinkSync(join(dir, "wrangler.jsonc")), "missing.jsonc");
  assert.ok(res.warnings.some((warning) => /non-regular filesystem entry/.test(warning)));
});

test("managed wrangler.jsonc is preserved when TOML controls Astro env", async () => {
  const dir = scratch();
  project(dir);
  const toml = 'name = "inactive"\n';
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(STATIC_WRANGLER, null, 2));
  writeFileSync(join(dir, "wrangler.toml"), toml);

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.equal(
    readFileSync(join(dir, "wrangler.jsonc"), "utf8"),
    JSON.stringify(STATIC_WRANGLER, null, 2),
  );
  assert.equal(readFileSync(join(dir, "wrangler.toml"), "utf8"), toml);
  assert.match(res.warnings.join("\n"), /environment loading resolves wrangler\.toml/);
});

test("cloudflare reports partial success when wrangler.jsonc cannot be written", async () => {
  const dir = scratch();
  project(dir);
  mkdirSync(join(dir, "wrangler.jsonc"));

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "write-failed");
  assert.ok(res.warnings.some((warning) => /only partially configured/.test(warning)));
});

test("atomic Wrangler creation ignores a predictable temp-path symlink", async () => {
  const dir = scratch();
  project(dir);
  const victim = join(dir, "victim.txt");
  const before = "keep me\n";
  writeFileSync(victim, before);
  symlinkSync(victim, join(dir, `wrangler.jsonc.nimbus-tmp-${process.pid}`));

  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "written");
  assert.equal(readFileSync(victim, "utf8"), before);
  assert.ok(lstatSync(join(dir, "wrangler.jsonc")).isFile());
});

test("atomic writes preserve modes and create-only writes preserve destinations", () => {
  const dir = scratch();
  const path = join(dir, "config.json");
  writeFileSync(path, "original\n");
  chmodSync(path, 0o600);

  assert.throws(() => writeFileAtomic(path, "blocked\n", { overwrite: false }));
  assert.equal(readFileSync(path, "utf8"), "original\n");
  writeFileAtomic(path, "updated\n");
  assert.equal(readFileSync(path, "utf8"), "updated\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("cloudflare rewrites our static wrangler, preserving name + compatibility_date", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(STATIC_WRANGLER, null, 2));
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "rewritten");
  const w = readWrangler(dir);
  assert.equal(w.name, "my-docs");
  assert.equal(w.compatibility_date, "2025-01-01");
  assert.deepEqual(w.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(w.assets, { not_found_handling: "none" });
});

test("cloudflare recognizes a commented static wrangler with trailing commas", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    `{
      "$schema": "node_modules/wrangler/config-schema.json",
      "name": "my-docs",
      "compatibility_date": "2025-01-01",
      // Nimbus static assets
      "assets": { "directory": "./dist", "not_found_handling": "404-page", },
    }`,
  );
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "rewritten");
  assert.deepEqual(readWrangler(dir).assets, { not_found_handling: "none" });
});

test("cloudflare refuses to clobber a hand-edited wrangler and prints the merge", async () => {
  const dir = scratch();
  project(dir);
  const foreign = {
    ...STATIC_WRANGLER,
    compatibility_flags: ["python_workers"],
    assets: { ...STATIC_WRANGLER.assets, binding: "ASSETS" },
    kv_namespaces: [{ binding: "KV" }],
  };
  const before = JSON.stringify(foreign, null, 2);
  writeFileSync(join(dir, "wrangler.jsonc"), before);
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), before, "untouched");
  const warning = res.warnings.find((value) => /Merge this in by hand/.test(value));
  assert.ok(warning);
  const merge = JSON.parse(warning.slice(warning.indexOf("{")));
  assert.deepEqual(merge.compatibility_flags, ["python_workers", "nodejs_compat"]);
  assert.deepEqual(merge.assets, { binding: "ASSETS", not_found_handling: "none" });
  assert.ok(res.warnings.some((value) => /static 404 before Astro/.test(value)));
  assert.ok(res.warnings.some((value) => /scoped `run_worker_first`/.test(value)));
});

test("cloudflare does not warn about static 404 routing when the Worker runs first", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      ...STATIC_WRANGLER,
      compatibility_flags: ["python_workers"],
      assets: {
        ...STATIC_WRANGLER.assets,
        binding: "ASSETS",
        run_worker_first: true,
      },
    }),
  );
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.equal(res.warnings.some((value) => /static 404 before Astro/.test(value)), false);
});

test("cloudflare warns about browser navigation in a foreign wrangler.json", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: "foreign-worker",
      compatibility_date: "2025-01-01",
      compatibility_flags: ["python_workers"],
      assets: { directory: "./dist", not_found_handling: "404-page" },
    }),
  );
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler?.action, "skipped-foreign");
  assert.ok(res.warnings.some((value) => /static 404 before Astro/.test(value)));
});

test("cloudflare sanitizes invalid identity values in the printed merge", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      ...STATIC_WRANGLER,
      name: "",
      compatibility_date: "not-a-date",
      vars: { KEEP: "me" },
    }),
  );
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  const warning = res.warnings.find((value) => /Merge this in by hand/.test(value));
  assert.ok(warning);
  assert.doesNotMatch(warning, /"name": ""|not-a-date/);
});

test("cloudflare re-run over an already-server wrangler is a silent no-op", async () => {
  const dir = scratch();
  project(dir);
  await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  const after = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.wrangler?.action, "unchanged");
  assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), after, "unchanged");
  assert.ok(
    !res.warnings.some((w) => /wrangler\.jsonc/.test(w)),
    "no refuse-and-print warning on idempotent re-run",
  );
});

test("cloudflare no-op config still reports a newly written wrangler", async () => {
  const dir = scratch();
  project(dir);
  await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  rmSync(join(dir, "wrangler.jsonc"));
  const res = await installAdapter("cloudflare", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "noop");
  if (res.status !== "noop") return;
  assert.equal(res.wrangler?.action, "written");
  assert.ok(existsSync(join(dir, "wrangler.jsonc")));
});

test("non-cloudflare adapters never touch wrangler.jsonc", async () => {
  const dir = scratch();
  project(dir);
  const res = await installAdapter("vercel", { cwd: dir, installDeps: okInstaller });
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.equal(res.wrangler, null);
  assert.ok(!existsSync(join(dir, "wrangler.jsonc")));
});

for (const adapter of ["vercel", "node", "netlify"] as const) {
  test(`static Cloudflare to ${adapter} warns about the stale wrangler`, async () => {
    const dir = scratch();
    project(dir);
    writeFileSync(join(dir, "nimbus.json"), JSON.stringify({ version: "0.11.0" }));
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(STATIC_WRANGLER, null, 2));

    const res = await installAdapter(adapter, { cwd: dir, installDeps: okInstaller });

    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    assert.ok(
      res.warnings.some(
        (warning) => /wrangler\.jsonc/.test(warning) && /static Cloudflare/.test(warning),
      ),
    );
    assert.deepEqual(readWrangler(dir), STATIC_WRANGLER);
  });
}

for (const filename of ["wrangler.json", "wrangler.toml"]) {
  test(`switching away from Cloudflare warns about ${filename} without provenance`, async () => {
    const dir = scratch();
    project(dir);
    const before = filename.endsWith(".toml") ? 'name = "docs"\n' : '{}\n';
    writeFileSync(join(dir, filename), before);

    const res = await installAdapter("vercel", { cwd: dir, installDeps: okInstaller });

    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    assert.ok(
      res.warnings.some(
        (warning) => warning.includes(filename) && /Cloudflare deploy/.test(warning),
      ),
    );
    assert.equal(readFileSync(join(dir, filename), "utf8"), before);
  });

  test(`recorded Cloudflare switch warns about ${filename}`, async () => {
    const dir = scratch();
    project(dir);
    writeFileSync(
      join(dir, "nimbus.json"),
      JSON.stringify({ version: "0.11.0", serverOutput: { adapter: "cloudflare" } }),
    );
    const before = filename.endsWith(".toml") ? 'name = "docs"\n' : '{}\n';
    writeFileSync(join(dir, filename), before);

    const res = await installAdapter("vercel", { cwd: dir, installDeps: okInstaller });

    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    assert.ok(
      res.warnings.some(
        (warning) => warning.includes(filename) && /Cloudflare deploy/.test(warning),
      ),
    );
    assert.equal(readFileSync(join(dir, filename), "utf8"), before);
  });
}

test("a recorded non-Cloudflare switch warns about every coexisting Wrangler config", async () => {
  const dir = scratch();
  project(dir);
  writeFileSync(
    join(dir, "nimbus.json"),
    JSON.stringify({ version: "0.11.0", serverOutput: { adapter: "vercel" } }),
  );
  const files = {
    "wrangler.json": '{"name":"json"}\n',
    "wrangler.jsonc": '{"name":"jsonc"}\n',
    "wrangler.toml": 'name = "toml"\n',
  };
  for (const [filename, source] of Object.entries(files)) {
    writeFileSync(join(dir, filename), source);
  }

  const res = await installAdapter("node", { cwd: dir, installDeps: okInstaller });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(res.warnings.some((warning) => /Switched from the vercel adapter/.test(warning)));
  const wranglerWarning = res.warnings.find((warning) => /every Wrangler config/.test(warning));
  assert.ok(wranglerWarning);
  for (const [filename, source] of Object.entries(files)) {
    assert.match(wranglerWarning, new RegExp(filename.replace(".", "\\.")));
    assert.equal(readFileSync(join(dir, filename), "utf8"), source);
  }
});

test("a non-Cloudflare install detects Wrangler config created by dependency installation", async () => {
  const dir = scratch();
  project(dir);
  const source = '{"name":"created-during-install"}\n';
  const installer: DepInstaller = async () => {
    writeFileSync(join(dir, "wrangler.json"), source);
    return { ok: true };
  };

  const res = await installAdapter("node", { cwd: dir, installDeps: installer });

  assert.equal(res.status, "applied");
  if (res.status !== "applied") return;
  assert.ok(res.warnings.some((warning) => /wrangler\.json/.test(warning)));
  assert.equal(readFileSync(join(dir, "wrangler.json"), "utf8"), source);
});

for (const adapter of ["vercel", "node", "netlify"] as const) {
  test(`commented Cloudflare wrangler without provenance warns when switching to ${adapter}`, async () => {
    const dir = scratch();
    project(dir);
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      `{
        "$schema": "node_modules/wrangler/config-schema.json",
        "name": "my-docs",
        "compatibility_date": "2025-01-01",
        "compatibility_flags": ["nodejs_compat"],
        "assets": { "not_found_handling": "none", }, // server
      }`,
    );
    const res = await installAdapter(adapter, { cwd: dir, installDeps: okInstaller });
    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    assert.ok(res.warnings.some((warning) => /server Cloudflare/.test(warning)));
  });
}

for (const adapter of ["vercel", "node", "netlify"] as const) {
  test(`Cloudflare server wrangler without provenance warns when switching to ${adapter}`, async () => {
    const dir = scratch();
    project(dir);
    const server = buildServerWranglerConfig(ADAPTER_RECIPES.cloudflare, {
      name: "my-docs",
      compatibilityDate: "2025-01-01",
    });
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(server, null, 2));

    const res = await installAdapter(adapter, { cwd: dir, installDeps: okInstaller });

    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    assert.ok(
      res.warnings.some(
        (warning) => /wrangler\.jsonc/.test(warning) && /server Cloudflare/.test(warning),
      ),
    );
  });
}
