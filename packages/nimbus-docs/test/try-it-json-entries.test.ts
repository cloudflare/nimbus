// A JSON object body as entries: what a form over the body edits, and how it's written back.

import assert from "node:assert/strict";
import { test } from "node:test";

import { jsonEntries, jsonObject } from "../src/_internal/try-it/json-entries.js";

test("entries keep each value's text, numbers exactly as typed", () => {
  const text = '{"id": 12345678901234567890, "price": 1.50, "name": "a \\"b\\" , }", "tags": ["x", {"y": [1, 2]}], "on": true, "none": null}';
  assert.deepEqual(jsonEntries(text), [
    { key: "id", raw: "12345678901234567890" },
    { key: "price", raw: "1.50" },
    { key: "name", raw: '"a \\"b\\" , }"' },
    { key: "tags", raw: '["x", {"y": [1, 2]}]' },
    { key: "on", raw: "true" },
    { key: "none", raw: "null" },
  ]);
});

test("a formatted object writes back as it was", () => {
  const text = '{\n  "name": "n",\n  "address": {\n    "city": "Oslo",\n    "lines": [\n      "a"\n    ]\n  },\n  "empty": {}\n}';
  const entries = jsonEntries(text)!;
  assert.equal(entries[1]!.raw, '{\n  "city": "Oslo",\n  "lines": [\n    "a"\n  ]\n}', "a nested value reads as if it stood alone");
  assert.equal(jsonObject(entries), text);
});

test("an escaped key, an empty object, whitespace everywhere", () => {
  assert.deepEqual(jsonEntries(' \n{ "a\\u0062" :\t1 ,"c":"d" } \n'), [
    { key: "ab", raw: "1" },
    { key: "c", raw: '"d"' },
  ]);
  assert.deepEqual(jsonEntries("{}"), []);
  assert.equal(jsonObject([]), "{}");
});

test("not one object: null", () => {
  for (const text of ["", "[]", "1", '"{}"', "null", '{"a": }', "{} {}"]) assert.equal(jsonEntries(text), null, text);
});

test("a value that isn't JSON is written as typed", () => {
  assert.equal(jsonObject([{ key: "n", raw: "12a" }, { key: "o", raw: '{\n  "x": 1\n}' }]), '{\n  "n": 12a,\n  "o": {\n    "x": 1\n  }\n}');
});

test("a repeated key, however it's spelled: null", () => {
  assert.equal(jsonEntries('{"x": 1, "x": 2}'), null);
  assert.equal(jsonEntries('{"x": 1, "\\u0078": 2}'), null);
});

test("a large one-line object scans in linear time", () => {
  const text = `{${Array.from({ length: 40_000 }, (_, i) => `"k${i}":${i}`).join(",")}}`;
  const started = performance.now();
  assert.equal(jsonEntries(text)!.length, 40_000);
  assert.ok(performance.now() - started < 1000, "well under a second");
});
