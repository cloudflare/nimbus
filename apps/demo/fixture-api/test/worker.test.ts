import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker";

type Json = Record<string, unknown>;

const env = {};
const origin = "https://api.demo.nimbus-docs.com";

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json | null; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization") && !path.includes("key=")) headers.set("authorization", "Bearer wx_test_x");
  const response = await worker.fetch(new Request(`${origin}${path}`, { ...init, headers }), env);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : null, headers: response.headers };
}

test("end to end: a location by id, in each version, with the request id in the headers", async () => {
  const v2 = await call("/v2/locations/loc_london_gb");
  assert.equal(v2.status, 200);
  assert.equal(v2.body?.name, "London");
  assert.match(v2.headers.get("x-request-id") ?? "", /^req_/);
  const v1 = await call("/v1/locations/loc_london_gb?key=k");
  assert.equal(v1.status, 200);
  assert.equal(v1.body?.lat, 51.5074);
});

test("end to end: the spec's envelopes for a missing key, an unknown id, a bad query value and a bad body", async () => {
  const noKey = await call("/v2/locations/loc_london_gb", { headers: { authorization: "" } });
  assert.equal(noKey.status, 401);
  assert.equal((noKey.body?.error as Json).type, "authentication");

  const missing = await call("/v2/locations/loc_nowhere_xx");
  assert.equal(missing.status, 404);
  assert.equal((missing.body?.error as Json).code, "not_found");

  const days = await call("/v2/forecasts/daily?latitude=51.5&longitude=-0.1&days=99");
  assert.equal(days.status, 400);
  assert.equal((days.body?.error as Json).param, "days");
  assert.equal((days.body?.error as Json).type, "invalid_request");

  const units = await call("/v2/forecasts/daily?latitude=51.5&longitude=-0.1&units=parsecs");
  assert.equal(units.status, 400);
  assert.equal((units.body?.error as Json).param, "units");

  const reversed = await call("/v2/history/daily?latitude=51.5&longitude=-0.1&start_date=2026-02-01&end_date=2026-01-01");
  assert.equal(reversed.status, 400);

  const garbage = await call("/v2/stations/stn_94389/observations?start=garbage");
  assert.equal(garbage.status, 400);
  assert.equal((garbage.body?.error as Json).param, "start");

  const notJson = await call("/v2/stations", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });
  assert.equal(notJson.status, 400);
  assert.equal((notJson.body?.error as Json).param, "body");

  const malformed = await call("/v2/locations/loc_london_gb%ZZ");
  assert.equal(malformed.status, 400);

  const badField = await call("/v2/stations", { method: "POST", body: JSON.stringify({ name: "Roof", latitude: "x", longitude: 0 }), headers: { "content-type": "application/json" } });
  assert.equal(badField.status, 400);
  assert.equal((badField.body?.error as Json).param, "latitude");
});

test("end to end: a write echoes and answers 201, an empty search is empty, HEAD has no body", async () => {
  const created = await call("/v2/stations", { method: "POST", body: JSON.stringify({ name: "Roof", latitude: 51.5, longitude: -0.12 }), headers: { "content-type": "application/json" } });
  assert.equal(created.status, 201);
  assert.equal(created.body?.name, "Roof");

  const none = await call("/v2/locations/search?q=Zzz");
  assert.deepEqual(none.body, { data: [], next_cursor: null, has_more: false });

  const head = await worker.fetch(new Request(`${origin}/v2/locations/loc_london_gb`, { method: "HEAD", headers: { authorization: "Bearer wx_test_x" } }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const redirect = await worker.fetch(new Request(`${origin}/v2/exports/exp_1/download`, { headers: { authorization: "Bearer wx_test_x" } }), env);
  assert.equal(redirect.status, 303);
});

test("end to end: an upload to an operation outside the families answers its example, and a non-JSON body to a write is a 400", async () => {
  const form = new FormData();
  form.set("file", new Blob(["observed_at,temperature\n2026-01-14T07:55:00Z,-2.6"], { type: "text/csv" }), "readings.csv");
  const upload = await worker.fetch(new Request(`${origin}/v2/stations/stn_01492/readings`, { method: "POST", body: form, headers: { authorization: "Bearer wx_test_x" } }), env);
  assert.equal(upload.status, 202);
  const text = await call("/v2/stations", { method: "POST", body: "name=Roof", headers: { "content-type": "text/plain" } });
  assert.equal(text.status, 400);
  assert.equal((text.body?.error as Json).param, "body");
});

test("end to end: a non-JSON example is served as is", async () => {
  const metar = await worker.fetch(new Request(`${origin}/v2/observations/metar/ENGM`, { headers: { authorization: "Bearer wx_test_x" } }), env);
  assert.equal(metar.status, 200);
  assert.match(metar.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(await metar.text(), /^ENGM /);
});
