import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiFieldView, ApiUnionView } from "@cloudflare/nimbus-docs/api";
import { allowedValues, literalTokens, typeTokens, unionEntries, unionTitle } from "../../nimbus-starter-source/src/components/ui/api-field-row/type-display.ts";

const field = (over: Partial<ApiFieldView>): ApiFieldView =>
  ({ coordinate: "op.f", name: "f", type: "object", required: false, children: [], childCount: 0, truncated: false, ...over }) as ApiFieldView;

test("untitled branches labelled alike get no tooltip; titled ones keep theirs", () => {
  const anonymous: ApiUnionView = { kind: "oneOf", variants: [{ label: "object" }, { label: "object" }] };
  assert.equal(unionTitle(anonymous), undefined);
  const titled: ApiUnionView = { kind: "oneOf", variants: [{ label: "Payment", title: "Payment" }, { label: "Payment", title: "Payment" }] };
  assert.equal(unionTitle(titled), "Payment or Payment");
  const mixed: ApiUnionView = { kind: "oneOf", variants: [{ label: "object" }, { label: "string" }] };
  assert.equal(unionTitle(mixed), "object or string");
});

test("a mapped union lists mapped branches with values, then the unmapped ones", () => {
  const union: ApiUnionView = {
    kind: "oneOf",
    variants: [{ label: "Cat", name: "Cat" }, { label: "Dog", name: "Dog" }, { label: "Fish", name: "Fish" }],
    discriminator: "kind",
    mapping: [{ value: "cat", variant: { label: "Cat", name: "Cat" } }, { value: "dog", variant: { label: "Dog", name: "Dog" } }],
  };
  assert.deepEqual(unionEntries(union).map((e) => [e.variant.name, e.value]), [["Cat", "cat"], ["Dog", "dog"], ["Fish", undefined]]);
  assert.equal(unionTitle(union), "Cat or Dog or Fish");
});

test("a named union field shows its name, as a link only with a page", () => {
  const union: ApiUnionView = { kind: "oneOf", variants: [{ label: "object" }] };
  assert.deepEqual(typeTokens(field({ union, typeName: "Group" })).map((t) => [t.text, Boolean(t.href)]), [["Group", false]]);
  const linked = typeTokens(field({ union, typeName: "Group", typeRef: { label: "Group", href: "/api/schemas/group/" } }));
  assert.deepEqual(linked.map((t) => [t.text, t.href]), [["Group", "/api/schemas/group/"]]);
  assert.deepEqual(typeTokens(field({ union })), []);
});

test("a named array schema shows its name, then (array); an array of a named union says array of", () => {
  const union: ApiUnionView = { kind: "oneOf", variants: [{ label: "object" }, { label: "string" }] };
  const array = { type: "array<one of>", typeShape: { kind: "array", inner: "one of" } } as const;
  const whole = typeTokens(field({ ...array, union, typeName: "Groups", namedArray: true }));
  assert.deepEqual(whole.map((t) => t.text), ["Groups", "(array)"]);
  const items = typeTokens(field({ ...array, union, typeName: "Group" }));
  assert.deepEqual(items.map((t) => t.text), ["array of", "Group"]);
});

test("up to six allowed values sit in the type line; more are counted there and listed in full", () => {
  assert.deepEqual(literalTokens(["a", "b"], "string").map((t) => t.text), ["a", "or", "b"]);
  assert.equal(allowedValues(["a", "b"]), undefined);
  const countries = Array.from({ length: 140 }, (_, i) => `C${i}`);
  assert.deepEqual(literalTokens(countries, "string").map((t) => t.text), ["string", "·", "one of 140 values"]);
  assert.ok(literalTokens(countries, "string").every((t) => !t.title), "no hover-only tooltip");
  const list = allowedValues(countries)!;
  assert.equal(list.split(", ").length, 140, "every value, in the page text");
  assert.deepEqual(typeTokens(field({ type: "string", enum: countries })).map((t) => t.text), ["string", "·", "one of 140 values"]);
});
