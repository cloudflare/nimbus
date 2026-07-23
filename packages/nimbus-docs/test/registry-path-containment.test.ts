// `installComponents` must never write outside the project's `src/`:
// registry payloads are untrusted, so a `file.path` of `../../evil` or an
// absolute path must be rejected before any write.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertInsideSrc,
  installComponents,
} from "../src/cli/component.js";
import type { ComponentItem } from "../src/cli/resolver.js";

function item(files: { path: string; content: string }[]): ComponentItem {
  return {
    name: "evil",
    type: "registry:ui",
    title: "Evil",
    description: "test payload",
    dependencies: [],
    registryDependencies: [],
    files,
  };
}

async function withProject(
  run: (cwd: string, srcDir: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "nimbus-add-"));
  try {
    await run(cwd, path.join(cwd, "src"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("relative traversal escaping src/ is rejected before any write", async () => {
  await withProject(async (cwd) => {
    const marker = `escape-${Date.now()}.txt`;
    await assert.rejects(
      installComponents([item([{ path: `../../${marker}`, content: "x" }])], {
        cwd,
        yes: true, overwrite: false,
      }),
      /escapes the project's src\/ directory/,
    );
    assert.equal(existsSync(path.resolve(cwd, "..", "..", marker)), false);
  });
});

test("absolute path is rejected before any write", async () => {
  await withProject(async (cwd) => {
    const abs = path.join(tmpdir(), `abs-evil-${Date.now()}.txt`);
    await assert.rejects(
      installComponents([item([{ path: abs, content: "x" }])], {
        cwd,
        yes: true, overwrite: false,
      }),
      /is absolute/,
    );
    assert.equal(existsSync(abs), false);
  });
});

test("a poisoned entry blocks the whole install — no sibling file lands", async () => {
  await withProject(async (cwd, srcDir) => {
    // Guard runs up front, so the good file must not be written either.
    const good = item([
      { path: "components/ui/good/Good.astro", content: "ok" },
    ]);
    good.name = "good";
    const bad = item([{ path: "../../../poison.txt", content: "x" }]);

    await assert.rejects(
      installComponents([good, bad], { cwd, yes: true, overwrite: false }),
      /escapes the project's src\/ directory/,
    );
    assert.equal(
      existsSync(path.join(srcDir, "components/ui/good/Good.astro")),
      false,
    );
  });
});

test("legitimate nested paths still install", async () => {
  await withProject(async (cwd, srcDir) => {
    const report = await installComponents(
      [item([{ path: "components/ui/dialog/Dialog.astro", content: "hi" }])],
      { cwd, yes: true, overwrite: false },
    );
    const written = path.join(srcDir, "components/ui/dialog/Dialog.astro");
    assert.equal(existsSync(written), true);
    assert.deepEqual(report.written, ["src/components/ui/dialog/Dialog.astro"]);
  });
});

test("assertInsideSrc: resolve-based, catches normalized traversal", () => {
  const srcDir = path.join(tmpdir(), "proj", "src");

  assert.throws(
    () => assertInsideSrc(srcDir, "foo/../../bar", "x"),
    /escapes the project's src\/ directory/,
  );
  assert.equal(
    assertInsideSrc(srcDir, "components/ui/x/X.astro", "x"),
    path.join(srcDir, "components/ui/x/X.astro"),
  );
  assert.throws(() => assertInsideSrc(srcDir, ".", "x"));
});
