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

function evalModule(code: string): { coordinates: unknown; manifest: unknown } {
  const exports: Record<string, unknown> = {};
  const body = code.replace(/export const (\w+) =/g, "exports.$1 =");
  new Function("exports", body)(exports);
  return exports as { coordinates: unknown; manifest: unknown };
}

describe("virtualCoordinatesPlugin: hostile keys survive as own properties", () => {
  test("emits via JSON.parse; a `__proto__` coordinate key does not pollute", () => {
    // Build the payload's entries via JSON.parse so `__proto__` is a genuine
    // OWN data property (a literal would set the prototype in the test itself).
    const entries = JSON.parse('{"__proto__":0,"createZone":null}');
    const payload: CoordinatesPayload = {
      coordinates: { "zones:createZone": "/zones/create" },
      manifest: { version: 2, collections: { zones: { defaultVersion: null, pages: [{ url: "/zones/create", entries }] } } },
    };

    const code = virtualCoordinatesPlugin(() => payload).load(COORDINATES_RESOLVED_ID);
    assert.ok(typeof code === "string");
    assert.match(code, /JSON\.parse\(/);
    assert.doesNotMatch(code, /export const manifest = \{/, "must not emit a raw object literal");

    const mod = evalModule(code);
    const baked = (mod.manifest as { collections: { zones: { pages: { entries: object }[] } } }).collections.zones.pages[0]!.entries;
    assert.ok(
      Object.getOwnPropertyNames(baked).includes("__proto__"),
      "`__proto__` is an own property of the baked entries",
    );
    assert.equal(Object.getPrototypeOf(baked), Object.prototype, "the prototype was not hijacked");
    // Global integrity: nothing leaked onto Object.prototype.
    assert.equal(({} as Record<string, unknown>).url, undefined);
  });

  test("U+2028/U+2029 in a value are escaped, not emitted raw (valid JS everywhere)", () => {
    const payload: CoordinatesPayload = {
      coordinates: { "zones:weird\u2028coord": "/zones/a\u2029b" },
      manifest: { version: 2, collections: {} },
    };
    const code = virtualCoordinatesPlugin(() => payload).load(COORDINATES_RESOLVED_ID);
    assert.ok(typeof code === "string");
    assert.doesNotMatch(code, /[\u2028\u2029]/, "no raw line separators in the emitted source");
    assert.match(code, /\\u2028/);
    const mod = evalModule(code);
    assert.equal(
      (mod.coordinates as Record<string, string>)["zones:weird\u2028coord"],
      "/zones/a\u2029b",
      "round-trips the exact characters",
    );
  });
});
