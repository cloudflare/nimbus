import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { walkFiles, walkFilesSync, type WalkedFile } from "../src/_internal/fs-walk.js";

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-fswalk-"));
  const write = (rel: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
  };
  write("a.mdx");
  write("b.md");
  write("c.txt");
  write("sub/d.mdx");
  write("node_modules/pkg/e.mdx");
  write(".hidden/f.mdx");
  write("_private/g.mdx");
  return root;
}

function relsSync(root: string, options?: Parameters<typeof walkFilesSync>[1]): string[] {
  return [...walkFilesSync(root, options)].map((f: WalkedFile) => f.rel).sort();
}

async function relsAsync(root: string, options?: Parameters<typeof walkFiles>[1]): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkFiles(root, options)) out.push(f.rel);
  return out.sort();
}

test("default skips node_modules and dotfolders, keeps underscore dirs", () => {
  const root = makeTree();
  try {
    assert.deepEqual(relsSync(root, { extensions: [".mdx"] }), [
      "_private/g.mdx",
      "a.mdx",
      "sub/d.mdx",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skipUnderscoreDirs excludes _-prefixed directories", () => {
  const root = makeTree();
  try {
    assert.deepEqual(
      relsSync(root, { extensions: [".mdx"], skipUnderscoreDirs: true }),
      ["a.mdx", "sub/d.mdx"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skipDotDirs:false includes dotfolders", () => {
  const root = makeTree();
  try {
    assert.ok(
      relsSync(root, { extensions: [".mdx"], skipDotDirs: false }).includes(
        ".hidden/f.mdx",
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no extension filter yields every file (minus skipped dirs)", () => {
  const root = makeTree();
  try {
    assert.deepEqual(relsSync(root), [
      "_private/g.mdx",
      "a.mdx",
      "b.md",
      "c.txt",
      "sub/d.mdx",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("multiple extensions match by path.extname", () => {
  const root = makeTree();
  try {
    assert.deepEqual(relsSync(root, { extensions: [".mdx", ".md"] }), [
      "_private/g.mdx",
      "a.mdx",
      "b.md",
      "sub/d.mdx",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rel is POSIX-normalised and abs is absolute", () => {
  const root = makeTree();
  try {
    const files = [...walkFilesSync(root, { extensions: [".mdx"] })];
    const sub = files.find((f) => f.rel.endsWith("d.mdx"))!;
    assert.equal(sub.rel, "sub/d.mdx");
    assert.ok(!sub.rel.includes("\\"));
    assert.equal(sub.abs, path.join(root, "sub", "d.mdx"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing root (ENOENT) yields empty under strict policy", () => {
  const missing = path.join(os.tmpdir(), "nimbus-fswalk-does-not-exist-xyz");
  assert.deepEqual(relsSync(missing), []);
});

test("strict policy rethrows non-ENOENT read errors; lenient swallows them", () => {
  // Pointing the walk root at a file makes readdir throw ENOTDIR — a
  // non-ENOENT error that must propagate under the default strict policy.
  const root = makeTree();
  const filePath = path.join(root, "a.mdx");
  try {
    assert.throws(() => relsSync(filePath), /ENOTDIR/);
    assert.deepEqual(relsSync(filePath, { onReadError: "lenient" }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("async walker matches sync walker", async () => {
  const root = makeTree();
  try {
    assert.deepEqual(await relsAsync(root, { extensions: [".mdx"] }), relsSync(root, { extensions: [".mdx"] }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("async lenient policy treats a missing directory as empty", async () => {
  const missing = path.join(os.tmpdir(), "nimbus-fswalk-async-missing-xyz");
  assert.deepEqual(await relsAsync(missing, { onReadError: "lenient" }), []);
});
