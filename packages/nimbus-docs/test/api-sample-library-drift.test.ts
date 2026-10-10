// Drift tests: each one reproduces a defect in a sampling library that Nimbus
// works around (or, for the sampler, lives with). When a library release fixes
// one, its test fails: remove the workaround it names in the same change as
// the version bump, then delete the test.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadSampleTools } from "../src/_internal/api/samples.js";

const tools = (await loadSampleTools())!;

function har(mimeType: string, body: { text?: string; params?: { name: string; value: string }[] }) {
  return {
    method: "POST",
    url: "https://api.example.com/x",
    httpVersion: "HTTP/1.1",
    cookies: [] as [],
    headers: [{ name: "Content-Type", value: mimeType }],
    queryString: [],
    postData: { mimeType, text: body.text ?? "", ...(body.params ? { params: body.params } : {}) },
    headersSize: -1,
    bodySize: -1,
  };
}

function snippet(input: ReturnType<typeof har>, target: string, client: string): string {
  const out = new tools.snippet.HTTPSnippet(input).convert(target, client);
  return String(Array.isArray(out) ? out[0] : out);
}

describe("openapi-sampler", () => {
  test("an untyped allOf member before a typed one loses its properties", () => {
    const named = { properties: { name: { type: "string", example: "n" } } };
    const typed = { type: "object", properties: { id: { type: "string", example: "i" } } };
    const sampled = tools.sampler.sample({ allOf: [named, typed] }, { quiet: true });
    assert.ok(typeof sampled === "object" && sampled !== null, `openapi-sampler now samples this as ${JSON.stringify(sampled)}`);
    assert.ok(!("name" in sampled),
      "openapi-sampler now keeps the untyped member's properties: examples for these schemas are fixed; delete this test");
  });
});

describe("@readme/httpsnippet", () => {
  test("Python JSON bodies don't escape a newline inside a string", () => {
    const source = snippet(har("application/json", { text: JSON.stringify({ key: "line one\nline two" }) }), "python", "requests");
    assert.ok(source.includes("line one\nline two"),
      "httpsnippet now escapes Python JSON strings: keep pythonLiteral (Nimbus writes every body), and confirm the payload marker line still matches");
  });

  test("TypeScript fetch bodies don't escape a backslash", () => {
    const source = snippet(har("application/json", { text: JSON.stringify({ path: "C:\\temp" }) }), "node", "fetch");
    assert.ok(source.includes("'C:\\temp'") && !source.includes("'C:\\\\temp'"),
      "httpsnippet now escapes fetch bodies: keep jsLiteral (Nimbus writes every body), and confirm the JSON.stringify marker still matches");
  });

  test("TypeScript fetch drops a JSON body of false, 0 or an empty string", () => {
    for (const body of ["false", "0", '""']) {
      const source = snippet(har("application/json", { text: body }), "node", "fetch");
      assert.ok(!source.includes("body:"),
        `httpsnippet now keeps a JSON body of ${body}: keep jsLiteral (Nimbus writes every body)`);
    }
  });

  test("cURL sends a text body with --data, which reads a file for a body starting with @", () => {
    const source = snippet(har("text/plain", { text: "@/etc/hosts" }), "shell", "curl");
    assert.ok(source.includes("--data @/etc/hosts"),
      "httpsnippet now writes --data-raw (or quotes the body): the --data-raw rewrite in bodyRewrite can go");
  });

  test("a cURL heredoc's delimiter is unquoted", () => {
    const body = JSON.stringify({ quote: "it's", env: "$HOME", cmd: "`id`" });
    const source = snippet(har("application/json", { text: body }), "shell", "curl");
    assert.ok(source.includes("@- <<EOF\n"),
      "httpsnippet now quotes the heredoc delimiter (or stopped using one): remove the <<'EOF' rewrite in convert()");
  });

  test("TypeScript form fields use set, unescaped, keeping only a repeated name's last value", () => {
    const source = snippet(
      har("application/x-www-form-urlencoded", { params: [{ name: "tags", value: "a" }, { name: "tags", value: "it's" }] }),
      "node",
      "fetch",
    );
    assert.ok(source.includes("encodedParams.set('tags', 'it's');"),
      "httpsnippet now appends escaped form fields: the encodedParams rewrite in bodyRewrite may go, after checking every target");
  });

  test("a form media type with parameters isn't sent as form fields", () => {
    const source = snippet(
      har("application/x-www-form-urlencoded; charset=utf-8", { text: "a=1", params: [{ name: "a", value: "1" }] }),
      "node",
      "fetch",
    );
    assert.ok(!source.includes("encodedParams"),
      "httpsnippet now matches a form media type with parameters: buildHar no longer needs to pass the bare type");
  });
});
