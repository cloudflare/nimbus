/**
 * Tests for `_internal/validate-mdx-content.ts` — the build-time scanner that
 * flags PascalCase MDX tags which are neither imported nor registered as
 * globals. Focus here is `stripCodeBlocks`: JSX-looking text inside code
 * spans / string literals must not false-positive.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateMdxContent } from "../src/_internal/validate-mdx-content.js";

async function scan(files: Record<string, string>, globals: string[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "nimbus-validate-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  }
  return validateMdxContent({ globals, contentDirs: [dir], projectRoot: dir });
}

const fm = "---\ntitle: T\ndescription: D\n---\n\n";

test("nested generics (<Name<…>>) are not flagged", async () => {
  // `Promise<Map<…>>` — `<Map<` is a TS generic (a `<` follows the name),
  // never a JSX tag. Handled by the tag finder, so it holds even when the
  // generic wraps across lines in inline code (where line-bounded stripping
  // can't reach it).
  const body =
    fm +
    "Response: `Promise<Map<string, {\nvalue: string | null,\nmetadata: string | null\n}>>`\n";
  const failures = await scan({ "a.mdx": body });
  assert.deepEqual(failures, []);
});

test("a stray/odd backtick does not cascade onto later inline code", async () => {
  // Regression: cross-line inline-code matching used to make backtick
  // pairing global, so one stray backtick exposed a later `<Component>`.
  const body =
    fm + "A lone ` backtick in prose.\n\nLater a `<Markdown>` mention in code.\n";
  const failures = await scan({ "stray.mdx": body });
  assert.deepEqual(failures, []);
});

test("PascalCase string literals inside JSX expressions are not flagged", async () => {
  // `"<IDP_UUID>"` is a string value inside a JSX expression, not a tag.
  const body =
    fm +
    '<CURL json={{ idp_id: "<IDP_UUID>", recipients: [{ id: "<ACCOUNT_ID>" }] }} />\n';
  const failures = await scan({ "b.mdx": body }, ["CURL"]);
  assert.deepEqual(failures, []);
});

test("genuinely unregistered component is still flagged", async () => {
  const body = fm + "<TotallyUnknownThing />\n";
  const failures = await scan({ "c.mdx": body });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].tag, "TotallyUnknownThing");
});
