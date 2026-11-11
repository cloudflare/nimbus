// serializeRequest against OpenAPI's style examples and the support table.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PlanParam, RequestPlan, RequestValues } from "../src/_internal/try-it/plan.js";
import { parseExactJson, resolveServer, serializeRequest } from "../src/_internal/try-it/serialize.js";
import { checkScalar, validateValues } from "../src/_internal/try-it/validate.js";

const param = (over: Partial<PlanParam> & Pick<PlanParam, "in" | "name">): PlanParam => {
  const style = over.style ?? (over.in === "query" || over.in === "cookie" ? "form" : "simple");
  return { required: over.in === "path", style, explode: style === "form", allowReserved: false, schema: {}, ...over };
};

const plan = (over: Partial<RequestPlan> = {}): RequestPlan => ({
  kind: "openapi-http",
  id: { family: "api", coordinate: "op" },
  method: "GET",
  path: "/items",
  openapi: "3.1",
  servers: [{ url: "https://api.example.com/v1", variables: [] }],
  params: [],
  auth: [],
  send: { timeoutMs: 30_000, responseBytes: 2_000_000, uploadBytes: 4_000_000, credentials: "omit", servers: "spec" },
  ...over,
});

const send = (p: RequestPlan, values: Partial<RequestValues> = {}) => {
  const out = serializeRequest(p, { params: {}, ...values });
  if ("refused" in out) throw new Error(`refused: ${out.refused}`);
  return out;
};
const refused = (p: RequestPlan, values: Partial<RequestValues> = {}) => {
  const out = serializeRequest(p, { params: {}, ...values });
  assert.ok("refused" in out, "expected a refusal");
  return out.refused;
};

const blue = "blue";
const list = ["blue", "black", "brown"];
const rgb = { R: 100, G: 200, B: 150 };

describe("OpenAPI's style examples", () => {
  const pathCase = (style: string, explode: boolean, value: unknown) =>
    send(plan({ path: "/c/{color}", params: [param({ in: "path", name: "color", style, explode })] }), {
      params: { "path:color": value },
    }).url.replace("https://api.example.com/v1/c/", "");
  const queryCase = (style: string, explode: boolean, value: unknown) =>
    send(plan({ params: [param({ in: "query", name: "color", style, explode })] }), {
      params: { "query:color": value },
    }).url.replace("https://api.example.com/v1/items?", "");

  const table: [string, boolean, (s: string, e: boolean, v: unknown) => string, [string, string, string]][] = [
    ["simple", false, pathCase, ["blue", "blue,black,brown", "R,100,G,200,B,150"]],
    ["simple", true, pathCase, ["blue", "blue,black,brown", "R=100,G=200,B=150"]],
    ["label", false, pathCase, [".blue", ".blue,black,brown", ".R,100,G,200,B,150"]],
    ["label", true, pathCase, [".blue", ".blue.black.brown", ".R=100.G=200.B=150"]],
    ["matrix", false, pathCase, [";color=blue", ";color=blue,black,brown", ";color=R,100,G,200,B,150"]],
    ["matrix", true, pathCase, [";color=blue", ";color=blue;color=black;color=brown", ";R=100;G=200;B=150"]],
    ["form", false, queryCase, ["color=blue", "color=blue,black,brown", "color=R,100,G,200,B,150"]],
    ["form", true, queryCase, ["color=blue", "color=blue&color=black&color=brown", "R=100&G=200&B=150"]],
  ];
  for (const [style, explode, run, [scalar, array, object]] of table) {
    test(`${style}, explode ${explode}`, () => {
      assert.equal(run(style, explode, blue), scalar);
      assert.equal(run(style, explode, list), array);
      assert.equal(run(style, explode, rgb), object);
    });
  }

  test("spaceDelimited and pipeDelimited, unexploded, arrays and objects", () => {
    assert.equal(queryCase("spaceDelimited", false, list), "color=blue%20black%20brown");
    assert.equal(queryCase("spaceDelimited", false, rgb), "color=R%20100%20G%20200%20B%20150");
    assert.equal(queryCase("pipeDelimited", false, list), "color=blue%7Cblack%7Cbrown");
  });

  test("deepObject", () => {
    assert.equal(queryCase("deepObject", true, rgb), "color[R]=100&color[G]=200&color[B]=150");
  });

  test("empty values", () => {
    assert.equal(pathCase("matrix", false, ""), ";color");
    assert.equal(queryCase("form", true, ""), "color=");
  });

  test("allowReserved keeps reserved characters in a query value", () => {
    const p = plan({ params: [param({ in: "query", name: "q", allowReserved: true })] });
    assert.equal(send(p, { params: { "query:q": "a/b?c:d" } }).url, "https://api.example.com/v1/items?q=a/b?c:d");
    const strict = plan({ params: [param({ in: "query", name: "q" })] });
    assert.equal(send(strict, { params: { "query:q": "a/b?c:d" } }).url, "https://api.example.com/v1/items?q=a%2Fb%3Fc%3Ad");
  });

  test("a JSON content parameter is sent as its JSON text", () => {
    const p = plan({ params: [param({ in: "query", name: "filter", content: "application/json" })] });
    assert.equal(send(p, { params: { "query:filter": { a: 1 } } }).url, "https://api.example.com/v1/items?filter=%7B%22a%22%3A1%7D");
    // A JSON string keeps its quotes; text content goes as typed.
    assert.equal(send(p, { params: { "query:filter": "hello" } }).url, "https://api.example.com/v1/items?filter=%22hello%22");
    const textual = plan({ params: [param({ in: "query", name: "q", content: "text/plain" })] });
    assert.equal(send(textual, { params: { "query:q": "hello" } }).url, "https://api.example.com/v1/items?q=hello");
  });
});

describe("undefined combinations are refused, the rest sent", () => {
  test("delimited with explode, deepObject without it, a style outside its location", () => {
    assert.match(refused(plan({ params: [param({ in: "query", name: "c", style: "spaceDelimited", explode: true })] }), { params: { "query:c": list } }), /explode/);
    assert.match(refused(plan({ params: [param({ in: "query", name: "c", style: "deepObject", explode: false })] }), { params: { "query:c": rgb } }), /deepObject/);
    assert.match(refused(plan({ params: [param({ in: "header", name: "X-C", style: "form" })] }), { params: { "header:X-C": "a" } }), /form style/);
    assert.match(refused(plan({ params: [param({ in: "query", name: "c", style: "deepObject", explode: true })] }), { params: { "query:c": { a: { b: 1 } } } }), /nested/);
  });

  test("absent, empty and required", () => {
    const p = plan({ params: [param({ in: "query", name: "opt" }), param({ in: "query", name: "req", required: true })] });
    assert.match(refused(p), /Fill in req/);
    assert.equal(send(p, { params: { "query:req": "" } }).url, "https://api.example.com/v1/items?req=");
    assert.equal(send(p, { params: { "query:req": "x", "query:opt": "" } }).url, "https://api.example.com/v1/items?opt=&req=x");
  });

  test("path values are encoded into one segment; dot segments refused", () => {
    const p = plan({ path: "/f/{id}", params: [param({ in: "path", name: "id" })] });
    for (const bad of [".", ".."]) assert.match(refused(p, { params: { "path:id": bad } }), /would make \/f\/\{id\} read/);
    // Label style can build a dot segment out of empty items.
    const label = plan({ path: "/accounts/{id}/settings", params: [param({ in: "path", name: "id", style: "label", explode: true })] });
    assert.match(refused(label, { params: { "path:id": ["", ""] } }), /would make \/accounts\/\{id\}\/settings read \/accounts\/\.\.\/settings/);
    assert.equal(send(label, { params: { "path:id": ["a", "b"] } }).url, "https://api.example.com/v1/accounts/.a.b/settings");
    assert.equal(send(p, { params: { "path:id": "a%2Fb" } }).url, "https://api.example.com/v1/f/a%252Fb");
    assert.equal(send(p, { params: { "path:id": "a b" } }).url, "https://api.example.com/v1/f/a%20b");
    assert.equal(send(p, { params: { "path:id": "Europe/London" } }).url, "https://api.example.com/v1/f/Europe%2FLondon");
  });

  test("header parameters", () => {
    const p = plan({ params: [param({ in: "header", name: "X-Tags" }), param({ in: "header", name: "Accept", ignored: true })] });
    assert.deepEqual(send(p, { params: { "header:X-Tags": list, "header:Accept": "x" } }).headers, [["X-Tags", "blue,black,brown"]]);
    assert.match(refused(p, { params: { "header:X-Tags": "a\r\nb" } }), /line break/);
    assert.match(refused(plan({ params: [param({ in: "header", name: "Host" })] }), { params: { "header:Host": "x" } }), /can't be sent/);
  });

  test("TRACE and a body on GET", () => {
    assert.match(refused(plan({ method: "TRACE", refused: "TRACE requests can't be sent from here." })), /TRACE/);
    const get = plan({ body: { required: false, media: [{ mediaType: "application/json", kind: "json" }], examples: [] } });
    assert.match(refused(get, { body: { mediaType: "application/json", value: {} } }), /GET request can't carry a body/);
  });
});

describe("cookies, one header by Nimbus's convention", () => {
  test("scalars, arrays and objects; percent-encoding outside cookie-octet", () => {
    const p = plan({
      params: [
        param({ in: "cookie", name: "s", explode: false }),
        param({ in: "cookie", name: "a", explode: false }),
        param({ in: "cookie", name: "e" }),
        param({ in: "cookie", name: "o" }),
      ],
      auth: [{ label: "API key in cookie", schemes: [{ scheme: "k", type: "apiKey", in: "cookie", name: "key" }] }],
    });
    const out = send(p, {
      params: { "cookie:s": "a b;c", "cookie:a": ["x", "y"], "cookie:e": ["1", "2"], "cookie:o": { k: "v" } },
      auth: { alternative: 0, credentials: { k: "sec" } },
    });
    assert.deepEqual(out.headers, [["Cookie", "s=a%20b%3Bc; a=x,y; e=1; e=2; k=v; key=sec"]]);
  });

  test("every Cookie header joins them, a parameter's or a key's first, as the samples send it", () => {
    const p = plan({
      params: [param({ in: "header", name: "Cookie" }), param({ in: "cookie", name: "pref" })],
      auth: [{ label: "Keys", schemes: [
        { scheme: "h", type: "apiKey", in: "header", name: "cookie" },
        { scheme: "k", type: "apiKey", in: "cookie", name: "key" },
      ] }],
    });
    const out = send(p, { params: { "header:Cookie": "theme=dark", "cookie:pref": "1" }, auth: { alternative: 0, credentials: { h: "sid=1", k: "sec" } } });
    assert.deepEqual(out.headers, [["Cookie", "theme=dark; sid=1; pref=1; key=sec"]]);
  });

  test("an empty Cookie header parameter adds nothing", () => {
    const p = plan({ params: [param({ in: "header", name: "Cookie", required: true })], auth: [{ label: "k", schemes: [{ scheme: "k", type: "apiKey", in: "cookie", name: "key" }] }] });
    assert.deepEqual(send(p, { params: { "header:Cookie": "" }, auth: { alternative: 0, credentials: { k: "sec" } } }).headers, [["Cookie", "key=sec"]]);
  });
});

describe("one header of each", () => {
  test("two Authorization headers: the last, as the samples send it", () => {
    const p = plan({ auth: [{ label: "Both", schemes: [
      { scheme: "key", type: "apiKey", in: "header", name: "Authorization" },
      { scheme: "bearer", type: "bearer" },
    ] }] });
    const out = send(p, { auth: { alternative: 0, credentials: { key: "Key x", bearer: "tok" } } });
    assert.deepEqual(out.headers, [["Authorization", "Bearer tok"]]);
  });

  test("a key named Content-Type is refused with a body, never dropped; without one it's sent", () => {
    const auth = [{ label: "k", schemes: [{ scheme: "k", type: "apiKey" as const, in: "header" as const, name: "Content-Type" }] }];
    const creds = { auth: { alternative: 0, credentials: { k: "text/x" } } };
    const json = plan({ method: "POST", auth, body: { required: true, examples: [], media: [{ mediaType: "application/json", kind: "json" }] } });
    assert.match(refused(json, { body: { mediaType: "application/json", value: "{}" }, ...creds }), /Content-Type header/);
    const multi = plan({ method: "POST", auth, body: { required: true, examples: [], media: [{ mediaType: "multipart/form-data", kind: "multipart", fields: [] }] } });
    assert.match(refused(multi, { body: { mediaType: "multipart/form-data", value: { fields: [] } }, ...creds }), /Content-Type header/);
    assert.deepEqual(send(plan({ auth }), creds).headers, [["Content-Type", "text/x"]]);
  });
});

describe("servers", () => {
  test("variables: path ones as encoded segments, authority ones as given", () => {
    const p = plan({
      servers: [{
        url: "https://{region}.example.com/{base}",
        variables: [
          { name: "region", default: "eu", enum: ["eu", "us"], authority: true },
          { name: "base", default: "v1", authority: false },
        ],
      }],
    });
    assert.equal(send(p).url, "https://eu.example.com/v1/items");
    assert.equal(send(p, { server: { index: 0, variables: { region: "us", base: "v 2" } } }).url, "https://us.example.com/v%202/items");
    assert.equal(send(p, { server: { index: 0, variables: { base: "api/v 2" } } }).url, "https://eu.example.com/api/v%202/items");
    for (const base of ["a/../b", "a//b", "..", "a%2Fb", "a\\b"]) {
      assert.match(refused(p, { server: { index: 0, variables: { base } } }), /must be path segments/, base);
    }
  });

  test("relative servers and the default / resolve against the spec URL, else the docs origin", () => {
    const rel = plan({ servers: [{ url: "/api", variables: [] }] });
    assert.equal(serializeRequestUrl(rel, "https://docs.example.com"), "https://docs.example.com/api/items");
    assert.equal(serializeRequestUrl({ ...rel, specUrl: "https://spec.example.com/x/openapi.json" }, "https://docs.example.com"), "https://spec.example.com/api/items");
    assert.equal(serializeRequestUrl(plan({ servers: [{ url: "/", variables: [] }] }), "https://docs.example.com"), "https://docs.example.com/items");
  });

  test("an edited origin keeps the spec server's path", () => {
    const out = send(plan(), { server: { index: 0, origin: "https://staging.example.com" } });
    assert.equal(out.url, "https://staging.example.com/v1/items");
    assert.match(refused(plan(), { server: { index: 0, origin: "https://staging.example.com/other" } }), /origin only/);
    assert.match(refused(plan(), { server: { index: 0, origin: "ftp://x" } }), /http or https/);
  });

  test("a server's own query stays before the parameters", () => {
    const p = plan({ servers: [{ url: "https://x.test/v1?key=1", variables: [] }], params: [param({ in: "query", name: "q" })] });
    assert.equal(send(p, { params: { "query:q": "a" } }).url, "https://x.test/v1/items?key=1&q=a");
  });

  test("a non-http server is refused", () => {
    assert.match(refused(plan({ servers: [{ url: "ws://x.test", variables: [] }] })), /http or https/);
  });
});

function serializeRequestUrl(p: RequestPlan, origin: string): string {
  const out = serializeRequest(p, { params: {} }, { origin });
  if ("refused" in out) throw new Error(out.refused);
  return out.url;
}

describe("auth", () => {
  const schemes = plan({
    auth: [
      { label: "Bearer token", schemes: [{ scheme: "bearer", type: "bearer" }] },
      { label: "Username and password", schemes: [{ scheme: "basic", type: "basic" }] },
      { label: "API key in query", schemes: [{ scheme: "q", type: "apiKey", in: "query", name: "api_key" }] },
      { label: "No auth", schemes: [] },
      { label: "x (not supported here)", schemes: [], unsupported: "Mutual TLS can't be sent from a browser." },
    ],
  });
  test("each type, with its secrets marked", () => {
    const bearer = send(schemes, { auth: { alternative: 0, credentials: { bearer: "tok" } } });
    assert.deepEqual(bearer.headers, [["Authorization", "Bearer tok"]]);
    assert.deepEqual(bearer.secrets, [{ value: "tok", label: "token" }]);
    const basic = send(schemes, { auth: { alternative: 1, credentials: { basic: { username: "ü", password: "p" } } } });
    assert.deepEqual(basic.headers, [["Authorization", `Basic ${Buffer.from("ü:p").toString("base64")}`]]);
    assert.equal(send(schemes, { auth: { alternative: 2, credentials: { q: "k y" } } }).url, "https://api.example.com/v1/items?api_key=k%20y");
    assert.deepEqual(send(schemes, { auth: { alternative: 3, credentials: {} } }).headers, []);
    assert.match(refused(schemes, { auth: { alternative: 4, credentials: {} } }), /Mutual TLS/);
    assert.match(refused(schemes, { auth: { alternative: 0, credentials: {} } }), /Enter the token/);
  });
});

describe("bodies", () => {
  const post = (kind: "json" | "form" | "multipart" | "text" | "bytes", mediaType: string, required = true) =>
    plan({ method: "POST", body: { required, media: [{ mediaType, kind }], examples: [] } });

  test("JSON: the editor's text, as typed; invalid JSON refused", () => {
    const out = send(post("json", "application/json"), { body: { mediaType: "application/json", value: '{"a": 1}' } });
    assert.deepEqual(out.body, { kind: "json", mediaType: "application/json", text: '{"a": 1}' });
    assert.deepEqual(out.headers, [["Content-Type", "application/json"]]);
    assert.match(refused(post("json", "application/json"), { body: { mediaType: "application/json", value: "{" } }), /valid JSON/);
  });

  test("a URL-encoded form keeps order and repeats", () => {
    const out = send(post("form", "application/x-www-form-urlencoded"), {
      body: { mediaType: "application/x-www-form-urlencoded", value: { fields: [{ name: "a", value: "1" }, { name: "a", value: "x y" }] } },
    });
    assert.deepEqual(out.body, { kind: "form", fields: [{ name: "a", value: "1" }, { name: "a", value: "x y" }] });
  });

  test("URL-encoded list and object fields follow their encoding, as the code samples write them", () => {
    const form = (encoding?: { style?: string; explode?: boolean; contentType?: string }) =>
      plan({
        method: "POST",
        body: {
          required: true,
          examples: [],
          media: [{
            mediaType: "application/x-www-form-urlencoded",
            kind: "form",
            fields: [
              { name: "tags", required: false, schema: { type: "array" }, ...(encoding ? { encoding } : {}) },
              { name: "pt", required: false, schema: { type: "object" }, ...(encoding ? { encoding } : {}) },
            ],
          }],
        },
      });
    // What goes on the wire: the fields encoded, or the already-encoded text.
    const wire = (p: RequestPlan, values: { name: string; value: string }[]) => {
      const out = send(p, { body: { mediaType: "application/x-www-form-urlencoded", value: { fields: values } } });
      if (out.body?.kind === "form") return new URLSearchParams(out.body.fields.map(({ name, value }) => [name, value])).toString();
      return out.body?.kind === "text" ? out.body.text : "";
    };
    const tags = { name: "tags", value: '["a","b"]' };
    const pt = { name: "pt", value: '{"x":1,"y":2}' };
    assert.equal(wire(form(), [tags, pt]), "tags=a&tags=b&pt%5Bx%5D=1&pt%5By%5D=2", "no encoding entry: repeat lists, nest objects");
    assert.equal(wire(form({ contentType: "application/json" }), [pt]), "pt=%7B%22x%22%3A1%2C%22y%22%3A2%7D", "an entry without style rules: its content type");
    assert.equal(wire(form({ style: "form" }), [tags, pt]), "tags=a&tags=b&x=1&y=2", "form explodes by default");
    assert.equal(wire(form({ explode: false }), [tags, pt]), "tags=a,b&pt=x,1,y,2");
    assert.equal(wire(form({ style: "pipeDelimited", explode: false }), [tags, pt]), "tags=a|b&pt=x|1|y|2");
    assert.equal(wire(form({ style: "spaceDelimited", explode: false }), [pt]), "pt=x%201%20y%202");
    assert.equal(wire(form({ style: "deepObject", explode: true }), [pt]), "pt%5Bx%5D=1&pt%5By%5D=2");
    assert.equal(wire(form(), [{ name: "tags", value: "solo" }]), "tags=solo", "plain text is one item of a list field");
    // A number field with a JSON content type: the number, not a quoted string.
    const counted = plan({
      method: "POST",
      body: {
        required: true,
        examples: [],
        media: [{
          mediaType: "application/x-www-form-urlencoded",
          kind: "form",
          fields: [
            { name: "count", required: false, schema: { type: "integer" }, encoding: { contentType: "application/json" } },
            { name: "on", required: false, schema: { type: "boolean" }, encoding: { contentType: "application/json" } },
          ],
        }],
      },
    });
    assert.equal(wire(counted, [{ name: "count", value: "42" }, { name: "on", value: "true" }]), "count=42&on=true");
    assert.equal(wire(counted, [{ name: "count", value: "0x10" }]), "count=%220x10%22", "text that isn't a JSON number stays text");
    assert.equal(wire(counted, [{ name: "count", value: "1e3" }, { name: "on", value: "false" }]), "count=1000&on=false", "any JSON number is a number");
    const big = (value: string) => refused(counted, { body: { mediaType: "application/x-www-form-urlencoded", value: { fields: [{ name: "count", value }] } } });
    assert.match(big("9007199254740993"), /count: 9007199254740993 can't be sent exactly/, "refused, never rounded");
    assert.match(refused(form(), { body: { mediaType: "application/x-www-form-urlencoded", value: { fields: [{ name: "tags", value: "[9007199254740993]" }] } } }), /can't be sent exactly/, "inside a list too");
    // A field named like a prototype key is a field like any other.
    const proto = plan({ method: "POST", body: { required: true, examples: [], media: [{ mediaType: "application/x-www-form-urlencoded", kind: "form", fields: [{ name: "__proto__", required: false, schema: { type: "string" } }] }] } });
    assert.equal(wire(proto, [{ name: "__proto__", value: "x" }]), "__proto__=x");
    assert.match(refused(form(), { body: { mediaType: "application/x-www-form-urlencoded", value: { fields: [{ name: "pt", value: "x" }] } } }), /pt must be a JSON object/);
  });

  test("multipart list and object fields: a part per item, objects as JSON", () => {
    const p = plan({
      method: "POST",
      body: {
        required: true,
        examples: [],
        media: [{
          mediaType: "multipart/form-data",
          kind: "multipart",
          fields: [
            { name: "tags", required: false, schema: { type: "array" } },
            { name: "meta", required: false, schema: { type: "object" } },
            { name: "csv", required: false, schema: { type: "object" }, encoding: { contentType: "text/csv" } },
          ],
        }],
      },
    });
    const out = send(p, {
      body: { mediaType: "multipart/form-data", value: { fields: [{ name: "tags", value: '["a","b"]' }, { name: "meta", value: '{"k":1}' }, { name: "csv", value: '{"k":1}' }] } },
    });
    assert.equal(out.body?.kind, "multipart");
    const parts = out.body?.kind === "multipart" ? out.body.parts.map(({ name, value, contentType }) => [name, value, contentType ?? null]) : [];
    assert.deepEqual(parts, [["tags", "a", null], ["tags", "b", null], ["meta", '{"k":1}', "application/json"], ["csv", '{"k":1}', "text/csv"]]);
  });

  test("multipart: an explicit style or explode applies in 3.1, in place of the content type; 3.0 ignores it", () => {
    const p = (openapi: "3.0" | "3.1") =>
      plan({
        method: "POST",
        openapi,
        body: {
          required: true,
          examples: [],
          media: [{
            mediaType: "multipart/form-data",
            kind: "multipart",
            fields: [{ name: "tags", required: false, schema: { type: "array" }, encoding: { style: "form", explode: false, contentType: "text/csv" } }],
          }],
        },
      });
    const parts = (openapi: "3.0" | "3.1") => {
      const out = send(p(openapi), { body: { mediaType: "multipart/form-data", value: { fields: [{ name: "tags", value: '["a","b"]' }] } } });
      return out.body?.kind === "multipart" ? out.body.parts.map(({ name, value, contentType }) => [name, value, contentType ?? null]) : [];
    };
    assert.deepEqual(parts("3.1"), [["tags", "a,b", null]]);
    assert.deepEqual(parts("3.0"), [["tags", "a", "text/csv"], ["tags", "b", "text/csv"]]);
  });

  test("a refused media type says why", () => {
    const p = plan({ method: "POST", body: { required: true, examples: [], media: [{ mediaType: "multipart/form-data", kind: "multipart", fields: [], refused: "The file part needs a X-Checksum header." }] } });
    assert.match(refused(p, { body: { mediaType: "multipart/form-data", value: { fields: [] } } }), /X-Checksum/);
  });

  test("multipart parts keep files and their content types", () => {
    const file = new Blob(["hi"], { type: "text/plain" });
    const out = send(post("multipart", "multipart/form-data"), {
      body: { mediaType: "multipart/form-data", value: { fields: [{ name: "f", value: file, filename: "a.txt" }, { name: "n", value: "x" }] } },
    });
    assert.equal(out.body?.kind, "multipart");
    assert.equal(out.headers.length, 0, "the client writes the multipart Content-Type with its boundary");
  });

  test("a required body must be sent; an optional one may be left out", () => {
    assert.match(refused(post("json", "application/json")), /needs a body/);
    assert.equal(send(post("json", "application/json", false)).body, undefined);
  });

  test("raw text and bytes", () => {
    assert.deepEqual(send(post("text", "application/xml"), { body: { mediaType: "application/xml", value: "<a/>" } }).body, {
      kind: "text",
      mediaType: "application/xml",
      text: "<a/>",
    });
    const bytes = send(post("bytes", "application/octet-stream"), { body: { mediaType: "application/octet-stream", value: new Blob([new Uint8Array([1, 2])]) } });
    assert.equal(bytes.body?.kind, "bytes");
  });
});

describe("parseExactJson", () => {
  test("parses JSON; refuses an integer a number would round, but not one in a string", () => {
    assert.deepEqual(parseExactJson('{"id": 42, "n": 1.5e3, "big": "9007199254740993"}'), { id: 42, n: 1500, big: "9007199254740993" });
    for (const spelling of ["9007199254740993", "9007199254740993.0", "9007199254740993e0", "1e309", "-1e309", "1e-400", "1.0000000000000001", "9007199254740991.1"]) {
      assert.throws(() => parseExactJson(`{"id": ${spelling}}`), RangeError, spelling);
    }
    assert.deepEqual(parseExactJson("[1e3, 1.50e2, 0.1, -0, 0.0, 9007199254740991, 2.5e-7]"), [1000, 150, 0.1, -0, 0, 9007199254740991, 2.5e-7]);
    assert.throws(() => parseExactJson("{"), SyntaxError);
  });
});

describe("names a spec may use", () => {
  test("a scheme or server variable named __proto__ is a name like any other", () => {
    const p = plan({
      servers: [{ url: "https://api.example.com/{__proto__}", variables: [{ name: "__proto__", default: "v1", authority: false }] }],
      auth: [{ label: "Bearer token", schemes: [{ scheme: "__proto__", type: "bearer" }] }],
    });
    const credentials = Object.create(null) as Record<string, string>;
    credentials["__proto__"] = "tok";
    const out = send(p, { auth: { alternative: 0, credentials } });
    assert.equal(out.url, "https://api.example.com/v1/items");
    assert.deepEqual(out.headers, [["Authorization", "Bearer tok"]]);
    assert.match(refused(p, { auth: { alternative: 0, credentials: {} } }), /Enter the/);
  });

  test("resolveServer is the request's own server, an inherited variable name included", () => {
    const p = plan({
      servers: [{ url: "https://{constructor}.first.test/{version}", variables: [{ name: "constructor", default: "api", authority: true }, { name: "version", default: "v1", authority: false }] }],
    });
    const values = { params: {}, server: { index: 0, variables: { version: "v2" } } };
    assert.equal(resolveServer(p, values)?.href, "https://api.first.test/v2");
    assert.equal(new URL(send(p, values).url).origin, resolveServer(p, values)?.origin);
    assert.equal(resolveServer(p, { params: {}, server: { index: 0, origin: "not a url" } }), null);
  });

  test("a custom format named like a prototype key isn't checked, and doesn't throw", () => {
    for (const format of ["constructor", "toString", "__proto__"]) assert.deepEqual(checkScalar({ type: "string", format }, "x"), [], format);
  });
});

describe("a form field with a JSON content type holds JSON text", () => {
  const jsonForm = () =>
    plan({
      method: "POST",
      body: {
        required: true,
        examples: [],
        media: [{
          mediaType: "application/x-www-form-urlencoded",
          kind: "form",
          fields: ["n", "s", "u", "b", "big", "plain"].map((name) => ({ name, required: false, schema: name === "big" ? { type: "integer" as const } : {}, encoding: { contentType: "application/json" } })),
        }],
      },
    });
  const fields = (list: [string, string][]) => ({ body: { mediaType: "application/x-www-form-urlencoded", value: { fields: list.map(([name, value]) => ({ name, value })) } } });

  test("null, numbers, booleans and strings as written; text that isn't JSON is a string, encoded once", () => {
    const out = send(jsonForm(), fields([["n", "null"], ["s", '"hi"'], ["u", "123"], ["b", "true"], ["plain", "hello"]]));
    assert.deepEqual(out.body, { kind: "form", fields: [
      { name: "n", value: "null" }, { name: "s", value: '"hi"' }, { name: "u", value: "123" }, { name: "b", value: "true" }, { name: "plain", value: '"hello"' },
    ] });
  });

  test("an integer a number would round is refused, never rounded", () => {
    assert.match(refused(jsonForm(), fields([["big", "9007199254740993"]])), /big/);
  });
});

describe("required form fields", () => {
  const formPlan = (kind: "form" | "multipart", mediaType: string) =>
    plan({
      method: "POST",
      body: {
        required: true,
        examples: [],
        media: [{
          mediaType,
          kind,
          fields: [
            { name: "title", required: true, schema: { type: "string" } },
            { name: "upload", required: kind === "multipart", schema: { type: "string", format: "binary" }, ...(kind === "multipart" ? { file: "one" as const } : {}) },
          ],
        }],
      },
    });

  test("a missing required field stops Send, a file part included; one left empty is sent, as a parameter's is", () => {
    const p = formPlan("multipart", "multipart/form-data");
    const missing = validateValues(p, { params: {}, body: { mediaType: "multipart/form-data", value: { fields: [] } } });
    assert.deepEqual(missing.map((i) => [i.key, i.message, i.blocking]), [["body:title", "Required.", true], ["body:upload", "Choose a file.", true]]);
    const empty = validateValues(p, { params: {}, body: { mediaType: "multipart/form-data", value: { fields: [{ name: "title", value: "" }, { name: "upload", value: new Blob([]) }] } } });
    assert.deepEqual(empty, []);
  });

  test("a field the spec doesn't declare sends its list or object as the samples do", () => {
    const form = plan({ method: "POST", body: { required: true, examples: [], media: [{ mediaType: "application/x-www-form-urlencoded", kind: "form", fields: [] }] } });
    const out = send(form, { body: { mediaType: "application/x-www-form-urlencoded", value: { fields: [{ name: "tags", value: '["p","q"]', json: true }, { name: "meta", value: '{"x":1}', json: true }, { name: "note", value: '["looks","like","json"]' }] } } });
    // `note` is a string that only looks like JSON: one field, as the sample sends it.
    assert.deepEqual(out.body, { kind: "form", fields: [{ name: "tags", value: "p" }, { name: "tags", value: "q" }, { name: "meta[x]", value: "1" }, { name: "note", value: '["looks","like","json"]' }] });
    const multi = plan({ method: "POST", body: { required: true, examples: [], media: [{ mediaType: "multipart/form-data", kind: "multipart", fields: [] }] } });
    const parts = send(multi, { body: { mediaType: "multipart/form-data", value: { fields: [{ name: "meta", value: '{"x":1}', json: true }] } } });
    assert.deepEqual(parts.body, { kind: "multipart", parts: [{ name: "meta", value: '{"x":1}', contentType: "application/json" }] });
  });

  test("filled in, nothing is flagged", () => {
    const p = formPlan("form", "application/x-www-form-urlencoded");
    const issues = validateValues(p, { params: {}, body: { mediaType: "application/x-www-form-urlencoded", value: { fields: [{ name: "title", value: "hi" }] } } });
    assert.deepEqual(issues, []);
  });
});

describe("required JSON properties", () => {
  const p = plan({
    method: "POST",
    body: {
      required: true,
      examples: [],
      media: [{ mediaType: "application/json", kind: "json", fields: [{ name: "url", required: true, schema: { type: "string" } }, { name: "note", required: false, schema: { type: "string" } }] }],
    },
  });
  const check = (text: string) => validateValues(p, { params: {}, body: { mediaType: "application/json", value: text } }).map((i) => [i.key, i.message, i.blocking]);

  test("one missing stops Send, by its key; present, even empty, is sent", () => {
    assert.deepEqual(check('{"note": "n"}'), [["body:url", "Required.", true]]);
    assert.deepEqual(check('{"url": ""}'), []);
  });

  test("a body that isn't an object is only checked as JSON", () => {
    assert.deepEqual(check("[1]"), []);
    assert.equal(check("{")[0]![0], "body");
  });
});

test("null passes where the enum lists it", () => {
  assert.deepEqual(checkScalar({ enum: [null, "x"] }, null), []);
  assert.equal(checkScalar({ enum: ["x"] }, null)[0]!.message, "Can't be null.");
});
