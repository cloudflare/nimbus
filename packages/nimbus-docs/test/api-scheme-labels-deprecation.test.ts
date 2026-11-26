import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiModel,
  type ApiOperationPage,
} from "../src/api/index.js";
import { renderMarkdown } from "../src/markdown/render.js";

const spec = {
  openapi: "3.1.0",
  info: { title: "Records", version: "1" },
  components: {
    securitySchemes: {
      api_token: {
        type: "http",
        scheme: "bearer",
        "x-displayName": "API Token",
        description: "The preferred way to authenticate. [Create a token](https://example.com/tokens).",
      },
      api_key: { type: "apiKey", in: "header", name: "X-Auth-Key" },
    },
  },
  paths: {
    "/records": {
      get: {
        operationId: "recordsList",
        summary: "List records",
        security: [{ api_token: [] }, { api_key: [] }],
        parameters: [
          { name: "max_cost", in: "query", schema: { type: "number", deprecated: true } },
          { name: "kept", in: "query", deprecated: false, schema: { type: "string", deprecated: true } },
          { name: "plain", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
} as Record<string, never>;

describe("security schemes carry their display name and description", () => {
  let model: ApiModel;
  let page: ApiOperationPage;
  before(async () => {
    model = await buildApiModel({ collection: "records", spec, label: "records" });
    page = getApiPageProps(model, "recordsList") as ApiOperationPage;
  });

  test("the view has the label, the Markdown description and its HTML", () => {
    const [token] = page.auth[0]!;
    assert.equal(token!.label, "API Token");
    assert.match(token!.description!, /preferred way/);
    assert.match(token!.descriptionHtml!, /<a href="https:\/\/example\.com\/tokens">Create a token<\/a>/);
    const [key] = page.auth[1]!;
    assert.equal(key!.label, undefined);
    assert.equal(key!.description, undefined);
  });

  test("the Markdown names a scheme by its label, its key beside it, then its description", () => {
    const md = renderApiPageMarkdown(page);
    assert.match(md, /\*\*API Token\*\* \(`api_token`\), http bearer, header `Authorization` — The preferred way/);
    assert.match(md, /- `api_key`, apiKey, in header, header `X-Auth-Key`$/m);
  });

  test("a label's Markdown punctuation is escaped, so it can't break the line", () => {
    const md = renderApiPageMarkdown({
      ...page,
      auth: [[{ ...page.auth[0]![0]!, label: "Token **spoof** `x`", description: "Line one.\n\nLine two." }]],
    });
    assert.match(md, /^- \*\*Token \\\*\\\*spoof\\\*\\\* \\`x\\`\*\* \(`api_token`\), http bearer, header `Authorization` — Line one\. Line two\.$/m);
  });

  test("a parameter deprecated only on its schema is deprecated; its own false wins", () => {
    const query = page.parameters.find((g) => g.location === "query")!;
    const byName = new Map(query.fields.map((f) => [f.name, f]));
    assert.equal(byName.get("max_cost")!.deprecated, true);
    assert.notEqual(byName.get("kept")!.deprecated, true);
    assert.notEqual(byName.get("plain")!.deprecated, true);
  });
});

describe("an image quoted in a description", () => {
  test("with a source the sanitizer drops, it reads as the text that was written", () => {
    const html = renderMarkdown('Reference the attachment in HTML via cid: URI (e.g., <img src="cid:logo">).');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&#x3C;img src="cid:logo">/);
  });

  test("without a source, it reads as text too", () => {
    assert.doesNotMatch(renderMarkdown("An empty <img> tag."), /<img/);
  });

  test("whatever the sanitizer would empty reads as text: odd case, leading space, a digit-led scheme", () => {
    for (const src of ["HTTPS://example.com/a.png", " https://example.com/a.png", "1abc:foo"]) {
      const html = renderMarkdown(`<img src="${src}">`);
      assert.doesNotMatch(html, /<img/, src);
    }
  });

  test("relative and protocol-relative sources stay images", () => {
    assert.match(renderMarkdown('<img src="/logo.png">'), /<img src="\/logo\.png">/);
    assert.match(renderMarkdown('<img src="//cdn.example.com/a.png">'), /<img src="\/\/cdn\.example\.com\/a\.png">/);
  });

  test("with an http source, it stays an image", () => {
    assert.match(renderMarkdown('<img src="https://example.com/a.png" alt="A">'), /<img src="https:\/\/example\.com\/a\.png" alt="A">/);
  });
});
