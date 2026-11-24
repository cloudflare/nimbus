// The API page's Authorization section, built from real view-model output: the
// header example and scopes reach the row's rendered HTML, as inline code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { buildApiModel, getApiPageProps, type ApiOperationPage } from "@cloudflare/nimbus-docs/api";
import { authFields } from "../../nimbus-starter-source/src/components/ui/api-layout/auth.ts";

async function fields(securitySchemes: Record<string, unknown>, security: Array<Record<string, string[]>>) {
  const model = await buildApiModel({
    collection: "auth",
    spec: {
      openapi: "3.1.0",
      info: { title: "Auth", version: "1" },
      paths: { "/r": { get: { operationId: "read", security, responses: { "200": { description: "ok" } } } } },
      components: { securitySchemes },
    },
  });
  const page = getApiPageProps(model, "read") as ApiOperationPage;
  return authFields(page.auth);
}

/** Each `<code>` element's text, in order: what a reader sees, whatever the escaping. */
const codes = (html: string | undefined): string[] =>
  [...JSDOM.fragment(html ?? "").querySelectorAll("code")].map((c) => c.textContent ?? "");

test("an HTTP bearer scheme shows Bearer and its header example, with or without a format", async () => {
  const [plain] = await fields({ bearerAuth: { type: "http", scheme: "Bearer" } }, [{ bearerAuth: [] }]);
  assert.equal(plain!.type, "HTTP Bearer");
  assert.deepEqual(codes(plain!.descriptionHtml), ["Authorization: Bearer <token>"]);
  const [jwt] = await fields({ jwt: { type: "http", scheme: "bearer", bearerFormat: "JWT" } }, [{ jwt: [] }]);
  assert.equal(jwt!.type, "HTTP Bearer (JWT)");
  assert.deepEqual(codes(jwt!.descriptionHtml), ["Authorization: Bearer <token>"]);
});

test("an HTTP basic scheme shows Basic and its credentials example", async () => {
  const [basic] = await fields({ basicAuth: { type: "http", scheme: "basic" } }, [{ basicAuth: [] }]);
  assert.equal(basic!.type, "HTTP Basic");
  assert.deepEqual(codes(basic!.descriptionHtml), ["Authorization: Basic <credentials>"]);
});

test("an OAuth2 scheme lists its scopes as code, with no header example", async () => {
  const flows = { clientCredentials: { tokenUrl: "https://example.com/token", scopes: { read: "", write: "", "a<b": "", "x`y": "", "p``q": "" } } };
  const [oauth] = await fields({ oauth2: { type: "oauth2", flows } }, [{ oauth2: ["read", "write", "a<b", "x`y", "p``q"] }]);
  assert.equal(oauth!.type, "OAuth 2.0");
  const html = oauth!.descriptionHtml ?? "";
  assert.doesNotMatch(html, /Authorization/);
  assert.match(html, /Scopes:/);
  // A scope with `<` stays text, and backticks stay inside their own code span.
  assert.deepEqual(codes(html), ["read", "write", "a<b", "x`y", "p``q"]);
  assert.doesNotMatch(html, /<b>/);
});

test("a scheme with no example or scopes has no description", async () => {
  const [key] = await fields({ key: { type: "apiKey", in: "query", name: "k" } }, [{ key: [] }]);
  assert.equal(key!.type, "API key in query");
  assert.equal(key!.descriptionHtml, undefined);
});
