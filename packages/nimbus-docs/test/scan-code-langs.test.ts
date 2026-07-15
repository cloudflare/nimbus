/**
 * `scanCodeBlockLanguages` feeds `shikiConfig.langs`, which Shiki eager-loads.
 * Shiki throws on grammars it can't resolve, so the scanner must (1) not mistake
 * inline `` ```x``` `` for a fenced block, and (2) drop unknown languages —
 * unknown code renders as plaintext (like Expressive Code), never a build crash.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanCodeBlockLanguages } from "../src/_internal/scan-code-langs.js";

async function scan(body: string, langAlias?: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-scanlang-"));
  await mkdir(path.join(root, "src/content"), { recursive: true });
  await writeFile(path.join(root, "src/content/a.mdx"), body, "utf8");
  return scanCodeBlockLanguages(root, langAlias);
}

test("ignores inline triple-backtick code (CommonMark: backticks in the info string)", async () => {
  // The blocker case, at line start so it trips the old `^[ \t]*```` anchor:
  // the old regex captured `calendar-notification`; the `[^\n`]*$` clause now
  // rejects it (a closing backtick follows → inline code, not a fence).
  const langs = await scan("```calendar-notification@google.com``` is the address.\n");
  assert.deepEqual(langs, []);
});

test("ignores inline triple-backtick even when the token is a real language", async () => {
  // Isolates the regex clause from the filter: `js` is known, so the filter
  // would keep it — only the info-string-backtick rejection drops this inline
  // code. Line starts with the backticks so the old regex would have matched.
  const langs = await scan("```js``` is shorthand, used inline.\n");
  assert.deepEqual(langs, []);
});

test("collects real fenced languages and drops unknown ones", async () => {
  const langs = await scan(
    "```js\nconst a = 1;\n```\n\n```boguslang\nx\n```\n\n```python\np = 1\n```\n",
  );
  assert.ok(langs.includes("js"), `expected js; got ${JSON.stringify(langs)}`);
  assert.ok(langs.includes("python"));
  assert.ok(!langs.includes("boguslang"));
});

test("keeps a real fence that carries a metadata info string", async () => {
  // Backtick-free metadata (title, line ranges) must not be mistaken for inline.
  const langs = await scan('```js title="x" {1,3}\nconst a = 1;\n```\n');
  assert.deepEqual(langs, ["js"]);
});

test("keeps special languages (text/plaintext) and applies langAlias", async () => {
  const langs = await scan("```text\nplain\n```\n\n```console\n$ ls\n```\n", {
    console: "shellsession",
  });
  assert.ok(langs.includes("text"));
  assert.ok(langs.includes("shellsession"));
  assert.ok(!langs.includes("console"));
});
