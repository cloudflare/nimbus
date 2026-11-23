// URL sources: `sources: { <name>: { url, integrity } }`, one file an api
// spec reads. Validation, fetching once with integrity, conditional requests
// without it, what falls back and what fails, preview's offline read, and that
// no message or file on disk carries the URL's query string.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";

import {
  applySourceSpecs,
  collectSourceSpecs,
  releaseContentSourceLeases,
  resolveContentSources,
} from "../src/_internal/content-sources.ts";
import { validateNimbusConfig } from "../src/_internal/validate.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

const base = { site: "https://docs.example.test", title: "Docs", search: false };
const integrity = (body: string) => `sha256-${createHash("sha256").update(body).digest("base64")}`;
const hex = (body: string) => createHash("sha256").update(body).digest("hex");

function invalid(config: unknown): string {
  try {
    validateNimbusConfig(config);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the config to be rejected");
}

/** A server for one file, with an ETag, that records each request's headers. */
async function fileServer() {
  const state = {
    body: '{"openapi":"3.1.0"}',
    status: 200,
    etag: true,
    requests: [] as IncomingHttpHeaders[],
    redirect: undefined as string | undefined,
  };
  const server = createServer((req, res) => {
    state.requests.push(req.headers);
    if (req.url?.startsWith("/hop/")) {
      // A chain of redirects that ends at the file.
      const left = Number(req.url.slice("/hop/".length));
      res.writeHead(302, { location: left > 0 ? `/hop/${left - 1}` : "/releases/openapi.json" }).end();
      return;
    }
    if (state.redirect) {
      res.writeHead(302, { location: state.redirect }).end();
      return;
    }
    if (state.status !== 200) {
      res.writeHead(state.status, "Missing /spec.json?token=s3cret").end("no");
      return;
    }
    const tag = `"${hex(state.body).slice(0, 16)}"`;
    if (state.etag && req.headers["if-none-match"] === tag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", ...(state.etag ? { etag: tag } : {}) }).end(state.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    state,
    url: (query = "") => `http://localhost:${port}/releases/openapi.json${query}`,
    origin: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function logs() {
  const lines: string[] = [];
  return { lines, log: (_level: "info" | "warn", message: string) => lines.push(message) };
}

test("a URL source validates url and integrity, and an api spec reads it with no path", () => {
  const config = validateNimbusConfig({
    ...base,
    sources: {
      spec: { url: "https://example.com/openapi.json", integrity: integrity("x") },
      local: { url: "http://localhost:8080/openapi.json" },
    },
    api: [{ collection: "api", spec: { source: "spec" } }],
  });
  assert.deepEqual(config.sources?.["spec"], { url: "https://example.com/openapi.json", integrity: integrity("x") });

  assert.match(invalid({ ...base, sources: { a: { url: "http://example.com/a.json" } } }), /must use https \(http is allowed only for localhost\)/);
  assert.match(invalid({ ...base, sources: { a: { url: "ftp://example.com/a.json" } } }), /must be an https URL/);
  assert.match(invalid({ ...base, sources: { a: { url: "nope" } } }), /is not a URL/);
  assert.match(invalid({ ...base, sources: { a: { url: "https://example.com/a.json", integrity: "sha1-abc" } } }), /must be "sha256-<base64>"/);
  assert.match(invalid({ ...base, sources: { a: { url: "https://example.com/a.json", ref: "main" } } }), /A URL source takes "url" and "integrity"/);
  assert.match(
    invalid({
      ...base,
      sources: { a: { url: "https://example.com/a.json" } },
      api: [{ collection: "api", spec: { source: "a", path: "a.json" } }],
    }),
    /a URL source, which is one file\. Remove path/,
  );

  // A credential in the URL is refused, and no part of it is echoed.
  const message = invalid({ ...base, sources: { a: { url: "https://user:hunter2@example.com/a.json?token=s3cret" } } });
  assert.match(message, /has a user or password in it \(https:\/\/example\.com\/a\.json\)/);
  assert.doesNotMatch(message, /hunter2|s3cret|user:/);
});

test("without integrity, a URL source is fetched once and revalidated with its ETag after that", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-url-source-"));
  const server = await fileServer();
  try {
    const sources = { spec: { url: server.url("?token=s3cret") } };
    const first = logs();
    const one = (await resolveContentSources(sources, { projectRoot: root, log: first.log })).snapshots.get("spec")!;
    assert.equal(one.kind, "url");
    assert.equal(one.revision, hex(server.state.body));
    assert.equal(one.floating, true);
    assert.equal(readFileSync(one.file!, "utf8"), server.state.body);
    assert.equal(path.basename(one.file!), "openapi.json");
    assert.equal(server.state.requests[0]!["if-none-match"], undefined);
    assert.match(first.lines.join("\n"), /source "spec" \(http:\/\/localhost:\d+\/releases\/openapi\.json\): fetched sha256 [0-9a-f]{12}\. It has no integrity/);

    // Unchanged: one conditional request, answered 304.
    const second = logs();
    const two = (await resolveContentSources(sources, { projectRoot: root, log: second.log })).snapshots.get("spec")!;
    assert.equal(two.revision, one.revision);
    assert.equal(server.state.requests.length, 2);
    assert.match(String(server.state.requests[1]!["if-none-match"]), /^"[0-9a-f]{16}"$/);
    assert.match(second.lines.join("\n"), /unchanged, using cached sha256/);

    // Changed: the new file is selected, and the old snapshot is pruned.
    // Each setup run drops the previous run's leases first, as a build does.
    releaseContentSourceLeases(root);
    server.state.body = '{"openapi":"3.1.1"}';
    const three = (await resolveContentSources(sources, { projectRoot: root, log: () => {} })).snapshots.get("spec")!;
    assert.equal(three.revision, hex(server.state.body));
    assert.deepEqual(
      readdirSync(path.dirname(three.dir)).filter((entry) => /^[0-9a-f]{64}$/.test(entry)),
      [three.revision],
    );

    // The query string never reaches disk or a message.
    const onDisk = readdirSync(path.dirname(three.dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "openapi.json")
      .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
      .join("\n");
    assert.doesNotMatch(onDisk + first.lines.join("\n") + second.lines.join("\n"), /s3cret/);

    // An api spec reading the source points at its file.
    const api = [{ collection: "api", spec: { source: "spec" } }];
    applySourceSpecs(collectSourceSpecs(api as never), new Map([["spec", three]]), root);
    assert.equal(api[0]!.spec, path.relative(root, three.file!).split(path.sep).join("/"));

    // Preview reads the selected snapshot with no request.
    const before = server.state.requests.length;
    const offline = await resolveContentSources(sources, { projectRoot: root, log: () => {}, mode: "offline" });
    assert.equal(offline.snapshots.get("spec")!.revision, three.revision);
    assert.equal(server.state.requests.length, before);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a server error falls back to the selected file; a 4xx fails, even with a snapshot", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-url-source-fallback-"));
  const server = await fileServer();
  try {
    const sources = { spec: { url: server.url() } };
    const fetched = (await resolveContentSources(sources, { projectRoot: root, log: () => {} })).snapshots.get("spec")!;

    server.state.status = 503;
    const warned = logs();
    const fallback = (await resolveContentSources(sources, { projectRoot: root, log: warned.log })).snapshots.get("spec")!;
    assert.equal(fallback.revision, fetched.revision);
    assert.match(warned.lines.join("\n"), /could not fetch source "spec" \([^)]+\): the server answered 503[^.]*\. Building from sha256 [0-9a-f]{12}, selected /);

    server.state.status = 404;
    await assert.rejects(
      resolveContentSources(sources, { projectRoot: root, log: () => {} }),
      (error: Error) => /^nimbus-docs: could not fetch source "spec" \([^)]+\): the server answered 404\.$/.test(error.message),
    );

    // With no snapshot, a server error fails the build and names the URL.
    const empty = mkdtempSync(path.join(TEST_TMP, "nimbus-url-source-empty-"));
    try {
      server.state.status = 503;
      await assert.rejects(
        resolveContentSources(sources, { projectRoot: empty, log: () => {} }),
        (error: Error) => {
          assert.match(error.message, /the server answered 503[^.]*\. No snapshot of this URL exists under \.nimbus\/sources\/spec\/\.$/);
          assert.doesNotMatch(error.message, /git/);
          return true;
        },
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("with integrity, a URL source is fetched once and checked; a different file fails the build", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-url-source-pinned-"));
  const server = await fileServer();
  try {
    const pinned = { spec: { url: server.url(), integrity: integrity(server.state.body) } };
    const first = (await resolveContentSources(pinned, { projectRoot: root, log: () => {} })).snapshots.get("spec")!;
    assert.equal(first.floating, false);
    assert.equal(first.revision, hex(server.state.body));
    // A cache hit makes no request, even when the server is down.
    server.state.status = 503;
    await resolveContentSources(pinned, { projectRoot: root, log: () => {} });
    assert.equal(server.state.requests.length, 1);

    server.state.status = 200;
    const wrong = { spec: { url: server.url(), integrity: integrity("something else") } };
    await assert.rejects(
      resolveContentSources(wrong, { projectRoot: root, log: () => {} }),
      (error: Error) => {
        assert.match(error.message, /does not match its integrity: expected sha256-\S+, fetched sha256-\S+\./);
        assert.match(String((error as Error & { hint?: string }).hint), /Update integrity if the file changed on purpose/);
        return true;
      },
    );
    assert.ok(!existsSync(path.join(path.dirname(first.dir), hex("something else"))));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("each redirect is held to the URL rule, and an error never repeats the server's reason text", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-url-source-redirect-"));
  const server = await fileServer();
  try {
    // A chain of local redirects is followed to the file.
    const chained = (await resolveContentSources({ spec: { url: `${server.origin}/hop/3` } }, { projectRoot: root, log: () => {} }))
      .snapshots.get("spec")!;
    assert.equal(readFileSync(chained.file!, "utf8"), server.state.body);
    // Too many, or one to plain http elsewhere, fails before anything is fetched from it.
    await assert.rejects(
      resolveContentSources({ spec: { url: `${server.origin}/hop/12` } }, { projectRoot: root, log: () => {} }),
      /it redirects more than 10 times/,
    );
    server.state.redirect = "http://example.com/openapi.json?token=s3cret";
    await assert.rejects(
      resolveContentSources({ insecure: { url: server.url() } }, { projectRoot: root, log: () => {} }),
      (error: Error) => {
        assert.match(error.message, /it redirects to http:\/\/example\.com\/openapi\.json, which must use https/);
        assert.doesNotMatch(error.message, /s3cret/);
        return true;
      },
    );
    // A malformed Location is the server's error to fix: no fallback, though a file is saved.
    server.state.redirect = "http://[";
    await assert.rejects(
      resolveContentSources({ spec: { url: `${server.origin}/hop/3` } }, { projectRoot: root, log: () => {} }),
      /could not fetch source "spec" \([^)]+\): it redirects to a malformed location\./,
    );
    server.state.redirect = undefined;

    // The reason phrase carries a query string; messages give the status only.
    server.state.status = 503;
    const warned = logs();
    await resolveContentSources({ spec: { url: `${server.origin}/hop/3` } }, { projectRoot: root, log: warned.log });
    assert.match(warned.lines.join("\n"), /the server answered 503\. Building from sha256/);
    assert.doesNotMatch(warned.lines.join("\n"), /s3cret|Missing/);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validators go only to the URL that sent them, so a redirect that moves gets the new file", async () => {
  for (const validator of ["etag", "last-modified"] as const) {
    const root = mkdtempSync(path.join(TEST_TMP, "nimbus-url-source-moved-"));
    // `/latest` redirects to a versioned file. Both files answer 304 to any
    // conditional request, as a server may when they share an ETag, or when
    // the newer target has an older date.
    const files: Record<string, string> = { "/v1.json": '{"openapi":"3.1.0"}', "/v2.json": '{"openapi":"3.1.1"}' };
    let target = "/v1.json";
    const requests: Array<{ url: string; conditional: boolean }> = [];
    const server = createServer((req, res) => {
      const conditional = Boolean(req.headers["if-none-match"] || req.headers["if-modified-since"]);
      requests.push({ url: req.url!, conditional });
      if (req.url === "/latest") return void res.writeHead(302, { location: target }).end();
      if (conditional) return void res.writeHead(304).end();
      const headers = validator === "etag" ? { etag: '"1"' } : { "last-modified": "Mon, 23 Nov 2026 00:00:00 GMT" };
      res.writeHead(200, { "content-type": "application/json", ...headers }).end(files[req.url!]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}/latest`;
    try {
      const sources = { spec: { url } };
      const one = (await resolveContentSources(sources, { projectRoot: root, log: () => {} })).snapshots.get("spec")!;
      assert.equal(readFileSync(one.file!, "utf8"), files["/v1.json"]);

      // Same target: the file itself is asked conditionally and answers 304.
      requests.length = 0;
      releaseContentSourceLeases(root);
      const same = (await resolveContentSources(sources, { projectRoot: root, log: () => {} })).snapshots.get("spec")!;
      assert.equal(same.revision, one.revision);
      assert.deepEqual(requests, [{ url: "/latest", conditional: false }, { url: "/v1.json", conditional: true }]);

      // The redirect moves: the new target gets a plain request, and its file is selected.
      target = "/v2.json";
      requests.length = 0;
      releaseContentSourceLeases(root);
      const moved = (await resolveContentSources(sources, { projectRoot: root, log: () => {} })).snapshots.get("spec")!;
      assert.equal(readFileSync(moved.file!, "utf8"), files["/v2.json"], validator);
      assert.deepEqual(requests, [{ url: "/latest", conditional: false }, { url: "/v2.json", conditional: false }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a refused connection names its reason when the build falls back to the saved file", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-url-source-refused-"));
  const server = await fileServer();
  const sources = { spec: { url: server.url() } };
  try {
    await resolveContentSources(sources, { projectRoot: root, log: () => {} });
    await server.close();
    releaseContentSourceLeases(root);
    const offline = logs();
    await resolveContentSources(sources, { projectRoot: root, log: offline.log });
    assert.match(offline.lines.join("\n"), /the request failed \(ECONNREFUSED\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
