// The virtual:nimbus/coordinates emitter. The payload is baked into JS module
// source, so a coordinate key like `__proto__` must survive as an OWN property
// (an object-literal `{ "__proto__": … }` would set the prototype instead) —
// otherwise the null-prototype safeguard in the producer is silently undone at
// module-load time. Emission goes through `JSON.parse(<string literal>)`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  virtualCoordinatesPlugin,
  COORDINATES_RESOLVED_ID,
  type CoordinatesPayload,
} from "../src/_internal/virtual-coordinates.ts";
import { CoordinateIndex, type CoordinateIndexPayload } from "../src/_internal/api/coordinate-document.ts";

function evalModule(code: string): { index: CoordinateIndexPayload; manifest: unknown } {
  const exports: Record<string, unknown> = {};
  const body = code.replace(/export const (\w+) =/g, "exports.$1 =");
  new Function("exports", body)(exports);
  return exports as { index: CoordinateIndexPayload; manifest: unknown };
}

describe("virtualCoordinatesPlugin: hostile keys survive as own properties", () => {
  const scope = { scope: "zones", route: { path: "/zones", query: "" }, document: 0, hash: "x" };

  test("emits via JSON.parse; a `__proto__` coordinate does not pollute", () => {
    const payload: CoordinatesPayload = {
      index: {
        scopes: [scope],
        documents: ['{"version":3,"pages":[["create","createZone",{}]],"other":{"__proto__":["create",0]}}'],
      },
      manifest: { version: 3, collections: JSON.parse('{"__proto__":{"defaultVersion":null,"versions":[]}}') },
    };

    const code = virtualCoordinatesPlugin(() => payload).load(COORDINATES_RESOLVED_ID);
    assert.ok(typeof code === "string");
    assert.match(code, /JSON\.parse\(/);
    assert.doesNotMatch(code, /export const manifest = \{/, "must not emit a raw object literal");

    const mod = evalModule(code);
    const baked = (mod.manifest as { collections: object }).collections;
    assert.ok(
      Object.getOwnPropertyNames(baked).includes("__proto__"),
      "`__proto__` is an own property of the baked collections",
    );
    assert.equal(Object.getPrototypeOf(baked), Object.prototype, "the prototype was not hijacked");
    const index = CoordinateIndex.fromPayload(mod.index);
    assert.equal(index.get("zones:__proto__"), "/zones/create#__proto__");
    assert.equal(index.get("zones:createZone"), "/zones/create");
    assert.equal(index.get("zones:constructor"), undefined);
    // Global integrity: nothing leaked onto Object.prototype.
    assert.equal(({} as Record<string, unknown>).url, undefined);
  });

  test("U+2028/U+2029 in a value are escaped, not emitted raw (valid JS everywhere)", () => {
    const document = JSON.stringify({ version: 3, pages: [["a", "weird\u2028coord", { ".f": "a\u2029b" }]] });
    const payload: CoordinatesPayload = {
      index: { scopes: [scope], documents: [document] },
      manifest: { version: 3, collections: {} },
    };
    const code = virtualCoordinatesPlugin(() => payload).load(COORDINATES_RESOLVED_ID);
    assert.ok(typeof code === "string");
    assert.doesNotMatch(code, /[\u2028\u2029]/, "no raw line separators in the emitted source");
    assert.match(code, /\\u2028/);
    const mod = evalModule(code);
    assert.equal(mod.index.documents[0], document, "round-trips the exact characters");
    assert.equal(CoordinateIndex.fromPayload(mod.index).get("zones:weird\u2028coord.f"), "/zones/a#a\u2029b");
  });
});
