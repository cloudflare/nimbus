// DX-1: nimbus.json provenance record + install-root honoring + `init` reconstruction.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installComponents } from "../src/cli/component.js";
import {
  bytesHash,
  componentsDir,
  mergeComponents,
  readNimbusJson,
  recordInstalled,
  resolveWriteRoot,
  toInstalledComponent,
  writeNimbusJson,
  type NimbusJson,
} from "../src/cli/nimbus-json.js";
import { reconstructComponents } from "../src/cli/init.js";
import type { ComponentItem, RegistryFile } from "../src/cli/resolver.js";

function uiItem(name: string, files: RegistryFile[]): ComponentItem {
  return {
    name,
    type: "registry:ui",
    title: name,
    description: "test",
    dependencies: [],
    registryDependencies: [],
    files,
  };
}

function libItem(name: string, files: RegistryFile[]): ComponentItem {
  return { ...uiItem(name, files), type: "registry:lib" };
}

async function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "nimbus-json-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// ---- bytesHash -------------------------------------------------------------

test("bytesHash is deterministic, order-independent, and content-sensitive", () => {
  const a: RegistryFile[] = [
    { path: "components/ui/x/X.astro", content: "one" },
    { path: "components/ui/x/index.ts", content: "two" },
  ];
  const reordered = [a[1]!, a[0]!];
  assert.equal(bytesHash(a), bytesHash(reordered));
  assert.match(bytesHash(a), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(
    bytesHash(a),
    bytesHash([{ path: "components/ui/x/X.astro", content: "changed" }, a[1]!]),
  );
  // A file boundary can't be forged by concatenation (length-delimited).
  assert.notEqual(
    bytesHash([{ path: "a", content: "bc" }]),
    bytesHash([{ path: "ab", content: "c" }]),
  );
});

// ---- resolveWriteRoot / componentsDir --------------------------------------

test("resolveWriteRoot defaults to src and honors a recorded root", () => {
  assert.equal(resolveWriteRoot(null), "src");
  assert.equal(resolveWriteRoot({} as NimbusJson), "src");
  assert.equal(resolveWriteRoot({ install: { root: "src" } }), "src");
  assert.equal(
    resolveWriteRoot({ install: { root: "packages/docs/src" } }),
    "packages/docs/src",
  );
  assert.equal(
    componentsDir({ install: { root: "packages/docs/src" } }),
    path.join("packages/docs/src", "components", "ui"),
  );
});

test("resolveWriteRoot rejects an absolute or traversing root", () => {
  assert.throws(() => resolveWriteRoot({ install: { root: "/etc" } }), /must be a relative path/);
  assert.throws(
    () => resolveWriteRoot({ install: { root: "../../elsewhere" } }),
    /must be a relative path/,
  );
});

// ---- read / write ----------------------------------------------------------

test("readNimbusJson: null when absent, round-trips a valid record", async () => {
  await withProject(async (cwd) => {
    assert.equal(readNimbusJson(cwd), null);

    const record: NimbusJson = {
      version: "0.7.0",
      templatesTag: "templates-v0.7.0",
      variant: "empty",
      registry: "https://nimbus-docs.com/registry",
      install: { root: "src", aliases: { "@/*": "src/*" } },
      components: [],
    };
    writeNimbusJson(cwd, record);
    assert.deepEqual(readNimbusJson(cwd), record);
    // Trailing newline, 2-space indent.
    assert.ok(readFileSync(path.join(cwd, "nimbus.json"), "utf8").endsWith("}\n"));
  });
});

test("readNimbusJson throws a fix-it on malformed JSON and bad shape", async () => {
  await withProject(async (cwd) => {
    writeFileSync(path.join(cwd, "nimbus.json"), "{ not json ");
    assert.throws(() => readNimbusJson(cwd), /not valid JSON/);

    writeFileSync(
      path.join(cwd, "nimbus.json"),
      JSON.stringify({ components: [{ slug: 1 }] }),
    );
    assert.throws(() => readNimbusJson(cwd), /unexpected shape/);
  });
});

test("readNimbusJson preserves unknown top-level keys (lenient/forward-compat)", async () => {
  await withProject(async (cwd) => {
    writeFileSync(
      path.join(cwd, "nimbus.json"),
      JSON.stringify({ version: "0.7.0", futureField: { nested: true } }),
    );
    const read = readNimbusJson(cwd) as NimbusJson & { futureField?: unknown };
    assert.deepEqual(read.futureField, { nested: true });
  });
});

// ---- toInstalledComponent / mergeComponents --------------------------------

test("toInstalledComponent records slug, type, source, bytes-hash, files", () => {
  const item = uiItem("dialog", [
    { path: "components/ui/dialog/Dialog.astro", content: "hi" },
  ]);
  const rec = toInstalledComponent(item, {
    source: "https://nimbus-docs.com/registry",
    files: ["src/components/ui/dialog/Dialog.astro"],
  });
  assert.equal(rec.slug, "dialog");
  assert.equal(rec.type, "registry:ui");
  assert.equal(rec.source, "https://nimbus-docs.com/registry");
  assert.equal(rec.hash, bytesHash(item.files));
  assert.deepEqual(rec.files, ["src/components/ui/dialog/Dialog.astro"]);
});

test("mergeComponents appends new slugs and replaces an existing one in place", () => {
  const base: NimbusJson = {
    components: [
      { slug: "dialog", type: "registry:ui", source: "s", hash: "sha256:a", files: ["f1"] },
      { slug: "cn", type: "registry:lib", source: "s", hash: "sha256:b", files: ["f2"] },
    ],
  };
  const merged = mergeComponents(base, [
    { slug: "dialog", type: "registry:ui", source: "s", hash: "sha256:z", files: ["f1"] },
    { slug: "popover", type: "registry:ui", source: "s", hash: "sha256:c", files: ["f3"] },
  ]);
  assert.deepEqual(
    merged.components!.map((c) => c.slug),
    ["dialog", "cn", "popover"],
  );
  assert.equal(merged.components![0]!.hash, "sha256:z"); // replaced in place
  assert.deepEqual(base.components!.map((c) => c.hash), ["sha256:a", "sha256:b"]); // input untouched
});

test("mergeComponents does not duplicate a repeated new slug", () => {
  const merged = mergeComponents({ components: [] }, [
    { slug: "x", type: "registry:ui", source: "s", hash: "sha256:1", files: ["a"] },
    { slug: "x", type: "registry:ui", source: "s", hash: "sha256:2", files: ["a"] },
  ]);
  assert.deepEqual(merged.components!.map((c) => c.slug), ["x"]);
});

test("recordInstalled folds an add into the record with posix paths under the root", () => {
  const base: NimbusJson = { install: { root: "packages/docs/src" }, components: [] };
  const next = recordInstalled(
    base,
    [
      uiItem("cn", [{ path: "lib/cn.ts", content: "x" }]),
      uiItem("dialog", [{ path: "components/ui/dialog/Dialog.astro", content: "y" }]),
    ],
    { source: "https://nimbus-docs.com/registry", srcRoot: "packages/docs/src" },
  );
  assert.deepEqual(
    next.components!.map((c) => c.slug),
    ["cn", "dialog"],
  );
  // Portable, forward-slash paths under the monorepo root — never OS-separated.
  assert.deepEqual(next.components![1]!.files, [
    "packages/docs/src/components/ui/dialog/Dialog.astro",
  ]);
  assert.equal(next.components![0]!.files[0], "packages/docs/src/lib/cn.ts");
});

// ---- installComponents honors srcRoot --------------------------------------

test("installComponents writes registry files against a custom srcRoot (monorepo)", async () => {
  await withProject(async (cwd) => {
    const report = await installComponents(
      [uiItem("dialog", [{ path: "components/ui/dialog/Dialog.astro", content: "hi" }])],
      { cwd, yes: true, srcRoot: "packages/docs/src" },
    );
    assert.equal(
      existsSync(path.join(cwd, "packages/docs/src/components/ui/dialog/Dialog.astro")),
      true,
    );
    assert.equal(existsSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro")), false);
    assert.deepEqual(report.written, [
      path.join("packages/docs/src/components/ui/dialog/Dialog.astro"),
    ]);
  });
});

// ---- init: reconstructComponents -------------------------------------------

test("reconstructComponents classifies pristine / modified / unverified / hand-authored", async () => {
  await withProject(async (cwd) => {
    const root = "src";
    const write = (rel: string, content: string) => {
      const abs = path.join(cwd, root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };

    // Registry bytes for two known slugs.
    const dialogItem = uiItem("dialog", [
      { path: "components/ui/dialog/Dialog.astro", content: "SOURCE" },
    ]);
    const popoverItem = uiItem("popover", [
      { path: "components/ui/popover/Popover.astro", content: "SOURCE" },
    ]);

    write("components/ui/dialog/Dialog.astro", "SOURCE"); // pristine (matches)
    write("components/ui/popover/Popover.astro", "EDITED"); // modified
    write("components/ui/card/Card.astro", "whatever"); // known slug, fetch fails → unverified
    write("components/ui/myown/Mine.astro", "hand"); // not in registry → hand-authored

    const known: Record<string, "registry:ui" | "registry:lib"> = {
      dialog: "registry:ui",
      popover: "registry:ui",
      card: "registry:ui",
    };
    const bytes: Record<string, ComponentItem> = { dialog: dialogItem, popover: popoverItem };

    const { components, stats } = await reconstructComponents({
      cwd,
      root,
      source: "https://nimbus-docs.com/registry",
      knownType: (slug) => known[slug] ?? null,
      libSlugs: [],
      fetchItem: async (slug) => bytes[slug] ?? null, // card → null (offline/unknown bytes)
    });

    const bySlug = Object.fromEntries(components.map((c) => [c.slug, c]));

    assert.equal(bySlug.dialog!.hash, bytesHash(dialogItem.files));
    assert.equal(bySlug.dialog!.modified, undefined);
    assert.deepEqual(bySlug.dialog!.files, ["src/components/ui/dialog/Dialog.astro"]);

    assert.equal(bySlug.popover!.modified, true);
    assert.equal(bySlug.popover!.hash, bytesHash(popoverItem.files)); // records SOURCE identity

    assert.equal(bySlug.card!.hash, null); // known but unverified
    assert.equal(bySlug.card!.handAuthored, undefined);

    assert.equal(bySlug.myown!.handAuthored, true);
    assert.equal(bySlug.myown!.hash, null);

    assert.deepEqual(stats, { pristine: 1, modified: 1, unverified: 1, handAuthored: 1 });
  });
});

test("reconstructComponents returns nothing when there is no components/ui dir", async () => {
  await withProject(async (cwd) => {
    const { components, stats } = await reconstructComponents({
      cwd,
      root: "src",
      source: "s",
      knownType: () => null,
      libSlugs: [],
      fetchItem: async () => null,
    });
    assert.deepEqual(components, []);
    assert.deepEqual(stats, { pristine: 0, modified: 0, unverified: 0, handAuthored: 0 });
  });
});

test("reconstructComponents reconstructs a registry:lib item found under root", async () => {
  await withProject(async (cwd) => {
    const cn = libItem("cn", [{ path: "lib/cn.ts", content: "export const cn=1;" }]);
    const abs = path.join(cwd, "src", "lib", "cn.ts");
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "export const cn=1;");

    const { components, stats } = await reconstructComponents({
      cwd,
      root: "src",
      source: "s",
      knownType: (slug) => (slug === "cn" ? "registry:lib" : null),
      libSlugs: ["cn", "notinstalled"], // notinstalled has no files on disk → skipped
      fetchItem: async (slug) => (slug === "cn" ? cn : slug === "notinstalled" ? libItem("notinstalled", [{ path: "lib/x.ts", content: "" }]) : null),
    });

    assert.deepEqual(components.map((c) => c.slug), ["cn"]);
    assert.equal(components[0]!.type, "registry:lib");
    assert.equal(components[0]!.hash, bytesHash(cn.files));
    assert.equal(components[0]!.modified, undefined);
    assert.deepEqual(components[0]!.files, ["src/lib/cn.ts"]);
    assert.equal(stats.pristine, 1);
  });
});

test("reconstructComponents refuses to read outside the project (path containment)", async () => {
  await withProject(async (cwd) => {
    // Malicious item: one legit in-dir file (so the extra-file check stays
    // silent) plus one escaping file. Plant a decoy at the exact escape target
    // (`<cwd>/escape.txt`, reached via `../escape.txt` from `<cwd>/src`) with
    // content matching the item. If containment failed and read the decoy, ALL
    // files would be present + byte-match → pristine. So `modified: true` here
    // proves the escaping read was refused (a genuine guard, not vacuous).
    const evil = uiItem("evil", [
      { path: "components/ui/evil/Evil.astro", content: "REAL" },
      { path: "../escape.txt", content: "SAME" },
    ]);
    const dir = path.join(cwd, "src", "components", "ui", "evil");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "Evil.astro"), "REAL");
    writeFileSync(path.join(cwd, "escape.txt"), "SAME");

    const { components } = await reconstructComponents({
      cwd,
      root: "src",
      source: "s",
      knownType: () => "registry:ui",
      libSlugs: [],
      fetchItem: async () => evil,
    });

    assert.equal(components[0]!.slug, "evil");
    assert.equal(components[0]!.modified, true); // escaping file skipped ⇒ not all present
  });
});

test("reconstructComponents flags an extra on-disk file as modified", async () => {
  await withProject(async (cwd) => {
    const dialog = uiItem("dialog", [
      { path: "components/ui/dialog/Dialog.astro", content: "SOURCE" },
    ]);
    const dir = path.join(cwd, "src", "components", "ui", "dialog");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "Dialog.astro"), "SOURCE"); // matches source
    writeFileSync(path.join(dir, "Extra.astro"), "user addition"); // not in registry

    const { components } = await reconstructComponents({
      cwd,
      root: "src",
      source: "s",
      knownType: () => "registry:ui",
      libSlugs: [],
      fetchItem: async () => dialog,
    });
    assert.equal(components[0]!.modified, true); // extra file ⇒ drift
  });
});
