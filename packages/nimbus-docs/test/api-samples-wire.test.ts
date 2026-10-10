import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildApiModel, getApiPageProps, renderApiPageMarkdown, type ApiOperationPage } from "../src/api/index.js";
import { sampleClientUnavailable, startSampleCapture } from "./_api-sample-wire.js";

const languages = ["curl", "typescript", "python"] as const;

const schema = { type: ["object", "null"], properties: { id: { type: "string", example: "synthesized" } } };
const nullMedia = { example: null, schema };

async function pageFor(origin: string, media: Record<string, unknown> | undefined, mediaType = "application/json", openapi = "3.1.0") {
  const model = await buildApiModel({
    collection: "wire",
    spec: {
      openapi,
      info: { title: "Request bodies", version: "1.0.0" },
      servers: [{ url: origin }],
      paths: {
        "/items": {
          post: {
            operationId: "createItem",
            ...(media ? { requestBody: { content: { [mediaType]: media } } } : {}),
            responses: { "200": { description: "OK" } },
          },
        },
      },
    },
  });
  const page = getApiPageProps(model, "createItem");
  assert.equal(page.kind, "operation");
  return page as ApiOperationPage;
}

describe("generated request bodies on the wire", () => {
  let capture: Awaited<ReturnType<typeof startSampleCapture>>;
  before(async () => { capture = await startSampleCapture(); });
  after(async () => { await capture?.close(); });

  for (const base of ["application/json", "application/x-json", "text/json", "text/x-json", "application/vnd.example+json"]) {
    for (const suffix of ["", "; charset=utf-8"]) {
      const mediaType = base + suffix;
      for (const lang of languages) {
        test(`${lang} sends explicit null as four bytes for ${mediaType}`, { skip: sampleClientUnavailable[lang] }, async () => {
          const page = await pageFor(capture.origin, nullMedia, mediaType);
          assert.equal(page.example?.value, null);
          assert.deepEqual(page.samples.map((sample) => sample.lang), languages);
          const sample = page.samples.find((sample) => sample.lang === lang)!;
          assert.doesNotMatch(sample.source, /nbph\d+q/);
          const request = await capture.run(sample);
          assert.equal(request.url, "/items");
          assert.equal(request.body.length, 4);
          assert.equal(request.body.toString("hex"), "6e756c6c");
          assert.equal(request.headers["content-type"], mediaType);
        });
      }
    }
  }

  const cases: { name: string; media: Record<string, unknown> | undefined; value: unknown; mediaType?: string; openapi?: string; wire?: string }[] = [
    { name: "absent request body", media: undefined, value: undefined },
    { name: "unresolved example", media: {}, value: undefined },
    { name: "schema synthesis", media: { schema: { type: "object", properties: { id: { type: "string", example: "synthesized" } } } }, value: { id: "synthesized" } },
    { name: "schema-derived null", media: { schema: { type: "null" } }, value: null },
    { name: "named default null beats another example and schema", media: { examples: { other: { value: { id: "other" } }, default: { value: null } }, schema }, value: null },
    { name: "first inline named null", media: { examples: { first: { value: null }, other: { value: { id: "other" } } }, schema }, value: null },
    { name: "OpenAPI 3.0 nullable null", media: { example: null, schema: { type: "object", nullable: true } }, value: null, openapi: "3.0.3" },
    ...[false, 0, "", "null", { nil: null }, [null]].map((value) => ({ name: `JSON ${JSON.stringify(value)}`, media: { example: value }, value })),
    { name: "text starting with @ is sent, not read as a file", mediaType: "text/plain", media: { example: "@/etc/hosts" }, value: "@/etc/hosts", wire: "@/etc/hosts" },
    ...([
      ["form", ["a,b", "c"], "tags=a%2Cb,c"],
      ["form", ["a", "b,c"], "tags=a,b%2Cc"],
      ["pipeDelimited", ["a|b", "c"], "tags=a%7Cb|c"],
      ["spaceDelimited", ["a b", "c"], "tags=a+b%20c"],
      ["spaceDelimited", ["a", "b c"], "tags=a%20b+c", true],
      ["spaceDelimited", ["a b", "c"], "tags=a+b%20c", true],
    ] as const).map(([style, tags, wire, allowReserved]) => ({
      name: `${style}${allowReserved ? " with allowReserved" : ""} array keeps a separator inside a value apart (${tags.join(" / ")})`,
      mediaType: "application/x-www-form-urlencoded",
      media: { example: { tags }, encoding: { tags: { style, explode: false, ...(allowReserved ? { allowReserved } : {}) } } },
      value: { tags },
      wire,
    })),
    { name: "empty form field name", mediaType: "application/x-www-form-urlencoded", media: { example: { "": "hello", ok: "x" } }, value: { "": "hello", ok: "x" }, wire: "=hello&ok=x" },
    { name: "form with a charset is sent field by field", mediaType: "application/x-www-form-urlencoded; charset=utf-8", media: { example: { tags: ["a", "b"], q: "it's" } }, value: { tags: ["a", "b"], q: "it's" }, wire: "tags=a&tags=b&q=it%27s" },
    ...["x=%20", "x=%E0%A4", "x=%00"].map((value) => ({ name: `authored form bytes ${value}`, mediaType: "application/x-www-form-urlencoded; charset=utf-8", media: { example: value }, value, wire: value })),
    { name: "a quoted form value resembling a heredoc keeps the cURL sample", mediaType: "application/x-www-form-urlencoded", media: { example: { message: "@- <<TAG\nhello" } }, value: { message: "@- <<TAG\nhello" }, wire: "message=%40-+%3C%3CTAG%0Ahello" },
    ...["hello\n--data @- <<TAG\nworld", "hello\n--data @- <<EOF\nworld"].map((message) => ({ name: `a quoted form value with a ${message.includes("EOF") ? "known" : "new"} heredoc delimiter stays intact`, mediaType: "application/x-www-form-urlencoded; charset=utf-8", media: { example: { message } }, value: { message }, wire: new URLSearchParams({ message }).toString() })),
    { name: "string example under ndjson is sent verbatim", mediaType: "application/x-ndjson", media: { example: "@/path/vectors.ndjson" }, value: "@/path/vectors.ndjson", wire: "@/path/vectors.ndjson" },
    { name: "string example under JSON with a charset stays JSON", mediaType: "application/json; charset=utf-8", media: { example: "plain" }, value: "plain" },
    { name: "object under a +json type stays JSON", mediaType: "application/vnd.api+json", media: { example: { data: { id: "1" } } }, value: { data: { id: "1" } } },
    { name: "a heredoc body reaches the server unexpanded", media: { example: { quote: "it's", env: "$HOME", cmd: "`id`", path: "C:\\temp", line: "before\n--data @- <<TAG\nafter" } }, value: { quote: "it's", env: "$HOME", cmd: "`id`", path: "C:\\temp", line: "before\n--data @- <<TAG\nafter" } },
    { name: "JSON-encoded null form field", mediaType: "application/x-www-form-urlencoded", media: { example: { nil: null }, encoding: { nil: { contentType: "application/json" } } }, value: { nil: null }, wire: "nil=null" },
  ];

  for (const fixture of cases) {
    for (const lang of languages) {
      test(`${lang}: ${fixture.name}`, { skip: sampleClientUnavailable[lang] }, async () => {
        const mediaType = fixture.mediaType ?? "application/json";
        const page = await pageFor(capture.origin, fixture.media, mediaType, fixture.openapi);
        assert.deepEqual(page.example?.value, fixture.value);
        assert.deepEqual(page.samples.map((sample) => sample.lang), languages);
        const request = await capture.run(page.samples.find((sample) => sample.lang === lang)!);
        if (fixture.value === undefined) {
          assert.equal(request.body.length, 0);
          assert.equal(request.headers["content-type"], undefined);
        } else {
          assert.equal(request.headers["content-type"], mediaType);
          if (fixture.wire !== undefined) assert.equal(request.body.toString(), fixture.wire);
          else if (fixture.value === null || typeof fixture.value !== "object") assert.equal(request.body.toString(), JSON.stringify(fixture.value));
          else assert.deepEqual(JSON.parse(request.body.toString()), fixture.value);
        }
      });
    }
  }

  test("Markdown retains null and executable samples", async () => {
    const page = await pageFor(capture.origin, nullMedia);
    const markdown = renderApiPageMarkdown(page);
    assert.match(markdown, /## Example request\n\n```json\nnull\n```/);
    for (const sample of page.samples) assert.ok(markdown.includes(sample.source));
  });
});
