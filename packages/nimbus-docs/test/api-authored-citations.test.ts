// The authored-source citation seam used by both the `.mdx` Vite source plugin
// and the `.md` Markdown processor: content-dir scoping (including symlinked
// roots), the `hasCitation` short-circuit, resolution to logical routes, the
// build-fail throw on an unresolved author citation, and composition with
// authored-link normalization, which owns Astro's base.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAuthoredCitationResolver } from "../src/_internal/api/authored-citations.ts";
import { normalizeAuthoredLinks } from "../src/_internal/authored-links.ts";

const CONTENT = path.resolve("/tmp/nimbus-content");
const index = new Map<string, string>([
  ["zones:createZone", "/api/zones/create-zone"],
]);
const inScope = path.join(CONTENT, "guide.mdx");

function makeResolver(getCitationIndex = () => index) {
  return createAuthoredCitationResolver({ contentDirs: [CONTENT], getCitationIndex });
}

describe("createAuthoredCitationResolver", () => {
  test("resolves an in-scope citation to its logical route", () => {
    assert.equal(
      makeResolver()("See [create](api.ref:zones:createZone).", inScope),
      "See [create](/api/zones/create-zone).",
    );
  });

  test("build-fails on an unresolved citation into a known collection", () => {
    assert.throws(
      () => makeResolver()("[x](api.ref:zones:deleteZone)", inScope),
      /unresolved API citation/,
    );
  });

  test("passes through files outside the content dirs and sourceless renders", () => {
    const source = "[x](api.ref:zones:deleteZone)";
    assert.equal(makeResolver()(source, "/somewhere/else/readme.md"), source);
    assert.equal(makeResolver()(source, undefined), source);
  });

  test("returns the source unchanged when it has no citation", () => {
    assert.equal(makeResolver()("Just **prose**.", inScope), "Just **prose**.");
  });

  test("reads the current index on every call (dev re-bake)", () => {
    let current: ReadonlyMap<string, string> = index;
    const resolve = makeResolver(() => current);
    assert.match(resolve("[a](api.ref:zones:createZone)", inScope), /create-zone/);
    current = new Map([["zones:createZone", "/api/zones/renamed"]]);
    assert.match(resolve("[a](api.ref:zones:createZone)", inScope), /renamed/);
  });

  describe("symlinked content roots", () => {
    let dir = "";
    after(() => (dir ? rm(dir, { recursive: true }) : undefined));

    test("scopes files reported by either their lexical or canonical path", async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "nimbus-cite-scope-"));
      const real = path.join(dir, "real");
      const linked = path.join(dir, "linked");
      await mkdir(path.join(real, "content"), { recursive: true });
      await symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
      const resolve = createAuthoredCitationResolver({
        contentDirs: [path.join(linked, "content")],
        getCitationIndex: () => index,
      });
      const source = "[a](api.ref:zones:createZone)";
      const expected = "[a](/api/zones/create-zone)";
      assert.equal(resolve(source, path.join(linked, "content", "a.mdx")), expected);
      assert.equal(
        resolve(source, path.join(await realpath(real), "content", "a.mdx")),
        expected,
      );
    });
  });

  test("composes with authored-link normalization: base applied once in every form", () => {
    const resolve = makeResolver();
    const mdx =
      '[a](api.ref:zones:createZone) [b](<api.ref:zones:createZone>) <a href="api.ref:zones:createZone">c</a>';
    assert.equal(
      normalizeAuthoredLinks(resolve(mdx, inScope), { base: "/docs/", format: "mdx" }),
      '[a](/docs/api/zones/create-zone) [b](/docs/api/zones/create-zone) <a href="/docs/api/zones/create-zone">c</a>',
    );
    const md = "[a](<api.ref:zones:createZone>)\n\n<a href=\"api.ref:zones:createZone\">c</a>\n";
    assert.equal(
      normalizeAuthoredLinks(resolve(md, path.join(CONTENT, "guide.md")), {
        base: "/docs",
        format: "markdown",
      }),
      "[a](/docs/api/zones/create-zone)\n\n<a href=\"/docs/api/zones/create-zone\">c</a>\n",
    );
    assert.equal(
      normalizeAuthoredLinks(resolve(mdx, inScope), { base: "/", format: "mdx" }),
      resolve(mdx, inScope),
    );
  });
});
