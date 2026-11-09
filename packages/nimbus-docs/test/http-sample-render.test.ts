// The HTTP sample boundary: requests built by hand, with no OpenAPI front-end,
// render in every language, and the HTTP modules import nothing protocol- or
// page-specific.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { placeholder, text, type SampleRequest } from "../src/_internal/api/http-sample.js";
import { HTTP_SAMPLE_TARGETS, renderCurl, renderFetch, renderPython, sampleUrl } from "../src/_internal/api/http-sample-render.js";

const get: SampleRequest = {
  method: "GET",
  url: [text("https://API.example.com/v1/items/"), placeholder("id")],
  query: [{ name: "limit", value: [text("10")] }],
  headers: [{ name: "X-API-Key", value: [placeholder("X-API-Key", true)] }],
  cookies: [],
};

describe("HTTP sample renderers, without an API front-end", () => {
  test("every target renders a hand-built request", () => {
    assert.deepEqual(HTTP_SAMPLE_TARGETS.map((t) => t.lang), ["curl", "typescript", "python"]);
    for (const target of HTTP_SAMPLE_TARGETS) assert.ok(target.render(get), target.lang);
  });

  test("cURL", () => {
    assert.equal(
      renderCurl(get),
      [
        "curl --request GET \\",
        "  --url 'https://api.example.com/v1/items/<id>?limit=10' \\",
        "  --header 'X-API-Key: <X-API-Key>'",
      ].join("\n"),
    );
  });

  test("TypeScript (fetch)", () => {
    assert.equal(
      renderFetch(get),
      [
        "const url = 'https://api.example.com/v1/items/<id>?limit=10';",
        "const options = {method: 'GET', headers: {'X-API-Key': '<X-API-Key>'}};",
        "",
        "fetch(url, options)",
        "  .then(res => res.json())",
        "  .then(json => console.log(json))",
        "  .catch(err => console.error(err));",
      ].join("\n"),
    );
  });

  test("Python (requests)", () => {
    assert.equal(
      renderPython(get),
      [
        "import requests",
        "",
        'url = "https://api.example.com/v1/items/<id>?limit=10"',
        "",
        'headers = {"X-API-Key": "<X-API-Key>"}',
        "",
        "response = requests.get(url, headers=headers)",
        "",
        "print(response.text)",
      ].join("\n"),
    );
  });

  test("a placeholder is never encoded, and text that looks like one is", () => {
    const url = sampleUrl({
      url: [text("https://x.test/a/<id>/"), placeholder("id")],
      query: [{ name: "q", value: [text("<id>")] }, { name: "p", value: [placeholder("p")] }],
    });
    assert.deepEqual(url, [
      { text: "https://x.test/a/%3Cid%3E/" },
      { placeholder: "id" },
      { text: "?q=%3Cid%3E&p=" },
      { placeholder: "p" },
    ]);
  });

  test("the options object wraps when its one line passes 80 characters, placeholder names included", () => {
    const request: SampleRequest = {
      method: "GET",
      url: [text("https://x.test/")],
      query: [],
      headers: [
        { name: "X-Auth-Email", value: [placeholder("X-Auth-Email", true)] },
        { name: "X-Auth-Key", value: [placeholder("X-Auth-Key", true)] },
      ],
      cookies: [],
    };
    assert.match(renderFetch(request)!, /const options = \{\n {2}method: 'GET',\n {2}headers: \{'X-Auth-Email': '<X-Auth-Email>', 'X-Auth-Key': '<X-Auth-Key>'\}\n\};/);
  });

  test("bodies: JSON, form, text and multipart", () => {
    const post = (body: SampleRequest["body"], headers: SampleRequest["headers"] = []): SampleRequest =>
      ({ method: "POST", url: [text("https://x.test/v1")], query: [], headers, cookies: [], body });
    const json = post({ kind: "json", mediaType: "application/json", value: { name: "it's a longer name" } }, [{ name: "Content-Type", value: [text("application/json")] }]);
    assert.match(renderCurl(json)!, /--data @- <<'EOF'\n\{\n {2}"name": "it's a longer name"\n\}\nEOF$/);
    assert.match(renderPython(json)!, /payload = \{ "name": "it's a longer name" \}[\s\S]*requests\.post\(url, json=payload, headers=headers\)/);
    assert.match(renderFetch(json)!, /body: JSON\.stringify\(\{name: 'it\\'s a longer name'\}\)/);

    const form = post({ kind: "form", fields: [{ name: "a", value: "1" }, { name: "a", value: "2" }] });
    assert.match(renderCurl(form)!, /--data-urlencode a=1 \\\n {2}--data-urlencode a=2$/);
    assert.match(renderFetch(form)!, /encodedParams\.append\('a', '1'\);\nencodedParams\.append\('a', '2'\);/);
    assert.match(renderPython(form)!, /payload = \{ "a": \["1", "2"\] \}/);

    const raw = post({ kind: "text", mediaType: "text/plain", text: "@notafile" });
    assert.match(renderCurl(raw)!, /--data-raw '@notafile'$/);
    // A short JSON body is one quoted argument.
    assert.match(renderCurl(post({ kind: "json", mediaType: "application/json", value: { a: "it's" } }))!, /--data '\{\n {2}"a": "it'\\''s"\n\}'$/);

    const multipart = post({ kind: "multipart", parts: [{ name: "file", kind: "file", file: "<file>" }, { name: "note", kind: "text", value: "hi" }] });
    assert.match(renderCurl(multipart)!, /--form 'file=@<file>;type=application\/octet-stream' \\\n {2}--form-string 'note=hi'$/);
    assert.match(renderFetch(multipart)!, /^import \{ readFile \} from 'node:fs\/promises';/);
    assert.match(renderPython(multipart)!, /files = \[\n {4}\("file", \("<file>", open\("<file>", "rb"\), "application\/octet-stream"\)\)\n\]\npayload = \{ "note": "hi" \}/);
  });

  test("a cookie travels as one Cookie header", () => {
    const request: SampleRequest = { ...get, cookies: [{ name: "session", value: [placeholder("session", true)] }] };
    assert.match(renderCurl(request)!, /--cookie 'session=<session>'$/);
    assert.match(renderPython(request)!, /headers = \{\n {4}"cookie": "session=<session>",/);
  });
});

describe("HTTP sample modules import nothing protocol- or page-specific", () => {
  for (const file of ["../src/_internal/api/http-sample.ts", "../src/_internal/api/http-sample-render.ts"]) {
    test(file, () => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
      assert.ok(imports.every((specifier) => specifier === "./http-sample.js"), `unexpected imports: ${imports.join(", ")}`);
    });
  }
});

describe("server URLs keep what the previous renderer kept", () => {
  // Each case from the review of the renderer change, with the output main produced.
  const tools = { sampler: { sample: () => undefined } } as unknown as import("../src/_internal/api/samples.js").SampleTools;
  const curlUrl = async (server: string, extra: Record<string, unknown> = {}) => {
    const { buildOperationSamples } = await import("../src/_internal/api/samples.js");
    const out = buildOperationSamples(tools, { method: "get", path: "/x", params: [], auth: [], server, ...extra });
    return out.find((s) => s.lang === "curl")!.source.split("\n")[1]!.replace(/^ {2}--url /, "").replace(/ \\$/, "");
  };
  const cases: Array<[string, string]> = [
    ["https://User:PaSS@EXAMPLE.com", "https://User:PaSS@example.com/x"],
    ["https://x.test/?q={var}", "'https://x.test/x?q=<var>'"],
    ["https://x.test/#a{var}", "'https://x.test/x#a<var>'"],
    ["https://x.test\\foo", "https://x.test/foo/x"],
    ["https://x.test\n/path", "https://x.test/path/x"],
    ['https://u"p:p@x.test', "https://u%22p:p@x.test/x"],
    ["{scheme}://api.test", "'<scheme>://api.test/x'"],
    ["https://x.test/?q=%E2%82%AC%ZZ", "'https://x.test/x?q=%E2%82%AC%25ZZ'"],
    ["https://münich.example", "https://xn--mnich-kva.example/x"],
    ["https://x.test/?0=z&2=a&1=b", "'https://x.test/x?0=z&1=b&2=a'"],
    ["https://API.Example.com:443/v1/", "https://api.example.com:443/v1/x"],
    ["https://x.test/?q=%6E%70%68%30%71%30%7A", "'https://x.test/x?q=nph0q0z'"],
    ["https://x.test/?q=%6E%70%68%30%71%30%7A&v={v}", "'https://x.test/x?q=nph0q0z&v=<v>'"],
    ["https://x.test:8\t080", "https://x.test:8080/x"],
    ["https://x.test/?q=%EF%BB%BFabc", "'https://x.test/x?q=%EF%BB%BFabc'"],
    ["https://x.test:", "https://x.test/x"],
    ["https://u:@x.test", "https://u:@x.test/x"],
    ["http://127.1", "http://127.1/x"],
    ["http://[0:0:0:0:0:0:0:1]", "'http://[0:0:0:0:0:0:0:1]/x'"],
    ["https://user:pass:two@X.TEST", "https://user:pass:two@x.test/x"],
    ["https://x.test%2Eevil.test", "https://x.test/%2Eevil.test/x"],
    ["https://x.test;foo", "'https://x.test/;foo/x'"],
    ["https://münich-{tenant}.example", "'https://xn--mnich-<tenant>-gsb.example/x'"],
    ["https://@x.test", "https://x.test/x"],
  ];

  test("user info that isn't valid percent-encoding leaves the samples out, as before", async () => {
    const { buildOperationSamples } = await import("../src/_internal/api/samples.js");
    assert.deepEqual(buildOperationSamples(tools, { method: "get", path: "/x", params: [], auth: [], server: "https://u%FF@x.test" }), []);
  });
  for (const [server, url] of cases) {
    test(JSON.stringify(server), async () => assert.equal(await curlUrl(server), url));
  }

  test("a method with an apostrophe stays valid TypeScript and Python", async () => {
    const { buildOperationSamples } = await import("../src/_internal/api/samples.js");
    const out = buildOperationSamples(tools, { method: "FOO'BAR", path: "/x", params: [], auth: [], server: "https://x.test" });
    assert.match(out.find((s) => s.lang === "typescript")!.source, /method: 'FOO\\'BAR'/);
    assert.match(out.find((s) => s.lang === "python")!.source, /requests\.request\("FOO'BAR", url\)/);
  });

  test("a query parameter named __proto__ is sent (the previous renderer dropped it)", async () => {
    const url = await curlUrl("https://x.test", { params: [{ name: "__proto__", in: "query", required: true, example: "1" }] });
    assert.equal(url, "'https://x.test/x?__proto__=1'");
  });
});
