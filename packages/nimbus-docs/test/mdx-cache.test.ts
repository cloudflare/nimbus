// Unit coverage for the cache key/SIG/config logic. The Shiki-registry
// reconstruction is validated end-to-end in real builds (needs a highlighter).

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createMdxCache,
  computeSig,
  resolveMdxCacheConfig,
  extractShikiClasses,
} from "../src/_internal/mdx-cache.js";

const sigBase = {
  mdxOptions: { optimize: true },
  srcDir: "/proj/src",
  root: "/proj",
  sourcemap: false,
  pluginSourceDirs: [] as string[],
};

test("cache key is deterministic and content/id/sig-sensitive", () => {
  const c = createMdxCache({ cacheDir: mkTmp(), sig: "sigA" });
  const k = c.key("src/a.mdx", "BODY");
  assert.equal(k, c.key("src/a.mdx", "BODY"), "same inputs → same key");
  assert.notEqual(k, c.key("src/a.mdx", "BODY2"), "code change → new key");
  assert.notEqual(k, c.key("src/b.mdx", "BODY"), "id change → new key");
  const c2 = createMdxCache({ cacheDir: mkTmp(), sig: "sigB" });
  assert.notEqual(k, c2.key("src/a.mdx", "BODY"), "sig change → new key");
});

test("SIG busts on any compile-affecting input", () => {
  const base = computeSig(sigBase);
  assert.notEqual(base, computeSig({ ...sigBase, mdxOptions: { optimize: false } }), "mdxOptions");
  assert.notEqual(base, computeSig({ ...sigBase, srcDir: "/other/src" }), "srcDir");
  assert.notEqual(base, computeSig({ ...sigBase, root: "/other" }), "root");
  assert.notEqual(base, computeSig({ ...sigBase, sourcemap: true }), "sourcemap");
  assert.equal(base, computeSig(sigBase), "identical inputs → identical sig");
});

test("SIG busts on a consumer plugin-source edit", () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "plugin.ts"), "export const a = 1;");
  const before = computeSig({ ...sigBase, pluginSourceDirs: [dir] });
  fs.writeFileSync(path.join(dir, "plugin.ts"), "export const a = 2;"); // edit body
  const after = computeSig({ ...sigBase, pluginSourceDirs: [dir] });
  assert.notEqual(before, after, "editing a plugin source file busts the sig");
});

test("entry get/set round-trips code+map+meta+shikiClasses", () => {
  const c = createMdxCache({ cacheDir: mkTmp(), sig: "s" });
  const k = c.key("src/a.mdx", "X");
  assert.deepEqual(
    extractShikiClasses('<i class="nb-shiki-ab12cd x">a</i> nb-shiki-ab12cd nb-shiki-ef34gh'),
    ["nb-shiki-ab12cd", "nb-shiki-ef34gh"],
    "dedup + capture all classes",
  );
  assert.deepEqual(extractShikiClasses("no classes here"), []);
  assert.ok(k.length >= 32);
});

test("resolveMdxCacheConfig honors false and env override", () => {
  assert.equal(resolveMdxCacheConfig(false, "/c").enabled, false, "false disables");
  assert.equal(resolveMdxCacheConfig(undefined, "/c").enabled, false, "default is opt-in (off)");
  assert.equal(resolveMdxCacheConfig(true, "/c").enabled, true, "true enables");
  assert.equal(
    resolveMdxCacheConfig(true, "/c").dir,
    path.join("/c", "nimbus", "mdx"),
    "default dir under cacheDir",
  );
  const saved = process.env.NIMBUS_MDX_CACHE;
  try {
    process.env.NIMBUS_MDX_CACHE = "0";
    assert.equal(resolveMdxCacheConfig(true, "/c").enabled, false, "env=0 overrides option=true");
    process.env.NIMBUS_MDX_CACHE = "1";
    assert.equal(resolveMdxCacheConfig(false, "/c").enabled, true, "env=1 overrides option=false");
  } finally {
    if (saved === undefined) delete process.env.NIMBUS_MDX_CACHE;
    else process.env.NIMBUS_MDX_CACHE = saved;
  }
});

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-mdx-cache-"));
}
