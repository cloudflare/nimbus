/**
 * Unit tests for the shared object-literal primitives used by both the
 * components-registry and content-collections parsers. Pinning them directly
 * keeps the contract stable as either consumer evolves.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findMatchingBrace,
  splitTopLevelCommas,
  stripComments,
} from "../../src/_internal/parse-object-literal.js";

test("stripComments zeroes comments to spaces, preserving length and newlines", () => {
  const src = `a // trailing\nb /* block */ c`;
  const out = stripComments(src);
  assert.equal(out.length, src.length, "offsets must stay aligned");
  assert.equal(out.includes("/"), false, "comment markers are gone");
  assert.match(out, /^a +\nb +c$/, "code chars stay put, comments become spaces");
  // Newlines inside/after comments survive so line structure is intact.
  assert.equal(out.split("\n").length, 2);
});

test("stripComments neutralises quotes and braces inside comments", () => {
  // An apostrophe or brace in a comment must not leak into the walker's
  // string/brace state.
  const src = `{ // the user's } comment , here\n Foo }`;
  const out = stripComments(src);
  const end = findMatchingBrace(out, 0);
  assert.equal(out[end], "}");
  // The only surviving brace pair is the real one wrapping `Foo`.
  assert.equal(out.slice(1, end).includes("Foo"), true);
});

test("findMatchingBrace walks nested braces and skips string literals", () => {
  const src = `{ a: { b: 1 }, s: "} not a close", c: 2 }`;
  const end = findMatchingBrace(src, 0);
  assert.equal(end, src.length - 1);
});

test("findMatchingBrace returns -1 when unbalanced", () => {
  assert.equal(findMatchingBrace(`{ a: { b: 1 }`, 0), -1);
  assert.equal(findMatchingBrace(`no brace here`, 0), -1);
});

test("splitTopLevelCommas ignores commas nested in braces, brackets, parens, strings", () => {
  const parts = splitTopLevelCommas(
    `Foo, Bar: baz({ a: 1, b: 2 }), Arr: [1, 2], S: "x,y", Last`,
  ).map((p) => p.trim());
  assert.deepEqual(parts, [
    "Foo",
    "Bar: baz({ a: 1, b: 2 })",
    "Arr: [1, 2]",
    'S: "x,y"',
    "Last",
  ]);
});
