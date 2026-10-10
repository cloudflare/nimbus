// Generated samples for multipart/form-data bodies: every part is sent, run
// for real against a local server in each language.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApiModel, getApiPageProps, renderApiPageMarkdown, type ApiOperationPage } from "../src/api/index.js";
import { buildOperationSamples, loadSampleTools, type SampleTools } from "../src/_internal/api/samples.js";
import { sampleClientUnavailable, startSampleCapture } from "./_api-sample-wire.js";

const languages = ["curl", "typescript", "python"] as const;
const ok = { "200": { description: "OK" } };

// Mirrors two real upload shapes: a form-style upload with `deepObject` parts,
// and a script upload with a JSON metadata part and an array of typed files.
const uploadSchema = {
  type: "object",
  required: ["file", "purpose"],
  properties: {
    expand: { type: "array", items: { type: "string" } },
    file: { type: "string", format: "binary" },
    link_options: {
      type: "object",
      properties: {
        create: { type: "boolean" },
        expires_in: { type: "integer" },
        metadata: { type: "object", properties: { note: { type: "string", example: "it's \"quoted\"\nand $HOME" } } },
      },
    },
    purpose: { type: "string", enum: ["identity_document"] },
  },
};
const scriptSchema = {
  type: "object",
  properties: {
    metadata: {
      type: "object",
      properties: {
        main_module: { type: "string", example: "worker;v=1,\"a\"" },
        bindings: { type: "array", items: { type: "object", properties: { name: { type: "string", example: "KV" } } } },
      },
    },
    files: { type: "array", items: { type: "string", format: "binary" } },
    note: { type: "string", example: "@/etc/hosts" },
    tag: { type: "string", example: "<tag>" },
  },
};

function spec(origin: string, paths: Record<string, unknown>, openapi = "3.1.0") {
  return { openapi, info: { title: "Uploads", version: "1.0.0" }, servers: [{ url: origin }], paths };
}

async function uploads(origin: string) {
  const model = await buildApiModel({
    collection: "uploads",
    spec: spec(origin, {
      "/files": {
        post: {
          operationId: "createFile",
          requestBody: {
            content: {
              "multipart/form-data": {
                schema: uploadSchema,
                encoding: { expand: { style: "deepObject", explode: true }, link_options: { style: "deepObject", explode: true } },
              },
            },
          },
          responses: ok,
        },
      },
      "/scripts": {
        put: {
          operationId: "putScript",
          requestBody: {
            content: {
              "multipart/form-data; boundary=ignored": {
                schema: scriptSchema,
                encoding: {
                  metadata: { contentType: "application/json" },
                  files: { contentType: "application/javascript+module, text/javascript" },
                },
              },
            },
          },
          responses: ok,
        },
      },
    }),
  });
  const page = (id: string) => getApiPageProps(model, id) as ApiOperationPage;
  return { createFile: page("createFile"), putScript: page("putScript") };
}

interface ReceivedPart { name: string; filename?: string; type?: string; text: string }

// Parsed by hand: Node's own parser drops a non-file part's content type.
function receivedParts(body: Buffer, contentType: string): ReceivedPart[] {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)![2]!;
  const sections = body.toString("latin1").split(`--${boundary}`).slice(1, -1);
  return sections.map((section) => {
    const raw = section.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const split = raw.indexOf("\r\n\r\n");
    const head = raw.slice(0, split);
    const disposition = /^content-disposition:(.*)$/im.exec(head)![1]!;
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];
    const type = /^content-type:\s*(.*)$/im.exec(head)?.[1]?.trim();
    return {
      name: /name="([^"]*)"/.exec(disposition)![1]!,
      ...(filename !== undefined ? { filename } : {}),
      ...(type ? { type } : {}),
      text: Buffer.from(raw.slice(split + 4), "latin1").toString("utf8"),
    };
  });
}

// Parts compared by name, in each name's order: Python sends plain fields
// before files.
function byName(parts: ReceivedPart[]): Record<string, ReceivedPart[]> {
  const grouped: Record<string, ReceivedPart[]> = {};
  for (const part of parts) (grouped[part.name] ??= []).push(part);
  return grouped;
}

describe("multipart samples on the wire", () => {
  let capture: Awaited<ReturnType<typeof startSampleCapture>>;
  let dir: string;
  before(async () => {
    capture = await startSampleCapture();
    dir = mkdtempSync(join(tmpdir(), "nimbus-multipart-"));
    writeFileSync(join(dir, "<file>"), "%PDF file bytes");
    writeFileSync(join(dir, "<files>"), "export default {}");
    writeFileSync(join(dir, "sample.txt"), "%PDF file bytes");
  });
  after(async () => {
    await capture?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const lang of languages) {
    test(`${lang}: a form-style upload sends every part`, { skip: sampleClientUnavailable[lang] }, async () => {
      const { createFile: page } = await uploads(capture.origin);
      assert.equal((page.example?.value as Record<string, unknown>).file, "<file>");
      const sample = page.samples.find((s) => s.lang === lang)!;
      assert.doesNotMatch(sample.source, /nbph\d+q/);
      const request = await capture.run(sample, { cwd: dir });
      const contentType = request.headers["content-type"]!;
      assert.match(contentType, /^multipart\/form-data; boundary=/);
      const parts = byName(receivedParts(request.body, contentType));
      assert.deepEqual(Object.keys(parts).sort(), [
        "expand[0]", "file", "link_options[create]", "link_options[expires_in]", "link_options[metadata][note]", "purpose",
      ]);
      assert.equal(Object.values(parts).flat().length, 6);
      assert.deepEqual(parts.file, [{ name: "file", filename: "<file>", type: "application/octet-stream", text: "%PDF file bytes" }]);
      // FormData sends a text value's line breaks as CRLF, as browser forms do.
      const newline = lang === "typescript" ? "\r\n" : "\n";
      assert.equal(parts["link_options[metadata][note]"]![0]!.text, `it's "quoted"${newline}and $HOME`);
      assert.equal(parts.purpose![0]!.text, "identity_document");
      assert.equal(parts["link_options[create]"]![0]!.text, "true");
    });

    test(`${lang}: a script upload sends a JSON part and both typed files`, { skip: sampleClientUnavailable[lang] }, async () => {
      const { putScript: page } = await uploads(capture.origin);
      assert.deepEqual((page.example?.value as Record<string, unknown>).files, ["<files>", "<files>"]);
      const sample = page.samples.find((s) => s.lang === lang)!;
      const request = await capture.run(sample, { cwd: dir });
      const parts = byName(receivedParts(request.body, request.headers["content-type"]!));
      assert.deepEqual(Object.keys(parts).sort(), ["files", "metadata", "note", "tag"]);
      const [metadata] = parts.metadata!;
      assert.equal(metadata!.type, "application/json");
      // Node's FormData can only type a part by sending it as a file.
      assert.equal(metadata!.filename, lang === "typescript" ? "blob" : undefined);
      assert.deepEqual(JSON.parse(metadata!.text), { main_module: "worker;v=1,\"a\"", bindings: [{ name: "KV" }] });
      assert.equal(parts.files!.length, 2);
      for (const file of parts.files!) {
        assert.deepEqual(file, { name: "files", filename: "<files>", type: "application/javascript+module", text: "export default {}" });
      }
      assert.deepEqual(parts.note, [{ name: "note", text: "@/etc/hosts" }]);
      assert.deepEqual(parts.tag, [{ name: "tag", text: "<tag>" }]);
    });

    test(`${lang}: OpenAPI 3.0 ignores multipart style and sends no files for an empty array`, { skip: sampleClientUnavailable[lang] }, async () => {
      for (const version of ["3.0", "3.0.3"]) {
        const model = await buildApiModel({
          collection: "v3-upload",
          spec: spec(capture.origin, {
            "/upload": { post: {
              operationId: "uploadV3",
              requestBody: { content: { "multipart/form-data": {
                schema: { type: "object", properties: {
                  files: { type: "array", items: { type: "string", format: "binary" } },
                  metadata: { type: "object", properties: { source: { type: "string" } } },
                  note: { type: "string" },
                } },
                encoding: { metadata: { style: "deepObject", explode: true, contentType: "application/json" } },
                example: { files: [], metadata: { source: "scanner" }, note: "hi" },
              } } },
              responses: ok,
            } },
          }, version),
        });
        const page = getApiPageProps(model, "uploadV3") as ApiOperationPage;
        assert.deepEqual((page.example?.value as Record<string, unknown>).files, [], version);
        const request = await capture.run(page.samples.find((sample) => sample.lang === lang)!);
        const parts = byName(receivedParts(request.body, request.headers["content-type"]!));
        assert.deepEqual(Object.keys(parts).sort(), ["metadata", "note"], version);
        assert.equal(parts.metadata![0]!.type, "application/json", version);
        assert.deepEqual(JSON.parse(parts.metadata![0]!.text), { source: "scanner" }, version);
        assert.deepEqual(parts.note, [{ name: "note", text: "hi" }], version);
      }
    });

    test(`${lang}: file contentType loses to style in OpenAPI 3.1 but wins in 3.0`, { skip: sampleClientUnavailable[lang] }, async () => {
      for (const version of ["3.0.3", "3.1.0"]) {
        const model = await buildApiModel({
          collection: "styled-file",
          spec: spec(capture.origin, {
            "/upload": { post: {
              operationId: "uploadStyledFile",
              requestBody: { content: { "multipart/form-data": {
                schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
                encoding: { file: { style: "form", contentType: "image/png" } },
              } } },
              responses: ok,
            } },
          }, version),
        });
        const page = getApiPageProps(model, "uploadStyledFile") as ApiOperationPage;
        const request = await capture.run(page.samples.find((sample) => sample.lang === lang)!, version === "3.0.3" ? { cwd: dir } : {});
        const [file] = receivedParts(request.body, request.headers["content-type"]!);
        assert.equal(file!.name, "file", version);
        if (version === "3.0.3") {
          assert.equal(file!.filename, "<file>", version);
          assert.equal(file!.text, "%PDF file bytes", version);
          assert.equal(file!.type, "image/png", version);
        } else {
          assert.deepEqual(file, { name: "file", text: "<file>" }, version);
        }
      }
    });

    test(`${lang}: OpenAPI 3.1 keeps style precedence and treats contentMediaType-only strings as text`, { skip: sampleClientUnavailable[lang] }, async () => {
      const model = await buildApiModel({
        collection: "v31-upload",
        spec: spec(capture.origin, {
          "/upload": { post: {
            operationId: "uploadV31",
            requestBody: { content: { "multipart/form-data": {
              schema: { type: "object", properties: {
                metadata: { type: "object", properties: { source: { type: "string" } } },
                data: { type: "string", contentMediaType: "application/octet-stream" },
              } },
              encoding: { metadata: { style: "deepObject", explode: true, contentType: "application/json" } },
              example: { metadata: { source: "scanner" }, data: "plain bytes" },
            } } },
            responses: ok,
          } },
        }),
      });
      const page = getApiPageProps(model, "uploadV31") as ApiOperationPage;
      const request = await capture.run(page.samples.find((sample) => sample.lang === lang)!);
      const parts = byName(receivedParts(request.body, request.headers["content-type"]!));
      assert.deepEqual(Object.keys(parts).sort(), ["data", "metadata[source]"]);
      assert.deepEqual(parts.data, [{ name: "data", text: "plain bytes" }]);
      assert.deepEqual(parts["metadata[source]"], [{ name: "metadata[source]", text: "scanner" }]);
    });
  }

  test("curl uses the binary default even when the replacement path has a known MIME type", { skip: sampleClientUnavailable.curl }, async () => {
    const { createFile: page } = await uploads(capture.origin);
    const sample = page.samples.find((s) => s.lang === "curl")!;
    const request = await capture.run({ ...sample, source: sample.source.replaceAll("<file>", "sample.txt") }, { cwd: dir });
    const parts = byName(receivedParts(request.body, request.headers["content-type"]!));
    assert.deepEqual(parts.file, [{ name: "file", filename: "sample.txt", type: "application/octet-stream", text: "%PDF file bytes" }]);
  });
});

describe("multipart samples", () => {
  test("the page example and its Markdown show file fields as placeholders", async () => {
    const { createFile: page } = await uploads("https://api.example.com");
    const markdown = renderApiPageMarkdown(page);
    assert.match(markdown, /"file": "<file>"/);
    const curl = page.samples.find((s) => s.lang === "curl")!.source;
    assert.match(curl, /--form 'file=@<file>;type=application\/octet-stream'/);
    assert.match(curl, /--form-string 'purpose=identity_document'/);
    assert.doesNotMatch(curl, /Content-Type/i);
  });

  test("other multipart types get no generated sample, and keep the example", async () => {
    for (const mediaType of ["multipart/mixed", "multipart/related", "multipart/alternative"]) {
      const model = await buildApiModel({
        collection: "mixed",
        spec: spec("https://api.example.com", {
          "/batch": { post: { operationId: "batch", requestBody: { content: { [mediaType]: { schema: { type: "object", properties: { a: { type: "string" } } } } } }, responses: ok } },
        }),
      });
      const page = getApiPageProps(model, "batch") as ApiOperationPage;
      assert.deepEqual(page.example?.value, { a: "string" }, mediaType);
      assert.deepEqual(page.samples, [], mediaType);
    }
  });

  test("a form example that gives no parts gets no sample", async () => {
    const tools = (await loadSampleTools())!;
    const out = buildOperationSamples(tools, {
      method: "post", path: "/x", auth: [], params: [],
      body: { mediaType: "multipart/form-data", value: "not an object" },
    });
    assert.deepEqual(out, []);
  });

  test("an authored file array sends one part per item", async () => {
    const tools = (await loadSampleTools())!;
    const [curl] = buildOperationSamples(tools, {
      method: "post", path: "/x", auth: [], params: [], generate: ["curl"],
      body: { mediaType: "multipart/form-data", value: { files: ["a", "b", "c"] }, schema: scriptSchema as never },
    });
    assert.equal(curl!.source.match(/--form 'files=@<files>;type=application\/octet-stream'/g)?.length, 3);
  });

  test("contentMediaType alone does not turn a generated string example into a file", async () => {
    const model = await buildApiModel({
      collection: "media-string",
      spec: spec("https://api.example.com", {
        "/upload": { post: {
          operationId: "uploadString",
          requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: {
            data: { type: "string", contentMediaType: "application/octet-stream" },
          } } } } },
          responses: ok,
        } },
      }),
    });
    const page = getApiPageProps(model, "uploadString") as ApiOperationPage;
    assert.notEqual((page.example?.value as Record<string, unknown>).data, "<data>");
    const curl = page.samples.find((sample) => sample.lang === "curl")!.source;
    assert.match(curl, /--form-string 'data=/);
    assert.doesNotMatch(curl, /data=@<data>/);
  });

  test("a reserved value that isn't valid encoded text is sent as written", async () => {
    const tools = (await loadSampleTools())!;
    const out = buildOperationSamples(tools, {
      method: "post", path: "/x", auth: [], params: [],
      body: { mediaType: "multipart/form-data", value: { q: ["%E0%A4", "b"] }, encoding: { q: { style: "form", explode: false, allowReserved: true } } },
    });
    assert.deepEqual(out.map((sample) => sample.lang), languages);
    assert.match(out[0]!.source, /--form-string 'q=%E0%A4,b'/);
  });

  test("a sample whose marker lines httpsnippet no longer writes is left out", async () => {
    const tools = (await loadSampleTools())!;
    const Real = tools.snippet.HTTPSnippet;
    const changed: SampleTools = {
      sampler: tools.sampler,
      snippet: {
        HTTPSnippet: class {
          #inner: InstanceType<typeof Real>;
          constructor(input: ConstructorParameters<typeof Real>[0]) { this.#inner = new Real(input); }
          convert(target: string, client?: string) {
            const out = this.#inner.convert(target, client);
            const first = Array.isArray(out) ? out[0] : out;
            return typeof first === "string" ? [first.replace(/content-type|formData\.append|files = /, "changed")] : out;
          }
        },
      },
    };
    const out = buildOperationSamples(changed, {
      method: "post", path: "/x", auth: [], params: [],
      body: { mediaType: "multipart/form-data", value: { file: "<file>", note: "x" }, schema: uploadSchema as never },
    });
    assert.deepEqual(out, []);
  });
});

describe("multipart samples with text fields only", () => {
  let capture: Awaited<ReturnType<typeof startSampleCapture>>;
  before(async () => { capture = await startSampleCapture(); });
  after(async () => { await capture?.close(); });

  for (const lang of languages) {
    test(`${lang}: still sends multipart`, { skip: sampleClientUnavailable[lang] }, async () => {
      const model = await buildApiModel({
        collection: "text-only",
        spec: spec(capture.origin, {
          "/import": {
            post: {
              operationId: "importRecords",
              requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: {
                file: { type: "string", example: "@bind_config.txt" },
                proxied: { type: "string", example: "true" },
              } } } } },
              responses: ok,
            },
          },
        }),
      });
      const page = getApiPageProps(model, "importRecords") as ApiOperationPage;
      const request = await capture.run(page.samples.find((s) => s.lang === lang)!);
      assert.match(request.headers["content-type"]!, /^multipart\/form-data; boundary=/);
      assert.deepEqual(receivedParts(request.body, request.headers["content-type"]!), [
        { name: "file", text: "@bind_config.txt" },
        { name: "proxied", text: "true" },
      ]);
    });
  }
});

describe("multipart samples for union bodies and repeated fields", () => {
  let capture: Awaited<ReturnType<typeof startSampleCapture>>;
  let dir: string;
  before(async () => {
    capture = await startSampleCapture();
    dir = mkdtempSync(join(tmpdir(), "nimbus-multipart-"));
    writeFileSync(join(dir, "<audio_sample>"), "RIFF audio");
    writeFileSync(join(dir, "<attachment>"), "attached");
  });
  after(async () => {
    await capture?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const lang of languages) {
    test(`${lang}: a file inside the sampled union branch is sent as a file`, { skip: sampleClientUnavailable[lang] }, async () => {
      const model = await buildApiModel({
        collection: "voices",
        spec: spec(capture.origin, {
          "/voices": {
            post: {
              operationId: "createVoice",
              requestBody: { content: { "multipart/form-data": { schema: { oneOf: [{
                type: "object",
                properties: {
                  name: { type: "string", example: "narrator" },
                  audio_sample: { type: "string", format: "binary" },
                  attachment: { anyOf: [{ type: "string", format: "binary" }, { type: "array", items: { type: "string", format: "binary" } }] },
                  tags: { type: "array", items: { type: "string" }, example: ["a", "b"] },
                },
              }] } } } },
              responses: ok,
            },
          },
        }),
      });
      const page = getApiPageProps(model, "createVoice") as ApiOperationPage;
      const example = page.example?.value as Record<string, unknown>;
      assert.equal(example.audio_sample, "<audio_sample>");
      assert.equal(example.attachment, "<attachment>");
      const request = await capture.run(page.samples.find((s) => s.lang === lang)!, { cwd: dir });
      const parts = byName(receivedParts(request.body, request.headers["content-type"]!));
      assert.deepEqual(parts.audio_sample!.map(({ type: _, ...part }) => part), [{ name: "audio_sample", filename: "<audio_sample>", text: "RIFF audio" }]);
      assert.deepEqual(parts.attachment!.map(({ type: _, ...part }) => part), [{ name: "attachment", filename: "<attachment>", text: "attached" }]);
      assert.deepEqual(parts.tags, [{ name: "tags", text: "a" }, { name: "tags", text: "b" }]);
      assert.deepEqual(parts.name, [{ name: "name", text: "narrator" }]);
    });
  }
});
