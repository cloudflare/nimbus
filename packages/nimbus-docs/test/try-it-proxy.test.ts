// The Try it proxy: admission, what reaches upstream, and how answers come back.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_IN_FLIGHT, handleTryIt, type ProxyTable } from "../src/_internal/try-it/proxy.js";
import { H_API, H_FAILURE, H_META, H_REQUEST, H_TRY, headerJson } from "../src/_internal/try-it/protocol.js";
import { proxiedTryItKeys, readTryItPolicies } from "../src/_internal/try-it/policy-plugin.js";
import { MAX_SERVER_ORIGINS, planOrigins, stageTryItPolicy } from "../src/_internal/try-it/stage.js";
import type { RequestPlan } from "../src/_internal/try-it/plan.js";
import type { ApiSpec } from "../src/types.js";

const SITE = "https://docs.example.com";
const table = (limits: Partial<ProxyTable[string]["limits"]> = {}): ProxyTable => ({
  api: {
    origins: ["https://api.example.com", "self"],
    extraOrigins: ["https://*.uploads.example.com"],
    limits: { timeoutMs: 2_000, responseBytes: 100, uploadBytes: 50, ...limits },
  },
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function upstream(respond: (req: Request) => Response | Promise<Response> = () => new Response("ok", { headers: { "content-type": "text/plain" } })) {
  const sent: Sent[] = [];
  const fetch = (async (input: Request) => {
    sent.push({ url: input.url, method: input.method, headers: Object.fromEntries(input.headers), body: await input.clone().text() });
    return respond(input);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

function tryRequest(
  meta: { method?: string; url?: string; headers?: [string, string][] } = {},
  over: { method?: string; headers?: Record<string, string>; body?: BodyInit; api?: string; raw?: string } = {},
): Request {
  const headers = new Headers({
    [H_TRY]: "1",
    [H_API]: over.api ?? "api",
    [H_REQUEST]: over.raw ?? headerJson({ method: "GET", url: "https://api.example.com/v1/items", headers: [], ...meta }),
    Origin: SITE,
    "Sec-Fetch-Site": "same-origin",
    Cookie: "docs_session=ambient",
    Authorization: "Basic ZG9jczpzaXRl",
    "cf-connecting-ip": "203.0.113.9",
    "x-forwarded-for": "203.0.113.9",
    ...over.headers,
  });
  return new Request(`${SITE}/_nimbus/try`, {
    method: over.method ?? "POST",
    headers,
    ...(over.body !== undefined ? { body: over.body, duplex: "half" } : {}),
  } as RequestInit);
}

async function failure(response: Response) {
  assert.ok(response.headers.get(H_FAILURE), `expected a refusal, got ${response.status}`);
  return (await response.json()) as { failure: string; reason: string; retryAfterSeconds?: number };
}

describe("admission: refused with no upstream request", () => {
  const cases: [string, () => Request][] = [
    ["no Nimbus-Try", () => tryRequest({}, { headers: { [H_TRY]: "" } })],
    ["a cross-site Origin", () => tryRequest({}, { headers: { Origin: "https://evil.example" } })],
    ["Sec-Fetch-Site other than same-origin", () => tryRequest({}, { headers: { "Sec-Fetch-Site": "cross-site" } })],
    ["a GET", () => tryRequest({}, { method: "GET" })],
    ["a preflight", () => tryRequest({}, { method: "OPTIONS" })],
    ["an unknown entry", () => tryRequest({}, { api: "other" })],
    ["an inherited name: constructor", () => tryRequest({}, { api: "constructor" })],
    ["an inherited name: __proto__", () => tryRequest({}, { api: "__proto__" })],
    ["an origin that isn't a server", () => tryRequest({ url: "https://evil.example/x" })],
    ["http where https is listed", () => tryRequest({ url: "http://api.example.com/x" })],
    ["the wildcard's own host", () => tryRequest({ url: "https://uploads.example.com/x" })],
    ["userinfo", () => tryRequest({ url: "https://u:p@api.example.com/x" })],
    ["a non-http scheme", () => tryRequest({ url: "ftp://api.example.com/x" })],
    ["TRACE", () => tryRequest({ method: "TRACE" })],
    ["CONNECT", () => tryRequest({ method: "CONNECT" })],
    ["a transport header", () => tryRequest({ headers: [["Transfer-Encoding", "chunked"]] })],
    ["a proxy- header", () => tryRequest({ headers: [["Proxy-Authorization", "x"]] })],
    ["a duplicate singleton", () => tryRequest({ headers: [["Authorization", "a"], ["authorization", "b"]] })],
    ["CR LF in a value", () => tryRequest({ headers: [["X-A", "a\r\nb: c"]] })],
    ["NUL in a value", () => tryRequest({ headers: [["X-A", "a\0b"]] })],
    ["metadata over 4 KiB", () => tryRequest({}, { raw: headerJson({ method: "GET", url: "https://api.example.com/", headers: [["X-Big", "a".repeat(5000)]] }) })],
    ["Content-Length over uploadBytes", () => tryRequest({ method: "POST" }, { body: "x".repeat(51) })],
  ];
  for (const [name, make] of cases) {
    test(name, async () => {
      const { sent, fetch } = upstream();
      const response = await handleTryIt(make(), table(), { fetch });
      assert.notEqual(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), null, "never a CORS answer");
      await failure(response);
      assert.equal(sent.length, 0);
    });
  }

  test("an upload over the limit without Content-Length is refused before upstream opens", async () => {
    const { sent, fetch } = upstream();
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(51))); c.close(); } });
    const response = await handleTryIt(tryRequest({ method: "POST" }, { body }), table(), { fetch });
    assert.equal((await failure(response)).failure, "refused");
    assert.equal(sent.length, 0);
  });

  test("exactly uploadBytes is sent", async () => {
    const { sent, fetch } = upstream();
    const response = await handleTryIt(tryRequest({ method: "POST" }, { body: "x".repeat(50) }), table(), { fetch });
    assert.equal(response.status, 200);
    assert.equal(sent[0]!.body.length, 50);
  });
});

describe("upstream gets the request as built, nothing ambient", () => {
  test("explicit headers and body reach upstream; the docs request's own do not", async () => {
    const { sent, fetch } = upstream();
    const response = await handleTryIt(
      tryRequest({ method: "PUT", url: "https://eu.uploads.example.com/f?x=1", headers: [["X-Key", "secret"], ["Cookie", "pref=1"], ["Content-Type", "application/json"]] }, { body: '{"a":1}' }),
      table(),
      { fetch },
    );
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.equal(request!.url, "https://eu.uploads.example.com/f?x=1");
    assert.equal(request!.method, "PUT");
    assert.equal(request!.body, '{"a":1}');
    assert.deepEqual(request!.headers, { "x-key": "secret", cookie: "pref=1", "content-type": "application/json" });
  });

  test("a relative server is the docs origin", async () => {
    const { sent, fetch } = upstream();
    assert.equal((await handleTryIt(tryRequest({ url: `${SITE}/api/x` }), table(), { fetch })).status, 200);
    assert.equal(sent.length, 1);
  });
});

describe("answers", () => {
  test("headers in the metadata, set-cookie stripped; the body inert", async () => {
    const { fetch } = upstream(() => new Response("<script>x</script>", { status: 201, headers: { "content-type": "text/html", "set-cookie": "a=b", location: "/next" } }));
    const response = await handleTryIt(tryRequest(), table(), { fetch });
    const meta = JSON.parse(response.headers.get(H_META)!) as { status: number; headers: [string, string][]; headersTruncated: boolean };
    assert.equal(meta.status, 201);
    assert.ok(!meta.headers.some(([n]) => n === "set-cookie"));
    assert.ok(meta.headers.some(([n, v]) => n === "location" && v === "/next"));
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-disposition"), "attachment");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(await response.text(), "<script>x</script>");
  });

  test("headers past 4 KiB are dropped whole and marked; non-ASCII is escaped first", async () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`x-h${i}`, "é".repeat(20)]));
    const { fetch } = upstream(() => new Response("", { headers: many }));
    const response = await handleTryIt(tryRequest(), table(), { fetch });
    const raw = response.headers.get(H_META)!;
    assert.ok(raw.length <= 4096);
    assert.ok(/^[\x20-\x7e]*$/.test(raw), "ASCII only");
    assert.equal((JSON.parse(raw) as { headersTruncated: boolean }).headersTruncated, true);
  });

  test("the body is cut at responseBytes + 1 and ends normally", async () => {
    const { fetch } = upstream(() => new Response("y".repeat(500)));
    const response = await handleTryIt(tryRequest(), table(), { fetch });
    assert.equal((await response.text()).length, 101);
  });

  test("an unreachable API is upstream, before any headers", async () => {
    const fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof globalThis.fetch;
    const body = await failure(await handleTryIt(tryRequest(), table(), { fetch }));
    assert.equal(body.failure, "upstream");
  });

  test("a stalled answer ends at the deadline", async () => {
    const fetch = ((_request: Request, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof globalThis.fetch;
    const started = Date.now();
    const body = await failure(await handleTryIt(tryRequest(), table({ timeoutMs: 150 }), { fetch }));
    assert.equal(body.failure, "timeout");
    assert.ok(Date.now() - started < 1000);
  });

  test("a body that stalls past the deadline errors instead of ending as if whole", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    const fetch = (async () => new Response(stalled)) as typeof globalThis.fetch;
    const response = await handleTryIt(tryRequest(), table({ timeoutMs: 150 }), { fetch });
    await assert.rejects(response.text(), /deadline passed/);
  });

  test("a request already cancelled never reaches the API", async () => {
    const { sent, fetch } = upstream();
    const cancelled = new AbortController();
    cancelled.abort();
    const request = new Request(tryRequest({ method: "DELETE", url: "https://api.example.com/v1/items/1" }), { signal: cancelled.signal });
    const response = await handleTryIt(request, table(), { fetch });
    assert.equal(sent.length, 0);
    assert.match((await failure(response)).reason, /cancelled before it was sent/);
  });

  test("a stalled upload ends at the deadline", async () => {
    const { sent, fetch } = upstream();
    const body = new ReadableStream({ start() {} });
    const response = await handleTryIt(tryRequest({ method: "POST" }, { body }), table({ timeoutMs: 150 }), { fetch });
    assert.equal((await failure(response)).failure, "timeout");
    assert.equal(sent.length, 0);
  });
});

describe("in flight", () => {
  test("the 17th concurrent exchange is limited with Retry-After; every slot comes back", async () => {
    const gates: (() => void)[] = [];
    const fetch = (() => new Promise<Response>((resolve) => gates.push(() => resolve(new Response("ok"))))) as typeof globalThis.fetch;
    const pending = Array.from({ length: MAX_IN_FLIGHT }, () => handleTryIt(tryRequest(), table(), { fetch }));
    await new Promise((r) => setTimeout(r, 20));
    const limited = await handleTryIt(tryRequest(), table(), { fetch });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1");
    assert.equal((await failure(limited)).failure, "limited");
    gates.forEach((open) => open());
    await Promise.all((await Promise.all(pending)).map((r) => r.text()));
    // Failure paths release too: refusals after the slot, and an unreachable upstream.
    const down = (async () => { throw new TypeError("x"); }) as typeof globalThis.fetch;
    for (let i = 0; i < MAX_IN_FLIGHT + 2; i++) await (await handleTryIt(tryRequest(), table(), { fetch: down })).text();
    const { fetch: ok } = upstream();
    assert.equal((await handleTryIt(tryRequest(), table(), { fetch: ok })).status, 200);
  });
});

describe("the Cloudflare request signal", () => {
  test("warns unless the abort signal reaches the route", async () => {
    const { cloudflareRequestSignalWarning } = await import("../src/_internal/cloudflare-trailing-slash.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const site = (config: string) => {
      const dir = mkdtempSync(join(tmpdir(), "nb-signal-"));
      writeFileSync(join(dir, "wrangler.jsonc"), config);
      return dir;
    };
    assert.match(cloudflareRequestSignalWarning(site('{ "compatibility_date": "2026-10-01" }'))!, /enable_request_signal/);
    assert.equal(cloudflareRequestSignalWarning(site('{ "compatibility_date": "2026-10-01", "compatibility_flags": ["enable_request_signal"] }')), null);
    assert.equal(cloudflareRequestSignalWarning(site('{ "compatibility_date": "2026-12-01" }')), null);
    assert.match(cloudflareRequestSignalWarning(site('{ "compatibility_date": "2026-12-01", "compatibility_flags": ["disable_request_signal"] }'))!, /disable_request_signal/);
  });
});

describe("the relay's policy table", () => {
  test("only APIs still configured, with the proxy on, keep a policy", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "nimbus-try-policy-"));
    try {
      const policy = { origins: ["https://api.example.com"], extraOrigins: [], limits: { timeoutMs: 1_000, responseBytes: 10, uploadBytes: 10 } };
      // Staged by an earlier build: "gone" has since left the config, "quiet" turned its proxy off.
      for (const key of ["kept", "kept@v2", "gone", "quiet"]) await stageTryItPolicy(root, key, policy);
      const api = [
        { collection: "kept", versions: [{ version: "v2", spec: "a.json" }], tryIt: true },
        { collection: "quiet", spec: "b.json", tryIt: { proxy: false } },
      ] as unknown as ApiSpec[];
      assert.deepEqual([...proxiedTryItKeys(api)], ["kept@v2"]);
      assert.deepEqual(Object.keys(readTryItPolicies(root, proxiedTryItKeys(api))), ["kept@v2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the relay's origins", () => {
  const server = (count: number) => ({
    url: "https://{tenant}.{region}.example.com/{v}",
    variables: [
      { name: "tenant", default: "t0", enum: Array.from({ length: count }, (_, i) => `t${i}`), authority: true },
      { name: "region", default: "r0", enum: Array.from({ length: 20 }, (_, i) => `r${i}`), authority: true },
      { name: "v", default: "v1", enum: ["v1", "v2"], authority: false },
    ],
  });
  test("every combination of authority variables, up to the limit; past it, none and a name", () => {
    const origins = planOrigins({ servers: [server(20)] } as unknown as RequestPlan);
    assert.equal(origins.length, 400, "path variables don't multiply origins");
    assert.ok(new Set(origins).has("https://t19.r19.example.com"), "the last combination too");
    const crowded: [string, number][] = [];
    assert.deepEqual(planOrigins({ servers: [server(250)] } as unknown as RequestPlan, (url, count) => crowded.push([url, count])), []);
    assert.deepEqual(crowded, [["https://{tenant}.{region}.example.com/{v}", 5000]]);
    assert.ok(5000 > MAX_SERVER_ORIGINS);
  });
});
