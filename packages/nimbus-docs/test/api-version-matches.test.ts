import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchApiVersions,
  type ApiVersionMatchSummary,
} from "../src/_internal/api/version-matches.js";

function summary(
  version: string | null,
  operations: Record<string, string>,
  extra: string[] = [],
): ApiVersionMatchSummary {
  return {
    version,
    shapes: operations,
    rows: [...Object.keys(operations), ...extra].map((id) => ({
      id,
      slug: id,
    })),
  };
}

function keys(summaries: ApiVersionMatchSummary[]) {
  return Object.fromEntries(
    matchApiVersions(summaries).map(({ version, byId }) => [
      String(version),
      byId,
    ]),
  );
}

test("compact matching preserves exact ids and connects only unambiguous absent operations", () => {
  const matched = keys([
    summary("v1", { old: "get /a", stable: "post /a", removed: "delete /a" }, [
      "root",
    ]),
    summary("v2", { renamed: "get /a", stable: "patch /changed" }, ["root"]),
  ]);
  assert.equal(matched.v1!.old, matched.v2!.renamed);
  assert.equal(matched.v1!.stable, matched.v2!.stable);
  assert.equal(matched.v1!.root, matched.v2!.root);
  assert.equal(matched.v1!.removed, "removed");
});

test("contradictory global fallback rejects the whole component, independent of version order", () => {
  const summaries = [
    summary("v1", { old: "get /a", unrelated: "get /b" }),
    summary("v2", { renamed: "get /a" }),
    summary("v3", { renamed: "get /b" }),
  ];
  const expected = keys(summaries);
  for (const order of [
    summaries,
    [...summaries].reverse(),
    [summaries[1]!, summaries[2]!, summaries[0]!],
  ]) {
    assert.deepEqual(keys(order), expected);
    const matched = keys(order);
    assert.notEqual(matched.v1!.old, matched.v2!.renamed);
    assert.notEqual(matched.v1!.unrelated, matched.v2!.renamed);
  }
});

test("duplicate wire shapes do not choose a destination arbitrarily", () => {
  const matched = keys([
    summary("v1", { old: "get /a" }),
    summary("v2", { first: "get /a", second: "get /a" }),
  ]);
  assert.notEqual(matched.v1!.old, matched.v2!.first);
  assert.notEqual(matched.v1!.old, matched.v2!.second);
});

test("adding an earlier key preserves source-id lookup even when the internal key changes", () => {
  const before = keys([
    summary("v1", { middle: "get /a" }),
    summary("v2", { newest: "get /a" }),
  ]);
  const after = keys([
    summary("v0", { first: "get /a" }),
    summary("v1", { middle: "get /a" }),
    summary("v2", { newest: "get /a" }),
  ]);
  assert.notEqual(before.v1!.middle, after.v1!.middle);
  assert.equal(after.v1!.middle, after.v2!.newest);
});

test("output stores one scalar per page, rather than cross-version reference arrays", () => {
  const versions = Array.from({ length: 260 }, (_, i) =>
    summary(`v${i}`, { stable: "get /a" }, ["root"]),
  );
  const result = matchApiVersions(versions);
  assert.equal(result.length, 260);
  assert.equal(
    result.reduce(
      (count, version) => count + Object.keys(version.byId).length,
      0,
    ),
    520,
  );
  assert.ok(JSON.stringify(result).length < 25_000);
  assert.ok(
    result.every(({ byId }) =>
      Object.values(byId).every((key) => typeof key === "string"),
    ),
  );
});

test("unversioned and prototype-shaped ids remain ordinary JSON data", () => {
  const result = matchApiVersions([
    summary(null, JSON.parse('{"__proto__":"get /a","constructor":"get /b"}')),
  ]);
  assert.equal(result[0]!.version, null);
  assert.equal(result[0]!.byId.__proto__, "__proto__");
  assert.equal(result[0]!.byId.constructor, "constructor");
  assert.deepEqual(
    JSON.parse(JSON.stringify(result))[0].byId,
    JSON.parse('{"__proto__":"__proto__","constructor":"constructor"}'),
  );
});

test("invalid cached summaries fail rather than silently overwriting pages", () => {
  assert.throws(
    () => matchApiVersions([summary("v1", {}), summary("v1", {})]),
    /Duplicate.*version/,
  );
  assert.throws(
    () =>
      matchApiVersions([
        {
          version: "v1",
          rows: [
            { id: "x", slug: "x" },
            { id: "x", slug: "y" },
          ],
          shapes: {},
        },
      ]),
    /Duplicate.*id/,
  );
  assert.throws(
    () =>
      matchApiVersions([
        { version: "v1", rows: [], shapes: { missing: "get /a" } },
      ]),
    /shape has no page/,
  );
});
