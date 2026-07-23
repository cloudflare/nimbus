// DX-2: the bundled unified-diff renderer (no git, no deps).

import assert from "node:assert/strict";
import { test } from "node:test";

import { hasChanges, unifiedDiff } from "../src/cli/_diff.js";

test("identical text yields no diff", () => {
  assert.equal(hasChanges("a\nb\n", "a\nb\n"), false);
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
});

test("a changed line shows as one delete + one add", () => {
  const d = unifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n");
  assert.match(d, /^-two$/m);
  assert.match(d, /^\+TWO$/m);
  assert.match(d, /^ one$/m); // context kept
  assert.match(d, /^ three$/m);
  assert.match(d, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
});

test("pure addition and pure deletion", () => {
  assert.match(unifiedDiff("a\n", "a\nb\n"), /^\+b$/m);
  const del = unifiedDiff("a\nb\n", "a\n");
  assert.match(del, /^-b$/m);
  assert.doesNotMatch(del, /^\+/m);
});

test("hunk line ranges count the right sides", () => {
  // Replace line 2 of 3: a-hunk is 1 line at 2, b-hunk is 1 line at 2, with context.
  const d = unifiedDiff("l1\nl2\nl3\n", "l1\nX\nl3\n");
  const header = d.split("\n").find((l) => l.startsWith("@@"))!;
  assert.equal(header, "@@ -1,3 +1,3 @@"); // 3 lines each with 3 context lines around the change
});

test("distant changes split into separate hunks", () => {
  const a = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
  const b = a.replace("line1", "CHANGED1").replace("line18", "CHANGED18");
  const hunks = unifiedDiff(a, b).split("\n").filter((l) => l.startsWith("@@"));
  assert.equal(hunks.length, 2); // context=3 can't bridge a 16-line gap
});

test("color adds ANSI only when asked", () => {
  const plain = unifiedDiff("a\n", "b\n", { color: false });
  const colored = unifiedDiff("a\n", "b\n", { color: true });
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.match(colored, /\x1b\[3[12]m/);
});

test("path header uses the real path, never a temp path", () => {
  const d = unifiedDiff("a\n", "b\n", { path: "src/components/ui/Dialog.astro" });
  assert.match(d, /^--- src\/components\/ui\/Dialog\.astro$/m);
  assert.match(d, /^\+\+\+ src\/components\/ui\/Dialog\.astro$/m);
});
