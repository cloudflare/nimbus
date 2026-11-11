import assert from "node:assert/strict";
import { test } from "node:test";
import { ifNoneMatchMatches, notModified } from "../src/_internal/conditional-request.js";

test("If-None-Match matches weakly, by any listed tag or *", () => {
  const etag = '"sha256:abc"';
  for (const [header, expected] of [
    ['"sha256:abc"', true],
    ['W/"sha256:abc"', true],
    ['"other", "sha256:abc"', true],
    ['"other" , W/"sha256:abc" ', true],
    ["*", true],
    ['"sha256:abd"', false],
    ['"unrelated,*,tag"', false],
    ['"a,b", "sha256:abc"', true],
    ['"sha256:abc", *', true],
    ['*, "x"', false],
    [' * ', true],
    ["sha256:abc", false],
    ['""', false],
    ["", false],
    [null, false],
    [undefined, false],
  ] as const) {
    assert.equal(ifNoneMatchMatches(header, etag), expected, `If-None-Match: ${String(header)}`);
  }
  assert.equal(ifNoneMatchMatches('"sha256:abc"', 'W/"sha256:abc"'), true, "a weak current tag");
});

test("notModified answers only GET and HEAD, with the tag and no body", async () => {
  const etag = '"sha256:abc"';
  const get = notModified(new Request("https://site.test/x.md", { headers: { "If-None-Match": etag } }), etag);
  assert.equal(get?.status, 304);
  assert.equal(get?.headers.get("ETag"), etag);
  assert.equal(get?.body, null);
  const head = notModified(new Request("https://site.test/x.md", { method: "HEAD", headers: { "If-None-Match": etag } }), etag);
  assert.equal(head?.status, 304);
  assert.equal(notModified(new Request("https://site.test/x.md", { method: "POST", headers: { "If-None-Match": etag } }), etag), null);
  assert.equal(notModified(new Request("https://site.test/x.md"), etag), null);
  assert.equal(notModified(undefined, etag), null);
});
