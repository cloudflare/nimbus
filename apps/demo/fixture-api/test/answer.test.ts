import assert from "node:assert/strict";
import { test } from "node:test";
import { type Ask, type Route, type Version, answer, internals, registerRoutes } from "../src/answer";
import { world } from "../src/world";
import { VERSIONS, routes, validateResponse } from "./spec";

type Json = Record<string, unknown>;

const NOW = new Date("2026-11-12T13:45:00Z");
const london = world.city("loc_london_gb")!;
const nairobi = world.city("loc_nairobi_ke")!;
const oslo = world.example();

registerRoutes(Object.fromEntries(VERSIONS.map((version) => [version, routes(version)])));

function route(version: Version, operationId: string): Route {
  const found = routes(version).find((r) => r.operationId === operationId);
  assert.ok(found, `${version} has no ${operationId}`);
  return found;
}

function ask(version: Version, partial: Partial<Ask> = {}): Ask {
  return { version, params: {}, query: {}, now: NOW, ...partial };
}

function body(version: Version, operationId: string, partial: Partial<Ask> = {}): Json {
  const result = answer(route(version, operationId), ask(version, partial));
  assert.ok(!("error" in result), `${operationId}: ${JSON.stringify(result)}`);
  return JSON.parse(result.body ?? "null") as Json;
}

function failure(version: Version, operationId: string, partial: Partial<Ask> = {}) {
  const result = answer(route(version, operationId), ask(version, partial));
  assert.ok("error" in result, `${operationId} should fail`);
  return result.error;
}

const at = (city: { latitude: number; longitude: number }, v1 = false): Record<string, number> =>
  v1 ? { lat: city.latitude, lon: city.longitude } : { latitude: city.latitude, longitude: city.longitude };

// ---------------------------------------------------------------------------
// Every route, every version: the answer validates against its response schema
// and keeps the example's keys.
// ---------------------------------------------------------------------------

/** A plausible request for any route, so every operation can be exercised. */
function subject(version: Version, r: Route): Ask {
  const v1 = version === "v1";
  const params: Record<string, string> = {};
  for (const name of [...r.pattern.matchAll(/\(\?<(\w+)>/g)].map((m) => m[1] as string)) {
    params[name] =
      name === "location_id" ? london.id
      : name === "station_id" ? london.station.id
      : name === "id" ? (r.path.startsWith("/stations") ? london.station.wmoId : "4211")
      : name === "zone_id" ? london.zone.id
      : name === "alert_id" ? (v1 ? "a-20261112-0042" : "alt_20261112_0042")
      : name === "timezone" ? "Europe/London"
      : name === "icao" ? "EGLL"
      : name === "year" ? "2025"
      : name === "layer" ? "radar"
      : /^[zxy]$/.test(name) ? "1"
      : `${name.replace(/_id$/, "")}_1`;
  }
  const query: Record<string, string | number | boolean> = {};
  for (const field of r.query) {
    if (!field.required) continue;
    query[field.name] =
      field.name === "lat" || field.name === "latitude" ? london.latitude
      : field.name === "lon" || field.name === "longitude" ? london.longitude
      : field.name === "q" ? "Lon"
      : field.name === "from" || field.name === "start_date" ? "2026-01-01"
      : field.name === "to" || field.name === "end_date" ? "2026-01-03"
      : field.name === "start" ? "2026-01-01T00:00:00Z"
      : field.name === "country" ? "GB"
      : field.enum ? (field.enum[0] as string)
      : field.type === "number" || field.type === "integer" ? (field.minimum ?? 1)
      : field.name === "center" || field.name === "bbox" ? "51.5,-0.1"
      : "x";
  }
  const bodies: Record<string, unknown> = {
    batchForecasts: { points: [{ latitude: london.latitude, longitude: london.longitude, ref: "ldn" }, { latitude: nairobi.latitude, longitude: nairobi.longitude }], kind: "daily" },
    createStation: { name: "Roof", latitude: 51.5, longitude: -0.12 },
    updateStation: { name: "Renamed" },
    createApiKey: { name: "Staging" },
    inviteMember: { email: "ola@example.com", role: "developer" },
    createSubscription: { url: "https://example.com/hooks", events: ["alert.issued"] },
  };
  return ask(version, { params, query, body: bodies[r.operationId ?? ""] });
}

/** Keys the overlay may legitimately change: batch composes `forecast`, a pending member has no `joined_at`, a batch point without `ref` has none. */
const KEY_EXCEPTIONS = new Set(["results[].forecast", "joined_at", "results[].ref"]);

/** Every key path in a body; array elements must all have the same keys as each other. */
function keyPaths(node: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(node)) {
    const elements = node.map((element) => keyPaths(element, `${prefix}[]`));
    for (const [index, paths] of elements.entries()) {
      if (index > 0) assert.deepEqual(paths, elements[0], `${prefix}[${index}] has different keys from ${prefix}[0]`);
      for (const p of paths) out.add(p);
    }
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  for (const [key, value] of Object.entries(node as Json)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (KEY_EXCEPTIONS.has(path) || KEY_EXCEPTIONS.has(key)) continue;
    out.add(path);
    for (const p of keyPaths(value, path)) out.add(p);
  }
  return out;
}

function emptyArrays(node: unknown): boolean {
  return Array.isArray(node) ? node.length === 0 : typeof node === "object" && node !== null ? Object.values(node as Json).some(emptyArrays) : false;
}

for (const version of VERSIONS) {
  test(`${version}: every JSON answer validates against its response schema and keeps the example's keys`, () => {
    for (const r of routes(version)) {
      if (r.body === undefined || !/json/.test(r.mediaType ?? "")) continue;
      const result = answer(r, subject(version, r));
      assert.ok(!("error" in result), `${version} ${r.operationId}: ${JSON.stringify(result)}`);
      const parsed = JSON.parse(result.body ?? "null") as unknown;
      const problem = validateResponse(version, r, parsed);
      assert.equal(problem, null, `${version} ${r.operationId}: ${problem}`);
      const example = JSON.parse(r.body) as unknown;
      // A list the overlay rebuilt can be empty; then only its element keys are left out of the comparison.
      const exampleKeys = keyPaths(example);
      const parsedKeys = keyPaths(parsed);
      for (const p of parsedKeys) assert.ok(exampleKeys.has(p), `${version} ${r.operationId}: unexpected key ${p}`);
      for (const p of exampleKeys) {
        if (emptyArrays(parsed) && p.includes("[]")) continue;
        assert.ok(parsedKeys.has(p), `${version} ${r.operationId}: missing key ${p}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

test("a location by id is that city, in each version's shape; an unknown id is the spec's 404", () => {
  const v2 = body("v2", "getLocation", { params: { location_id: london.id } });
  assert.equal(v2.name, "London");
  assert.deepEqual(v2.coordinates, { latitude: london.latitude, longitude: london.longitude, elevation: london.elevation });
  const v1 = body("v1", "getLocation", { params: { location_id: london.id } });
  assert.equal(v1.name, "London");
  assert.equal(v1.lat, london.latitude);
  assert.equal("coordinates" in v1, false);
  assert.equal("population" in v1, false);
  const error = failure("v2", "getLocation", { params: { location_id: "loc_nowhere_xx" } });
  assert.equal(error.status, 404);
  assert.equal(error.code, "not_found");
});

test("no example-city value survives in a London body", () => {
  const oslo = JSON.stringify(body("v2", "getDailyForecast", { query: at(world.example()) }));
  const london2 = JSON.stringify(body("v2", "listAlertsForPoint", { query: at(london) })) + JSON.stringify(body("v2", "getNearestObservation", { query: at(london) })) + JSON.stringify(body("v2", "getStation", { params: { station_id: london.station.id } }));
  for (const needle of ["Oslo", "loc_oslo_no", "stn_01492", "zone_no_03", "ENGM", "Akershus", "Norwegian"]) {
    assert.ok(!london2.includes(needle), `${needle} survived`);
  }
  assert.ok(oslo.includes("Oslo"));
});

test("search filters by prefix and country, pages, and is empty with the version's paging keys when nothing matches", () => {
  const paris = body("v2", "searchLocations", { query: { q: "Par", limit: 1 } });
  assert.equal((paris.data as Json[])[0]?.name, "Paris");
  assert.equal(paris.has_more, true);
  assert.equal(paris.next_cursor, "c_1");
  const page2 = body("v2", "searchLocations", { query: { q: "Par", limit: 1, cursor: "c_1" } });
  assert.notEqual((page2.data as Json[])[0]?.name, "Paris");
  const none = body("v2", "searchLocations", { query: { q: "Zzz" } });
  assert.deepEqual(none, { data: [], next_cursor: null, has_more: false });
  const v1 = body("v1", "searchLocations", { query: { q: "Zzz" } });
  assert.deepEqual(v1, { results: [], page: 1, total_pages: 1 });
  const gb = body("v1", "searchLocations", { query: { q: "", country: "GB", per_page: 5, page: 2 } });
  assert.equal((gb.results as Json[]).length, 5);
  assert.equal(gb.page, 2);
});

test("reverse geocoding and nearby stations work from a point and a radius", () => {
  assert.equal(body("v2", "reverseGeocode", { query: at(nairobi) }).name, "Nairobi");
  const near = body("v2", "listNearbyStations", { params: { location_id: london.id }, query: { radius: 100 } });
  const items = near.data as Json[];
  assert.ok(items.length >= 2, "London has neighbours within 100 km");
  assert.equal((items[0]?.station as Json).name, london.station.name);
  assert.ok(items.every((item, i) => i === 0 || (item.distance_km as number) >= (items[i - 1]?.distance_km as number)), "nearest first");
  const tight = body("v2", "listNearbyStations", { params: { location_id: london.id }, query: { radius: 4 } });
  assert.equal((tight.data as Json[]).length, 1);
  const own = (tight.data as Json[])[0] as Json;
  const coords = (own.station as Json).coordinates as Json;
  const expected = Math.round(6371 * Math.acos(Math.sin((51.5074 * Math.PI) / 180) * Math.sin(((coords.latitude as number) * Math.PI) / 180) + Math.cos((51.5074 * Math.PI) / 180) * Math.cos(((coords.latitude as number) * Math.PI) / 180) * Math.cos(((coords.longitude as number) + 0.1278) * Math.PI / 180)) * 10) / 10;
  assert.ok(Math.abs((own.distance_km as number) - expected) < 0.2, `distance ${own.distance_km} should be ${expected}`);
});

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

test("forecasts follow the city and the day: Nairobi differs from Oslo, the same request repeats within the day", () => {
  const a = body("v2", "getDailyForecast", { query: { ...at(nairobi), days: 3 } });
  const b = body("v2", "getDailyForecast", { query: { ...at(oslo), days: 3 } });
  const nairobiMax = ((a.days as Json[])[0] as Json).temperature_max as number;
  const osloMax = ((b.days as Json[])[0] as Json).temperature_max as number;
  assert.ok(nairobiMax > osloMax + 5, `Nairobi ${nairobiMax} should be warmer than Oslo ${osloMax}`);
  assert.equal((a.days as Json[]).length, 3);
  const again = body("v2", "getDailyForecast", { query: { ...at(nairobi), days: 3 }, now: new Date("2026-11-12T23:59:00Z") });
  assert.deepEqual(again, a);
  const tomorrow = body("v2", "getDailyForecast", { query: { ...at(nairobi), days: 3 }, now: new Date("2026-11-13T00:00:01Z") });
  assert.notDeepEqual(tomorrow, a);
  assert.equal(a.generated_at, "2026-11-12T00:00:00Z");
});

test("daily values are bounded and coherent in every unit system", () => {
  for (const units of ["metric", "imperial", "si"] as const) {
    const days = body("v2", "getDailyForecast", { query: { ...at(london), days: 16, units } }).days as Json[];
    assert.equal(days.length, 16);
    for (const day of days) {
      assert.ok((day.temperature_max as number) > (day.temperature_min as number), "high above low");
      const p = day.precipitation_probability as number;
      assert.ok(Number.isInteger(p) && p >= 0 && p <= 100);
      assert.ok((day.precipitation_sum as number) >= 0 && (day.snowfall_sum as number) >= 0 && (day.wind_max as number) >= 0);
      assert.ok((day.uv_index_max as number) >= 0 && (day.uv_index_max as number) <= 12);
      const condition = day.condition as Json;
      assert.ok(typeof condition.code === "number" && typeof condition.label === "string" && typeof condition.text === "string");
      assert.ok(new Date(day.sunrise as string) < new Date(day.sunset as string));
    }
  }
  const metric = body("v2", "getDailyForecast", { query: { ...at(london), days: 1 } }).days as Json[];
  const imperial = body("v2", "getDailyForecast", { query: { ...at(london), days: 1, units: "imperial" } }).days as Json[];
  const si = body("v2", "getDailyForecast", { query: { ...at(london), days: 1, units: "si" } }).days as Json[];
  const c = (metric[0] as Json).temperature_max as number;
  assert.ok(Math.abs(((imperial[0] as Json).temperature_max as number) - (c * 1.8 + 32)) < 0.2, "°F");
  assert.ok(Math.abs(((si[0] as Json).temperature_max as number) - (c + 273.15)) < 0.2, "K");
  assert.ok(Math.abs(((imperial[0] as Json).precipitation_sum as number) - ((metric[0] as Json).precipitation_sum as number) / 25.4) < 0.02, "inches");
  assert.ok(Math.abs(((si[0] as Json).precipitation_sum as number) - ((metric[0] as Json).precipitation_sum as number) / 1000) < 0.001, "metres");
  assert.ok(Math.abs(((imperial[0] as Json).wind_max as number) - ((metric[0] as Json).wind_max as number) * 2.23694) < 0.2, "mph");
  const obsMetric = body("v2", "getNearestObservation", { query: at(london) }).conditions as Json;
  const obsImperial = body("v2", "getNearestObservation", { query: { ...at(london), units: "imperial" } }).conditions as Json;
  const obsSi = body("v2", "getNearestObservation", { query: { ...at(london), units: "si" } }).conditions as Json;
  assert.equal(obsImperial.pressure, obsMetric.pressure, "the specs keep hPa in imperial");
  assert.equal(obsSi.pressure, Math.round((obsMetric.pressure as number) * 100), "Pa");
  assert.equal(obsSi.visibility, Math.round((obsMetric.visibility as number) * 1000), "metres");
  assert.ok(Math.abs((obsImperial.visibility as number) - (obsMetric.visibility as number) * 0.621371) < 0.2, "miles");
});

test("v1 is imperial with text conditions, a derived icon, compass wind, and local sunrise", () => {
  const forecast = body("v1", "getForecast", { query: { ...at(nairobi, true), days: 2 } });
  const day = (forecast.days as Json[])[0] as Json;
  assert.ok((day.high_f as number) > 60, `Nairobi high ${day.high_f} °F`);
  assert.ok((day.high_f as number) > (day.low_f as number));
  assert.equal(typeof day.condition, "string");
  assert.match(day.sunrise as string, /^\d{2}:\d{2}$/);
  const current = body("v1", "getCurrent", { query: at(london, true) });
  const conditions = current.conditions as Json;
  assert.match(conditions.wind_dir as string, /^[NESW]{1,3}$/);
  assert.ok(["clear", "partly-cloudy", "cloudy", "fog", "rain", "snow", "thunderstorm"].includes(conditions.icon as string));
  const hourly = body("v1", "getHourlyForecast", { query: { ...at(london, true), hours: 2 } });
  assert.equal((hourly.hours as Json[]).length, 2);
});

test("hourly values are coherent and v3-preview's spreads are ordered around the temperature", () => {
  const hours = body("v3-preview", "getHourlyForecast", { query: { ...at(london), hours: 6 } }).hours as Json[];
  assert.equal(hours.length, 6);
  for (const hour of hours) {
    const wind = hour.wind as Json;
    assert.ok((wind.gust as number) >= (wind.speed as number), "gust at or above speed");
    assert.ok(Number.isInteger(wind.direction) && (wind.direction as number) >= 0 && (wind.direction as number) < 360);
    const spread = hour.temperature_spread as Json;
    assert.ok((spread.p10 as number) < (spread.p50 as number) && (spread.p50 as number) < (spread.p90 as number));
    assert.equal(spread.p50, hour.temperature);
  }
  const days = body("v3-preview", "getDailyForecast", { query: { ...at(london), days: 1 } }).days as Json[];
  const spread = (days[0] as Json).high_spread as Json;
  assert.equal(spread.p50, (days[0] as Json).temperature_max);
});

test("minutely steps are five minutes apart, non-negative, with a summary that matches them", () => {
  const minutely = body("v2", "getMinutelyPrecipitation", { query: at(london) });
  const minutes = minutely.minutes as Json[];
  assert.equal(minutes.length, 24);
  for (let i = 1; i < minutes.length; i++) {
    assert.equal(new Date(minutes[i]?.time as string).getTime() - new Date(minutes[i - 1]?.time as string).getTime(), 5 * 60_000);
  }
  for (const m of minutes) {
    assert.ok((m.intensity as number) >= 0);
    assert.ok(Number.isInteger(m.probability) && (m.probability as number) >= 0 && (m.probability as number) <= 100);
  }
  const firstWet = minutes.findIndex((m) => (m.intensity as number) > 0);
  const summary = minutely.summary as string;
  if (firstWet === -1) assert.match(summary, /^No precipitation/);
  else if (firstWet > 0) assert.equal(summary.endsWith(`starting in ${firstWet * 5} minutes.`), true, summary);
  else {
    let run = 0;
    while (run < minutes.length && (minutes[run]?.intensity as number) > 0) run++;
    const wet = minutes.filter((m) => (m.intensity as number) > 0).length;
    if (run === wet) assert.equal(summary.endsWith(`for the next ${run * 5} minutes.`), true, summary);
    else assert.equal(summary.endsWith("on and off for the next two hours."), true, summary);
  }
  // Across the world, every summary shape occurs and each states what its series shows.
  for (const city of world.cities.slice(0, 80)) {
    const m = body("v2", "getMinutelyPrecipitation", { query: at(city) });
    const steps = m.minutes as Json[];
    const first = steps.findIndex((s) => (s.intensity as number) > 0);
    const text = m.summary as string;
    if (first === -1) assert.match(text, /^No precipitation/, city.id);
    else if (first > 0) assert.ok(text.endsWith(`starting in ${first * 5} minutes.`), `${city.id}: ${text}`);
    else {
      let r = 0;
      while (r < steps.length && (steps[r]?.intensity as number) > 0) r++;
      const w = steps.filter((s) => (s.intensity as number) > 0).length;
      assert.ok(text.endsWith(r === w ? `for the next ${r * 5} minutes.` : "on and off for the next two hours."), `${city.id}: ${text}`);
    }
  }
});

test("observations: the nearest station reports now, a station lists a window newest first, bad bounds are a 400", () => {
  const obs = body("v2", "getNearestObservation", { query: at(nairobi) });
  assert.equal((obs.station as Json).name, nairobi.station.name);
  assert.equal(obs.observed_at, "2026-11-12T00:00:00Z");
  assert.match(obs.raw_metar as string, /^HKJK /);
  const list = body("v2", "listObservations", { params: { station_id: london.station.id }, query: { start: "2026-11-11T00:00:00Z", end: "2026-11-11T05:00:00Z" } });
  const items = list.data as Json[];
  assert.equal(items.length, 6);
  assert.equal(items[0]?.observed_at, "2026-11-11T05:00:00Z");
  assert.equal(items[5]?.observed_at, "2026-11-11T00:00:00Z");
  assert.equal(failure("v2", "listObservations", { params: { station_id: london.station.id }, query: { start: "2026-11-12T00:00:00Z", end: "2026-11-11T00:00:00Z" } }).param, "end");
  assert.equal((body("v2", "listObservations", { params: { station_id: london.station.id }, query: { quality: "suspect" } }).data as Json[]).length, 0);
  assert.equal(failure("v2", "getLatestObservation", { params: { station_id: "stn_00000" } }).status, 404);
  assert.equal((body("v1", "getCurrentConditions", { params: { id: london.station.wmoId } }).station as Json).id, london.station.wmoId);
});

test("history is anchored to the requested dates, with the sandbox's limits and a 400 for a reversed range", () => {
  const days = body("v2", "getDailyHistory", { query: { ...at(london), start_date: "2026-01-01", end_date: "2026-01-03" } }).days as Json[];
  assert.deepEqual(days.map((d) => d.date), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  const hours = body("v2", "getHourlyHistory", { query: { ...at(london), start_date: "2026-01-01", end_date: "2026-01-01" } }).hours as Json[];
  assert.equal(hours.length, 24);
  assert.equal(hours[0]?.time, "2026-01-01T00:00:00Z");
  assert.equal(failure("v2", "getDailyHistory", { query: { ...at(london), start_date: "2026-02-01", end_date: "2026-01-01" } }).param, "end_date");
  const key = body("v2", "createApiKey", { body: { name: "Dated", expires_at: "2026-12-31T23:59:59Z" } });
  assert.equal((key.key as Json).expires_at, "2026-12-31T23:59:59Z");
  assert.equal(failure("v2", "createApiKey", { body: { name: "Dated", expires_at: "2026-02-30T00:00:00Z" } }).param, "expires_at");
  assert.equal(failure("v2", "createApiKey", { body: { name: "Dated", expires_at: "2026-12-31T23:59Z" } }).param, "expires_at");
  assert.equal(failure("v2", "createApiKey", { body: { name: "Dated", expires_at: "2026-12-31T24:00:00Z" } }).param, "expires_at");
  assert.equal(failure("v2", "createApiKey", { body: { name: "Dated", expires_at: "2026-12-31T23:60:00Z" } }).param, "expires_at");
  assert.equal(failure("v2", "getDailyHistory", { query: { ...at(london), start_date: "2020-01-01", end_date: "2026-01-01" } }).status, 400);
  assert.equal(failure("v2", "getHourlyHistory", { query: { ...at(london), start_date: "2026-01-01", end_date: "2026-03-01" } }).status, 400);
  const v1 = body("v1", "getHistory", { query: { ...at(london, true), from: "2026-01-01", to: "2026-01-02" } }).days as Json[];
  assert.equal(v1.length, 2);
  assert.equal(typeof (v1[0] as Json).high_f, "number");
});

// ---------------------------------------------------------------------------
// Alerts and stations
// ---------------------------------------------------------------------------

test("standing alerts sit in the frozen day's window, filter by country, event and severity, and resolve by id", () => {
  const point = body("v2", "listAlertsForPoint", { query: at(oslo) }) as unknown as Json[];
  assert.equal(point.length, 1);
  assert.equal(point[0]?.onset, "2026-11-12T17:00:00Z");
  assert.equal(point[0]?.expires, "2026-11-13T05:00:00Z");
  assert.equal(point[0]?.headline, "Heavy snow warning for Oslo");
  assert.deepEqual(body("v2", "listAlertsForPoint", { query: at(london) }), []);
  const no = body("v2", "listActiveAlerts", { query: { country: "NO" } });
  assert.equal((no.data as Json[]).length, 1);
  assert.equal(no.has_more, false);
  assert.equal((body("v2", "listActiveAlerts", { query: { country: "GB" } }).data as Json[]).length, 0);
  assert.equal((body("v2", "listActiveAlerts", { query: { severity: "extreme" } }).data as Json[]).length, 0);
  assert.equal((body("v2", "listActiveAlerts", { query: { severity: "moderate" } }).data as Json[]).length, 2);
  assert.equal((body("v2", "listActiveAlerts", { query: { event: "flood" } }).data as Json[]).length, 0);
  const id = (no.data as Json[])[0]?.id as string;
  assert.equal(body("v2", "getAlert", { params: { alert_id: id } }).id, id);
  assert.equal(failure("v2", "getAlert", { params: { alert_id: "alt_19990101_0001" } }).status, 404);
  const v1 = body("v1", "listAlerts", { query: { country: "FI" } });
  const alert = (v1.results as Json[])[0] as Json;
  assert.equal(alert.title, "Heavy snow warning for Helsinki and Uusimaa");
  assert.deepEqual(alert.regions, ["Helsinki"]);
  assert.equal(alert.starts, "2026-11-12T17:00:00Z");
  assert.equal((body("v1", "listAlerts", { query: { level: "warning" } }).results as Json[]).length, 2);
});

test("stations list by country with filters, resolve by id in both id forms, and zones resolve to their city", () => {
  const gb = body("v2", "listStations", { query: { country: "GB", limit: 3 } });
  assert.equal((gb.data as Json[]).length, 3);
  assert.equal(gb.next_cursor, "c_3");
  assert.equal((body("v2", "listStations", { query: { country: "GB", network: "private" } }).data as Json[]).length, 0);
  assert.equal((body("v2", "listStations", { query: { country: "GB", active: false } }).data as Json[]).length, 0);
  assert.equal(body("v2", "getStation", { params: { station_id: london.station.id } }).name, london.station.name);
  const v1 = body("v1", "getStation", { params: { id: london.station.wmoId } });
  assert.equal(v1.id, london.station.wmoId);
  assert.equal(typeof v1.elevation_ft, "number");
  assert.equal(failure("v2", "getStation", { params: { station_id: "stn_00000" } }).status, 404);
  assert.equal(body("v2", "getZone", { params: { zone_id: london.zone.id } }).name, "London");
  assert.equal((body("v2", "listZones", { query: { country: "GB", limit: 2 } }).data as Json[]).length, 2);
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

test("creating a station echoes the body in the response's shape with defaults from the spec, and rejects bad values", () => {
  const created = body("v2", "createStation", { body: { name: "Roof", latitude: 51.5, longitude: -0.12 } });
  assert.match(created.id as string, /^stn_[a-z0-9]{6}$/);
  assert.equal(created.name, "Roof");
  assert.deepEqual(created.coordinates, { latitude: 51.5, longitude: -0.12, elevation: 0 });
  assert.equal(created.country, "GB");
  assert.equal(created.network, "private");
  assert.equal(created.public, false);
  assert.deepEqual(created.sensors, []);
  assert.equal(failure("v2", "getStation", { params: { station_id: created.id as string } }).status, 404);
  assert.equal(failure("v2", "createStation", { body: { name: "Roof", latitude: "x", longitude: -0.12 } }).param, "latitude");
  assert.equal(failure("v2", "createStation", { body: { name: "Roof", latitude: 95, longitude: -0.12 } }).status, 400);
  assert.equal(failure("v2", "createStation", { body: { latitude: 51.5, longitude: -0.12 } }).param, "name");
  assert.equal(failure("v2", "createStation", { body: "nope" }).param, "body");
  const same = body("v2", "createStation", { body: { name: "Roof", latitude: 51.5, longitude: -0.12 } });
  assert.deepEqual(same, created);
});

test("updating a station keeps the path id and the station's other fields", () => {
  const updated = body("v2", "updateStation", { params: { station_id: london.station.id }, body: { name: "Renamed", public: true } });
  assert.equal(updated.id, london.station.id);
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.public, true);
  const current = body("v2", "getStation", { params: { station_id: london.station.id } });
  assert.deepEqual(updated.coordinates, current.coordinates);
  assert.equal(updated.wmo_id, current.wmo_id);
  assert.equal(failure("v2", "updateStation", { params: { station_id: london.station.id }, body: { public: "yes" } }).param, "public");
  assert.equal(failure("v2", "updateStation", { params: { station_id: "stn_00000" }, body: { name: "x" } }).status, 404);
});

test("keys, members and subscriptions echo through their mappings and reject bad input", () => {
  const key = body("v2", "createApiKey", { body: { name: "Staging", allowed_origins: ["https://example.com"] } });
  assert.equal((key.key as Json).name, "Staging");
  assert.match(key.secret as string, /^wx_test_/);
  assert.equal((key.key as Json).prefix, (key.secret as string).slice(0, 12));
  assert.deepEqual((key.key as Json).allowed_origins, ["https://example.com"]);
  assert.equal(failure("v2", "createApiKey", { body: { name: "Staging", scopes: ["everything"] } }).param, "scopes");
  assert.equal(failure("v2", "createApiKey", { body: {} }).param, "name");
  const v1key = body("v1", "createApiKey", { body: { name: "Legacy" } });
  assert.equal((v1key.key as Json).name, "Legacy");
  assert.equal("scopes" in (v1key.key as Json), false);

  const member = body("v2", "inviteMember", { body: { email: "ola@example.com", role: "developer" } });
  assert.equal(member.email, "ola@example.com");
  assert.equal("joined_at" in member, false);
  assert.equal(failure("v2", "inviteMember", { body: { email: "nope", role: "developer" } }).param, "email");
  assert.equal(failure("v2", "inviteMember", { body: { email: "ola@example.com", role: "emperor" } }).param, "role");

  const sub = body("v2", "createSubscription", { body: { url: "https://example.com/hooks", events: ["alert.issued"] } });
  assert.deepEqual(sub.events, ["alert.issued"]);
  assert.equal(sub.active, true);
  assert.equal(failure("v2", "createSubscription", { body: { url: "http://example.com/hooks", events: ["alert.issued"] } }).param, "url");
  assert.equal(failure("v2", "createSubscription", { body: { url: "https://???", events: ["alert.issued"] } }).param, "url");
  assert.equal(failure("v2", "createApiKey", { body: { name: "Web", allowed_origins: ["https://example.com/path"] } }).param, "allowed_origins");
  assert.equal(failure("v2", "createApiKey", { body: { name: "Web", allowed_origins: ["https://???"] } }).param, "allowed_origins");
  assert.equal(failure("v2", "createSubscription", { body: { url: "https://example.com/hooks", events: [] } }).param, "events");
  assert.equal(failure("v2", "createSubscription", { body: { url: "https://example.com/hooks", events: ["alert.exploded"] } }).param, "events");
  assert.equal(failure("v2", "createSubscription", { body: { url: "https://example.com/hooks" } }).param, "events");
});

test("batch forecasts compose one forecast per point, echo refs only when sent, honour kind and units, and reject bad points", () => {
  const batch = body("v2", "batchForecasts", { body: { points: [{ latitude: nairobi.latitude, longitude: nairobi.longitude, ref: "nbo" }, { latitude: oslo.latitude, longitude: oslo.longitude }], kind: "daily", units: "imperial" } });
  const results = batch.results as Json[];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ref, "nbo");
  assert.equal("ref" in (results[1] as Json), false);
  assert.equal(((results[0]?.forecast as Json).location as Json).name, "Nairobi");
  assert.equal((results[0]?.forecast as Json).units, "imperial");
  assert.equal(((results[0]?.forecast as Json).days as Json[]).length, 7);
  const hourly = body("v2", "batchForecasts", { body: { points: [{ latitude: 1, longitude: 1 }], kind: "hourly" } });
  assert.equal((((hourly.results as Json[])[0] as Json).forecast as Json).hours !== undefined, true);
  // Each composed forecast is a single-point response and validates as one.
  assert.equal(validateResponse("v2", route("v2", "getDailyForecast"), results[0]?.forecast), null);
  assert.equal(validateResponse("v2", route("v2", "getHourlyForecast"), ((hourly.results as Json[])[0] as Json).forecast), null);
  assert.equal(failure("v2", "batchForecasts", { body: { points: [{ latitude: 1, longitude: 1, ref: 123 }], kind: "daily" } }).param, "points");
  assert.equal(failure("v2", "batchForecasts", { body: { points: [{ latitude: 999, longitude: 0 }], kind: "daily" } }).param, "points");
  assert.equal(failure("v2", "batchForecasts", { body: { points: [], kind: "daily" } }).param, "points");
  assert.equal(failure("v2", "batchForecasts", { body: { points: [{ latitude: 1, longitude: 1 }], kind: "weekly" } }).param, "kind");
  assert.equal(failure("v2", "batchForecasts", { body: { points: Array.from({ length: 101 }, () => ({ latitude: 1, longitude: 1 })), kind: "daily" } }).param, "points");
});

// ---------------------------------------------------------------------------
// Everything else is the documented example
// ---------------------------------------------------------------------------

test("an operation outside the families returns its documented example unchanged", () => {
  const r = route("v2", "getClimateNormals");
  const result = answer(r, ask("v2", { query: at(london) }));
  assert.ok(!("error" in result));
  assert.deepEqual(JSON.parse(result.body ?? "null"), JSON.parse(r.body ?? "null"));
  assert.ok(!internals.HANDLERS.getClimateNormals);
});
