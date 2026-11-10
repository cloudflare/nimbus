// sendRequest against a local server, straight and through the proxy: the
// server must receive exactly the serialised request.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import type { PlanParam, RequestPlan } from "../src/_internal/try-it/plan.js";
import { handleTryIt, type ProxyTable } from "../src/_internal/try-it/proxy.js";
import { renderSample } from "../src/_internal/try-it/render.js";
import { serializeRequest } from "../src/_internal/try-it/serialize.js";
import { sendRequest, type SendOutcome } from "../src/_internal/try-it/send.js";

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

let server: Server;
let origin = "";
const received: Received[] = [];

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const table = (): ProxyTable => ({
  api: { origins: ["self"], extraOrigins: [], limits: { timeoutMs: 5_000, responseBytes: 1_000_000, uploadBytes: 200_000 } },
});

before(async () => {
  server = createServer(async (req, res) => {
    const body = await readAll(req);
    if (req.url === "/_nimbus/try") {
      const request = new Request(`${origin}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]])),
        ...(body.length ? { body } : {}),
      });
      const response = await handleTryIt(request, table());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      try {
        if (response.body) for await (const chunk of response.body) res.write(chunk);
      } catch {
        // Closing the server cuts a stalled stream off; that ends this exchange.
        return res.destroy();
      }
      return res.end();
    }
    received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `${origin}/second` });
      return res.end();
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("z".repeat(5_000));
    }
    if (req.url === "/stall") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      return; // never ends
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const param = (over: Partial<PlanParam> & Pick<PlanParam, "in" | "name">): PlanParam => ({
  required: false, style: over.in === "query" ? "form" : "simple", explode: over.in === "query", allowReserved: false, schema: {}, ...over,
});

const plan = (over: Partial<RequestPlan> = {}): RequestPlan => ({
  kind: "openapi-http",
  id: { family: "api", coordinate: "op" },
  method: "POST",
  path: "/echo/{id}",
  openapi: "3.1",
  servers: [{ url: "/", variables: [] }],
  params: [param({ in: "path", name: "id", required: true }), param({ in: "query", name: "tags", explode: false }), param({ in: "header", name: "X-Trace" })],
  auth: [{ label: "Bearer token", schemes: [{ scheme: "bearer", type: "bearer" }] }],
  send: { timeoutMs: 5_000, responseBytes: 1_000, uploadBytes: 150_000, credentials: "omit", servers: "spec" },
  ...over,
});

const values = (body?: { mediaType: string; value: unknown }) => ({
  params: { "path:id": "a b", "query:tags": ["x", "y"], "header:X-Trace": "t1" },
  auth: { alternative: 0, credentials: { bearer: "tok" } },
  ...(body ? { body } : {}),
});

async function both(p: RequestPlan, v: ReturnType<typeof values>) {
  const out: Record<string, { outcome: SendOutcome; got: Received | undefined }> = {};
  for (const delivery of ["direct", "proxy"] as const) {
    received.length = 0;
    const outcome = await sendRequest(p, v, { delivery, origin, proxyUrl: `${origin}/_nimbus/try` });
    out[delivery] = { outcome, got: received[0] };
  }
  return out;
}

describe("the server receives exactly the serialised request", () => {
  test("path, query, header and auth, both delivery modes", async () => {
    const p = plan({ method: "GET" });
    for (const [delivery, { outcome, got }] of Object.entries(await both(p, values()))) {
      assert.equal(outcome.ok, true, delivery);
      assert.equal(got!.url, "/echo/a%20b?tags=x,y", delivery);
      assert.equal(got!.headers["x-trace"], "t1");
      assert.equal(got!.headers.authorization, "Bearer tok");
      if (outcome.ok) assert.equal(outcome.text, '{"ok":true}');
    }
  });

  test("a URL-encoded form with one 100 KB field", async () => {
    const big = "x y".repeat(33_334); // 100 KB, and 100 KB encoded
    const p = plan({ body: { required: true, media: [{ mediaType: "application/x-www-form-urlencoded", kind: "form" }], examples: [] } });
    const expected = new URLSearchParams([["big", big]]).toString();
    for (const { got } of Object.values(await both(p, values({ mediaType: "application/x-www-form-urlencoded", value: { fields: [{ name: "big", value: big }] } })))) {
      assert.equal(got!.body.toString(), expected);
      assert.equal(got!.headers["content-type"], "application/x-www-form-urlencoded");
    }
  });

  test("multipart with a file, and a raw XML body", async () => {
    const p = plan({ body: { required: true, media: [{ mediaType: "multipart/form-data", kind: "multipart" }, { mediaType: "application/xml", kind: "text" }], examples: [] } });
    const file = new File([new Uint8Array([0, 1, 2, 255])], "a.bin", { type: "application/octet-stream" });
    for (const { got } of Object.values(await both(p, values({ mediaType: "multipart/form-data", value: { fields: [{ name: "f", value: file }, { name: "n", value: "hi" }] } })))) {
      const type = String(got!.headers["content-type"]);
      assert.match(type, /^multipart\/form-data; boundary=/);
      const text = got!.body.toString("latin1");
      assert.match(text, /name="f"; filename="a.bin"\r\nContent-Type: application\/octet-stream\r\n\r\n\x00\x01\x02\xff/);
      assert.match(text, /name="n"\r\n\r\nhi\r\n/);
    }
    for (const { got } of Object.values(await both(p, values({ mediaType: "application/xml", value: "<a>é</a>" })))) {
      assert.equal(got!.body.toString(), "<a>é</a>");
      assert.equal(got!.headers["content-type"], "application/xml");
    }
  });

  test("uploadBytes is sent; one byte more is refused before anything is sent", async () => {
    const p = plan({ body: { required: true, media: [{ mediaType: "text/plain", kind: "text" }], examples: [] } });
    for (const { outcome, got } of Object.values(await both(p, values({ mediaType: "text/plain", value: "x".repeat(150_000) })))) {
      assert.equal(outcome.ok, true);
      assert.equal(got!.body.length, 150_000);
    }
    for (const { outcome, got } of Object.values(await both(p, values({ mediaType: "text/plain", value: "x".repeat(150_001) })))) {
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.failure, "refused");
      assert.equal(got, undefined);
    }
  });

  test("the live cURL sample sends what the request sends, credentials masked", () => {
    const request = serializeRequest(plan({ method: "GET" }), values(), { origin: "https://api.example.com" });
    assert.ok(!("refused" in request));
    const curl = renderSample(request, "curl");
    assert.match(curl, /--url 'https:\/\/api\.example\.com\/echo\/a%20b\?tags=x,y'/);
    assert.match(curl, /--header 'Authorization: Bearer <token>'/);
    assert.ok(!curl.includes("tok'"));
  });
});

describe("answers", () => {
  test("no redirect is followed on either mode; the second server receives nothing", async () => {
    const p = plan({ method: "GET", path: "/redirect", params: [] , auth: [] });
    for (const delivery of ["direct", "proxy"] as const) {
      received.length = 0;
      const outcome = await sendRequest(p, { params: {} }, { delivery, origin, proxyUrl: `${origin}/_nimbus/try` });
      assert.ok(outcome.ok);
      if (outcome.ok) {
        assert.equal(outcome.status, 302);
        assert.equal(outcome.redirect?.location, `${origin}/second`);
      }
      assert.deepEqual(received.map((r) => r.url), ["/redirect"]);
    }
  });

  test("a body over responseBytes is cut and marked truncated on both modes", async () => {
    const p = plan({ method: "GET", path: "/big", params: [], auth: [] });
    for (const delivery of ["direct", "proxy"] as const) {
      const outcome = await sendRequest(p, { params: {} }, { delivery, origin, proxyUrl: `${origin}/_nimbus/try` });
      assert.ok(outcome.ok);
      if (outcome.ok) {
        assert.equal(outcome.body.byteLength, 1_000);
        assert.equal(outcome.truncated, true);
      }
    }
  });

  test("Stop keeps the partial output; the deadline gives timeout with it", async () => {
    const p = plan({ method: "GET", path: "/stall", params: [], auth: [] });
    for (const delivery of ["direct", "proxy"] as const) {
      const stop = new AbortController();
      const chunks: string[] = [];
      const pending = sendRequest(p, { params: {} }, { delivery, origin, proxyUrl: `${origin}/_nimbus/try`, signal: stop.signal, onChunk: (_b, text) => chunks.push(text ?? "") });
      await new Promise((r) => setTimeout(r, 200));
      stop.abort();
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.failure, "stopped", delivery);
        assert.equal(new TextDecoder().decode(outcome.partial?.body), "data: first\n\n");
      }
      assert.equal(chunks.at(-1), "data: first\n\n");
    }
    const timed = await sendRequest({ ...p, send: { ...p.send, timeoutMs: 200 } }, { params: {} }, { delivery: "direct", origin });
    assert.equal(timed.ok, false);
    if (!timed.ok) {
      assert.equal(timed.failure, "timeout");
      assert.equal(new TextDecoder().decode(timed.partial?.body), "data: first\n\n");
    }
  });

  test("a direct cookie parameter is refused; a page that isn't the proxy is a deployment error", async () => {
    const p = plan({ method: "GET", path: "/x", params: [param({ in: "cookie", name: "pref", style: "form", explode: true })], auth: [] });
    const direct = await sendRequest(p, { params: { "cookie:pref": "1" } }, { delivery: "direct", origin });
    assert.ok(!direct.ok && direct.failure === "refused");
    const notProxy = await sendRequest(plan({ method: "GET", path: "/x", params: [], auth: [] }), { params: {} }, { delivery: "proxy", origin, proxyUrl: `${origin}/not-the-proxy` });
    assert.ok(!notProxy.ok && notProxy.failure === "network" && /deployment error/.test(notProxy.reason));
  });
});
