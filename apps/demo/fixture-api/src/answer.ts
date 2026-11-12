/**
 * The overlay: every answer starts from the operation's documented example
 * (routes.json) and is rewritten from the request, for the route families
 * where inputs matter. The example is the one body guaranteed to match the
 * version's shape, so the overlay changes values and series lengths, never an
 * element's keys. Operations outside the families return the example as is.
 *
 * The clock is frozen at UTC midnight of the request's day: the same request
 * gives the same body all day and changes at midnight.
 */
import { type Field, type Scalar, validateBody } from "./validate";
import {
  type ConditionTuple,
  type DayWeather,
  type HourWeather,
  type Units,
  compass,
  dayWeather,
  depth,
  distance,
  hourWeather,
  iconFor,
  isoDate,
  length,
  localClock,
  pressureIn,
  roll,
  round,
  speed,
  spread,
  temperature,
} from "./weather";
import { type City, distanceKm, hash32, world } from "./world";

export interface Route {
  operationId?: string;
  method: string;
  path: string;
  pattern: string;
  key: { in: "header" | "query"; name: string; bearer?: boolean } | null;
  requiredQuery: string[];
  query: Field[];
  bodyFields?: Field[];
  status: number;
  mediaType?: string;
  body?: string;
}

export type Version = "v1" | "v2" | "v3-preview";

export interface Ask {
  version: Version;
  /** Path parameters, by the spec's names. */
  params: Record<string, string>;
  /** Declared query parameters that were sent, parsed. */
  query: Record<string, Scalar>;
  /** The JSON body, when the request had one that parsed. */
  body?: unknown;
  /** The request's instant; the overlay freezes it to UTC midnight. */
  now: Date;
}

export interface Failure {
  error: { status: number; code: string; message: string; param?: string };
}

export type Answer = { status: number; body?: string; mediaType?: string } | Failure;

type Json = Record<string, unknown>;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const STANDING_ALERTS = ["loc_oslo_no", "loc_helsinki_fi"];
const HISTORY_LIMIT_DAYS = { daily: 366, hourly: 31 };
const DEFAULT_LIMIT = 50;

export function answer(route: Route, ask: Ask): Answer {
  if (route.body === undefined || !/json/.test(route.mediaType ?? "")) return { status: route.status, body: route.body, mediaType: route.mediaType };
  const example = JSON.parse(route.body) as unknown;
  const now = midnight(ask.now);
  const ctx: Ctx = { ...ask, now, units: unitsOf(ask), example, route };
  const handler = HANDLERS[route.operationId ?? ""];
  const result = handler ? handler(ctx) : example;
  if (isError(result)) return result;
  return { status: route.status, body: JSON.stringify(result, null, 2), mediaType: route.mediaType };
}

interface Ctx extends Ask {
  units: Units;
  example: unknown;
  route: Route;
}

type Handler = (ctx: Ctx) => unknown;

function isError(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as Json).error === "object";
}

function fail(status: number, code: string, message: string, param?: string): Failure {
  return { error: { status, code, message, ...(param ? { param } : {}) } };
}

const notFound = (what: string, id: string) => fail(404, "not_found", `No ${what} ${id}.`);

export function midnight(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

function unitsOf(ask: Ask): Units {
  const units = ask.query.units;
  return units === "imperial" || units === "si" ? units : "metric";
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

function point(ctx: Ctx): { latitude: number; longitude: number } {
  const lat = ctx.query.lat ?? ctx.query.latitude;
  const lon = ctx.query.lon ?? ctx.query.longitude;
  return { latitude: Number(lat), longitude: Number(lon) };
}

function nearest(ctx: Ctx): City {
  const { latitude, longitude } = point(ctx);
  return world.nearest(latitude, longitude);
}

function cityById(ctx: Ctx): City | Failure {
  const id = ctx.params.location_id ?? "";
  return world.city(id) ?? notFound("location", id);
}

function stationOwner(ctx: Ctx): City | Failure {
  const id = ctx.params.station_id ?? ctx.params.id ?? "";
  return world.stationOwner(id) ?? notFound("station", id);
}

// ---------------------------------------------------------------------------
// The place overlay
// ---------------------------------------------------------------------------

const EXAMPLE = {
  city: "loc_oslo_no",
  name: "Oslo",
  region: "Akershus",
  stationIds: ["stn_01492", "01492"],
  stationName: "Oslo – Blindern",
  zoneId: "zone_no_03",
  icao: "ENGM",
  sender: "Norwegian Meteorological Institute",
};

function isV1(ctx: Ctx): boolean {
  return ctx.version === "v1";
}

/** Location fields for a city, in the version's shape, limited to the template's keys. */
function locationValues(city: City, v1: boolean): Json {
  return {
    id: city.id,
    name: city.name,
    region: city.region,
    country: city.country,
    timezone: city.timezone,
    lat: city.latitude,
    lon: city.longitude,
    coordinates: { latitude: city.latitude, longitude: city.longitude, elevation: city.elevation },
    population: city.population,
    ...(v1 ? {} : {}),
  };
}

/** A station sits a short way from its city's centre. */
export function stationPoint(city: City): { latitude: number; longitude: number } {
  return { latitude: round(city.latitude + 0.02, 4), longitude: round(city.longitude - 0.03, 4) };
}

function stationValues(city: City, v1: boolean): Json {
  const s = city.station;
  const { latitude, longitude } = stationPoint(city);
  return {
    id: v1 ? s.wmoId : s.id,
    wmo_id: s.wmoId,
    icao: s.icao,
    name: s.name,
    lat: latitude,
    lon: longitude,
    elevation_ft: Math.round(city.elevation * 3.281),
    coordinates: { latitude, longitude, elevation: city.elevation },
    country: city.country,
  };
}

/** Rewrite every example-city value in a body with the subject's. */
export function withPlace<T>(node: T, city: City, v1: boolean): T {
  return walk(node) as T;

  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "string") return text(value);
    if (typeof value !== "object" || value === null) return value;
    const obj = value as Json;
    let out: Json = {};
    for (const [key, child] of Object.entries(obj)) out[key] = walk(child);
    if (obj.id === EXAMPLE.city) out = fill(out, locationValues(city, v1));
    else if (EXAMPLE.stationIds.includes(obj.id as string) || obj.name === EXAMPLE.stationName) out = fill(out, stationValues(city, v1));
    if (obj.zone_id === EXAMPLE.zoneId) {
      out.zone_id = city.zone.id;
      out.name = city.zone.name;
      if (typeof out.geometry === "object" && out.geometry && "coordinates" in (out.geometry as Json)) {
        (out.geometry as Json).coordinates = box(city);
      }
    }
    return out;
  }

  function text(value: string): string {
    if (value === EXAMPLE.city) return city.id;
    if (value === EXAMPLE.zoneId) return city.zone.id;
    if (EXAMPLE.stationIds.includes(value)) return v1 ? city.station.wmoId : city.station.id;
    if (value === EXAMPLE.sender) return `${city.country} national weather service`;
    const area = city.region && city.region !== city.name ? `${city.name} and ${city.region}` : city.name;
    return value
      .replaceAll(`${EXAMPLE.name} and ${EXAMPLE.region}`, area)
      .replaceAll(EXAMPLE.stationName, city.station.name)
      .replaceAll(EXAMPLE.region, city.region)
      .replaceAll(EXAMPLE.name, city.name)
      .replaceAll(EXAMPLE.icao, city.station.icao);
  }
}

/** A small GeoJSON box around the city, as a Polygon's coordinates. */
function box(city: City): number[][][] {
  const d = 0.15;
  const { latitude: la, longitude: lo } = city;
  return [[[round(lo - d, 2), round(la - d, 2)], [round(lo + d, 2), round(la - d, 2)], [round(lo + d, 2), round(la + d, 2)], [round(lo - d, 2), round(la + d, 2)], [round(lo - d, 2), round(la - d, 2)]]];
}

/** Set the template's keys from `values`, recursing into nested objects; keys the template lacks are never added. */
export function fill(template: Json, values: Json): Json {
  const out: Json = {};
  for (const [key, current] of Object.entries(template)) {
    if (!(key in values)) {
      out[key] = current;
      continue;
    }
    const next = values[key];
    if (typeof current === "object" && current !== null && !Array.isArray(current) && typeof next === "object" && next !== null && !Array.isArray(next)) {
      out[key] = fill(current as Json, next as Json);
    } else {
      out[key] = next;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weather values, keyed the way the specs name them
// ---------------------------------------------------------------------------

function conditionValue(template: unknown, condition: ConditionTuple): unknown {
  return typeof template === "string" ? condition.text : { code: condition.code, label: condition.label, text: condition.text };
}

function dayValues(city: City, day: DayWeather, units: Units, template: Json): Json {
  const key = `${city.id}|${day.date}`;
  return {
    date: day.date,
    high_f: temperature(day.max, "imperial"),
    low_f: temperature(day.min, "imperial"),
    precip_chance: day.probability,
    sunrise: typeof template.sunrise === "string" && !template.sunrise.includes("T") ? localClock(city, day.sunrise) : day.sunrise.toISOString().replace(".000", ""),
    sunset: typeof template.sunset === "string" && !template.sunset.includes("T") ? localClock(city, day.sunset) : day.sunset.toISOString().replace(".000", ""),
    condition: conditionValue(template.condition, day.condition),
    temperature_max: temperature(day.max, units),
    temperature_min: temperature(day.min, units),
    precipitation_sum: length(day.precipitation, units),
    precipitation_probability: day.probability,
    snowfall_sum: depth(day.snowfall, units),
    wind_max: speed(day.windMax, units),
    uv_index_max: day.uvMax,
    high_spread: spread(day.max, `${key}|high`, units),
  };
}

function hourValues(city: City, hour: HourWeather, units: Units, template: Json): Json {
  const key = `${city.id}|${hour.time.toISOString()}`;
  return {
    time: iso(hour.time),
    temp_f: temperature(hour.temperature, "imperial"),
    precip_in: length(hour.precipitation, "imperial"),
    precip_chance: hour.probability,
    wind_mph: speed(hour.wind.speed, "imperial"),
    condition: conditionValue(template.condition, hour.condition),
    temperature: temperature(hour.temperature, units),
    feels_like: temperature(hour.feelsLike, units),
    precipitation: length(hour.precipitation, units),
    precipitation_probability: hour.probability,
    wind: { speed: speed(hour.wind.speed, units), gust: speed(hour.wind.gust, units), direction: hour.wind.direction },
    cloud_cover: hour.cloud,
    temperature_spread: spread(hour.temperature, `${key}|t`, units),
  };
}

function conditionsValues(hour: HourWeather, units: Units, template: Json): Json {
  return {
    temp_f: temperature(hour.temperature, "imperial"),
    feels_like_f: temperature(hour.feelsLike, "imperial"),
    humidity: hour.humidity,
    pressure_mb: hour.pressure,
    wind_mph: speed(hour.wind.speed, "imperial"),
    wind_dir: compass(hour.wind.direction),
    visibility_mi: distance(hour.visibility, "imperial"),
    condition: conditionValue(template.condition, hour.condition),
    icon: iconFor(hour.condition),
    temperature: temperature(hour.temperature, units),
    feels_like: temperature(hour.feelsLike, units),
    dew_point: temperature(hour.dewPoint, units),
    pressure: pressureIn(hour.pressure, units),
    wind: { speed: speed(hour.wind.speed, units), gust: speed(hour.wind.gust, units), direction: hour.wind.direction },
    visibility: distance(hour.visibility, units),
    cloud_cover: hour.cloud,
    uv_index: hour.uv,
  };
}

function iso(instant: Date): string {
  return instant.toISOString().replace(".000", "");
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

function series<T>(template: Json, count: number, at: (index: number) => Json): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < count; i++) out.push(fill(template, at(i)));
  return out;
}

function first(array: unknown): Json {
  return Array.isArray(array) && array.length ? (array[0] as Json) : {};
}

function forecastEnvelope(ctx: Ctx, city: City, key: "days" | "hours", items: Json[]): Json {
  const example = withPlace(ctx.example as Json, city, isV1(ctx));
  return fill(example, {
    [key]: items,
    generated_at: iso(ctx.now),
    units: ctx.units,
  });
}

function dailySeries(ctx: Ctx, city: City, start: Date, count: number): Json[] {
  const template = first((ctx.example as Json).days);
  return series(template, count, (i) => dayValues(city, dayWeather(city, new Date(start.getTime() + i * DAY)), ctx.units, template));
}

function hourlySeries(ctx: Ctx, city: City, start: Date, count: number): Json[] {
  const template = first((ctx.example as Json).hours);
  return series(template, count, (i) => hourValues(city, hourWeather(city, new Date(start.getTime() + i * HOUR)), ctx.units, template));
}

function integerQuery(ctx: Ctx, name: string, fallback: number): number {
  const value = ctx.query[name];
  return typeof value === "number" ? value : fallback;
}

/** `start`..`end` as whole UTC days, from the version's parameter names. */
function dateRange(ctx: Ctx, kind: "daily" | "hourly"): { start: Date; days: number } | Failure {
  const v1 = isV1(ctx);
  const fromName = v1 ? "from" : "start_date";
  const toName = v1 ? "to" : "end_date";
  const from = String(ctx.query[fromName]);
  const to = String(ctx.query[toName]);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (end < start) return fail(400, "invalid_request", `${toName} must not be before ${fromName}.`, toName);
  const days = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  const limit = HISTORY_LIMIT_DAYS[kind];
  if (days > limit) return fail(400, "invalid_request", `The sandbox serves up to ${limit} days per request; ask for a shorter range.`, toName);
  return { start, days };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function paginate(ctx: Ctx, example: Json, items: Json[]): Json {
  if (isV1(ctx)) {
    const perPage = integerQuery(ctx, "per_page", DEFAULT_LIMIT);
    const page = integerQuery(ctx, "page", 1);
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    return fill(example, { results: items.slice((page - 1) * perPage, page * perPage), page, total_pages: totalPages });
  }
  const limit = integerQuery(ctx, "limit", DEFAULT_LIMIT);
  const cursor = typeof ctx.query.cursor === "string" ? Number(ctx.query.cursor.replace(/^c_/, "")) || 0 : 0;
  const pageItems = items.slice(cursor, cursor + limit);
  const hasMore = cursor + limit < items.length;
  return fill(example, { data: pageItems, next_cursor: hasMore ? `c_${cursor + limit}` : null, has_more: hasMore });
}

function listTemplate(ctx: Ctx): Json {
  const example = ctx.example as Json;
  return first(isV1(ctx) ? example.results : example.data);
}

function stringQuery(ctx: Ctx, name: string): string | undefined {
  const value = ctx.query[name];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const SEVERITIES = ["minor", "moderate", "severe", "extreme"];
const LEVELS = ["advisory", "watch", "warning"];

function alertId(ctx: Ctx, city: City): string {
  const day = isoDate(ctx.now).replaceAll("-", "");
  const n = String(STANDING_ALERTS.indexOf(city.id) + 42).padStart(4, "0");
  return isV1(ctx) ? `a-${day}-${n}` : `alt_${day}_${n}`;
}

/** The standing alert for a city, from the example alert, in the frozen day's window. */
function alertFor(ctx: Ctx, template: Json, city: City): Json {
  const placed = withPlace(template, city, isV1(ctx));
  const onset = new Date(ctx.now.getTime() + 17 * HOUR);
  const expires = new Date(ctx.now.getTime() + 29 * HOUR);
  return fill(placed, { id: alertId(ctx, city), onset: iso(onset), expires: iso(expires), starts: iso(onset), references: [] });
}

function standingAlerts(ctx: Ctx, template: Json, cities: City[]): Json[] {
  return cities.filter((city) => STANDING_ALERTS.includes(city.id)).map((city) => alertFor(ctx, template, city));
}

function alertFilters(ctx: Ctx, alerts: Json[]): Json[] {
  const event = stringQuery(ctx, "event");
  const severity = stringQuery(ctx, "severity");
  const level = stringQuery(ctx, "level");
  return alerts.filter((alert) => {
    if (event && alert.event !== event) return false;
    if (severity && SEVERITIES.indexOf(String(alert.severity)) < SEVERITIES.indexOf(severity)) return false;
    if (level && LEVELS.indexOf(String(alert.level)) < LEVELS.indexOf(level)) return false;
    return true;
  });
}

function alertOwner(ctx: Ctx): City | Failure {
  const id = ctx.params.alert_id ?? "";
  const city = STANDING_ALERTS.map((cityId) => world.city(cityId) as City).find((candidate) => alertId(ctx, candidate) === id);
  return city ?? notFound("alert", id);
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

function stationBody(ctx: Ctx, template: Json, city: City): Json {
  return withPlace(template, city, isV1(ctx));
}

function stationFilters(ctx: Ctx, cities: City[]): City[] {
  const network = stringQuery(ctx, "network");
  const active = ctx.query.active;
  if (network && network !== "synoptic") return [];
  if (active === false) return [];
  return cities;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function observation(ctx: Ctx, template: Json, city: City, at: Date): Json {
  const placed = withPlace(template, city, isV1(ctx));
  const hour = hourWeather(city, at);
  const conditions = typeof placed.conditions === "object" && placed.conditions ? (placed.conditions as Json) : {};
  const day = isoDate(at).replaceAll("-", "").slice(2);
  return fill(placed, {
    id: isV1(ctx) ? `${8_000_000 + (hash32(`${city.id}|${at.toISOString()}`) % 999_999)}` : `obs_${8_000_000 + (hash32(`${city.id}|${at.toISOString()}`) % 999_999)}`,
    observed_at: iso(at),
    conditions: conditionsValues(hour, ctx.units, conditions),
    raw_metar: `${city.station.icao} ${day.slice(4)}${String(at.getUTCHours()).padStart(2, "0")}${String(at.getUTCMinutes()).padStart(2, "0")}Z ${String(hour.wind.direction).padStart(3, "0")}${String(Math.round(hour.wind.speed * 1.944)).padStart(2, "0")}KT ${Math.round(hour.visibility * 1000)} ${hour.condition.label.startsWith("snow") ? "-SN " : hour.condition.label.startsWith("rain") ? "-RA " : ""}${hour.cloud > 85 ? "OVC" : hour.cloud > 50 ? "BKN" : "SCT"}0${20 + Math.round(hour.cloud / 10)} ${metarTemp(hour.temperature)}/${metarTemp(hour.dewPoint)} Q${Math.round(hour.pressure)}`,
  });
}

function metarTemp(celsius: number): string {
  const value = Math.round(celsius);
  return `${value < 0 ? "M" : ""}${String(Math.abs(value)).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The validated body; an update takes the same fields as a create, all optional. */
function parsedBody(ctx: Ctx, { partial = false } = {}): Record<string, unknown> | Failure {
  const fields = (ctx.route.bodyFields ?? []).map((field) => (partial ? { ...field, required: false } : field));
  const result = validateBody(fields, ctx.body);
  if (!result.ok) return fail(400, "invalid_request", result.message, result.param);
  return result.values;
}

function newId(prefix: string, body: unknown): string {
  return `${prefix}_${hash32(JSON.stringify(body)).toString(36).slice(0, 6)}`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** `https://host[:port]`, nothing after the host. */
function isOrigin(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") && url.origin === value && url.hostname.includes(".");
}

function isHttpsUrl(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && url.protocol === "https:" && url.hostname.includes(".");
}

function inRange(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && typeof longitude === "number" && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function createdStation(ctx: Ctx, template: Json, values: Record<string, unknown>, id: string, base?: Json): Json {
  const latitude = values.latitude as number | undefined;
  const longitude = values.longitude as number | undefined;
  const home = base ?? withPlace(template, latitude !== undefined && longitude !== undefined ? world.nearest(latitude, longitude) : world.example(), false);
  const current = (home.coordinates as Json | undefined) ?? {};
  return fill(home, {
    id,
    wmo_id: base ? home.wmo_id : null,
    icao: base ? home.icao : null,
    name: values.name ?? home.name,
    coordinates: {
      latitude: latitude ?? current.latitude,
      longitude: longitude ?? current.longitude,
      elevation: values.elevation ?? (base ? current.elevation : 0),
    },
    country: latitude !== undefined && longitude !== undefined ? world.nearest(latitude, longitude).country : home.country,
    network: base ? home.network : "private",
    owner: base ? home.owner : "org_7Tn1",
    active: true,
    reporting_interval: values.reporting_interval ?? (base ? home.reporting_interval : 10),
    public: values.public ?? (base ? home.public : false),
    sensors: base ? home.sensors : [],
  });
}

// ---------------------------------------------------------------------------
// Handlers, by operation id (the same ids across versions)
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, Handler> = {
  searchLocations(ctx) {
    const q = String(ctx.query.q ?? "");
    const matches = world.search(q, stringQuery(ctx, "country"));
    const template = listTemplate(ctx);
    return paginate(ctx, ctx.example as Json, matches.map((city) => withPlace(template, city, isV1(ctx))));
  },
  reverseGeocode(ctx) {
    return withPlace(ctx.example as Json, nearest(ctx), isV1(ctx));
  },
  getLocation(ctx) {
    const city = cityById(ctx);
    return isError(city) ? city : withPlace(ctx.example as Json, city, isV1(ctx));
  },
  listNearbyStations(ctx) {
    const city = cityById(ctx);
    if (isError(city)) return city;
    const radius = typeof ctx.query.radius === "number" ? ctx.query.radius : 25;
    const template = listTemplate(ctx);
    const near = world.cities
      .map((candidate) => {
        const station = stationPoint(candidate);
        return { candidate, km: round(distanceKm(city.latitude, city.longitude, station.latitude, station.longitude)) };
      })
      .filter(({ km }) => km <= radius)
      .sort((a, b) => a.km - b.km);
    const items = near.map(({ candidate, km }) => fill(withPlace(template, candidate, false), { distance_km: km }));
    return paginate(ctx, ctx.example as Json, items);
  },

  getForecast: daily,
  getDailyForecast: daily,
  getHourlyForecast(ctx) {
    const city = nearest(ctx);
    const hours = integerQuery(ctx, "hours", 48);
    return forecastEnvelope(ctx, city, "hours", hourlySeries(ctx, city, ctx.now, hours));
  },
  getMinutelyPrecipitation(ctx) {
    const city = nearest(ctx);
    const example = withPlace(ctx.example as Json, city, false);
    const template = first(example.minutes);
    const steps = 24;
    const minutes = series(template, steps, (i) => {
      const at = new Date(ctx.now.getTime() + i * 5 * 60_000);
      const hour = hourWeather(city, at);
      const wet = hour.precipitation > 0 && roll(city.id, at.toISOString(), "minute") < 0.7;
      return {
        time: iso(at),
        intensity: wet ? length(round(Math.max(0.1, hour.precipitation * (0.6 + roll(city.id, at.toISOString(), "i")))), ctx.units) : 0,
        probability: Math.max(0, Math.min(100, Math.round(hour.probability + (wet ? 15 : -15)))),
      };
    });
    const firstWet = minutes.findIndex((m) => (m.intensity as number) > 0);
    let summary = "No precipitation for the next two hours.";
    if (firstWet !== -1) {
      // The hour the first wet step falls in has precipitation, so its condition names the kind.
      const kind = hourWeather(city, new Date(ctx.now.getTime() + firstWet * 5 * 60_000)).condition.text;
      const wetSteps = minutes.filter((m) => (m.intensity as number) > 0).length;
      let run = 0;
      while (run < minutes.length && (minutes[run]?.intensity as number) > 0) run++;
      summary = firstWet > 0 ? `${kind} starting in ${firstWet * 5} minutes.` : run === wetSteps ? `${kind} for the next ${run * 5} minutes.` : `${kind} on and off for the next two hours.`;
    }
    return fill(example, { minutes, summary });
  },
  batchForecasts(ctx) {
    const values = parsedBody(ctx);
    if (isError(values)) return values;
    const points = values.points as unknown[];
    const kind = values.kind as "daily" | "hourly";
    const units = values.units === "imperial" || values.units === "si" ? (values.units as Units) : "metric";
    if (points.length === 0) return fail(400, "invalid_request", "points must have at least one point.", "points");
    const template = first((ctx.example as Json).results);
    const single = routeFor(ctx, kind === "daily" ? "getDailyForecast" : "getHourlyForecast");
    const results = points.map((raw, index) => {
      const p = raw as Json;
      if (!inRange(p.latitude, p.longitude)) return fail(400, "invalid_request", `points[${index}] needs latitude in -90..90 and longitude in -180..180.`, "points");
      if (p.ref !== undefined && typeof p.ref !== "string") return fail(400, "invalid_request", `points[${index}].ref must be a string.`, "points");
      const city = world.nearest(p.latitude as number, p.longitude as number);
      const inner: Ctx = { ...ctx, units, query: { latitude: p.latitude as number, longitude: p.longitude as number }, example: single ? JSON.parse(single.body ?? "{}") : {} };
      const forecast = kind === "daily" ? forecastEnvelope(inner, city, "days", dailySeries(inner, city, ctx.now, 7)) : forecastEnvelope(inner, city, "hours", hourlySeries(inner, city, ctx.now, 48));
      // The example's `forecast` is an empty placeholder, so it is set whole, not filled.
      const result = fill(template, { ref: typeof p.ref === "string" ? p.ref : undefined, status: "ok" });
      result.forecast = forecast;
      if (typeof p.ref !== "string") delete result.ref;
      return result;
    });
    const bad = results.find(isError);
    return bad ?? fill(ctx.example as Json, { results });
  },

  getCurrent: nearestObservation,
  getNearestObservation: nearestObservation,
  getCurrentConditions: latestObservation,
  getLatestObservation: latestObservation,
  listObservations(ctx) {
    const city = stationOwner(ctx);
    if (isError(city)) return city;
    const template = listTemplate(ctx);
    const end = typeof ctx.query.end === "string" ? new Date(ctx.query.end) : ctx.now;
    const start = typeof ctx.query.start === "string" ? new Date(ctx.query.start) : new Date(end.getTime() - 24 * HOUR);
    if (end < start) return fail(400, "invalid_request", "end must not be before start.", "end");
    const quality = stringQuery(ctx, "quality");
    if (quality && quality !== "checked") return paginate(ctx, ctx.example as Json, []);
    const hours = Math.min(31 * 24, Math.floor((end.getTime() - start.getTime()) / HOUR) + 1);
    const items: Json[] = [];
    for (let i = 0; i < hours; i++) items.push(observation(ctx, template, city, new Date(end.getTime() - i * HOUR)));
    return paginate(ctx, ctx.example as Json, items);
  },

  getHistory: dailyHistory,
  getDailyHistory: dailyHistory,
  getHourlyHistory(ctx) {
    const range = dateRange(ctx, "hourly");
    if (isError(range)) return range;
    const city = nearest(ctx);
    const example = withPlace(ctx.example as Json, city, false);
    return fill(example, { hours: hourlySeries(ctx, city, range.start, range.days * 24) });
  },

  listAlertsForPoint(ctx) {
    const city = nearest(ctx);
    const template = first(ctx.example);
    return standingAlerts(ctx, template, [city]);
  },
  listAlerts,
  listActiveAlerts: listAlerts,
  listZones(ctx) {
    const country = stringQuery(ctx, "country") ?? "";
    const template = listTemplate(ctx);
    return paginate(ctx, ctx.example as Json, world.inCountry(country).map((city) => withPlace(template, city, false)));
  },
  getAlert(ctx) {
    const city = alertOwner(ctx);
    return isError(city) ? city : alertFor(ctx, ctx.example as Json, city);
  },
  getZone(ctx) {
    const id = ctx.params.zone_id ?? "";
    const city = world.zoneOwner(id);
    return city ? withPlace(ctx.example as Json, city, false) : notFound("zone", id);
  },

  listStations(ctx) {
    const country = stringQuery(ctx, "country");
    const cities = stationFilters(ctx, country ? world.inCountry(country) : world.cities);
    const template = listTemplate(ctx);
    return paginate(ctx, ctx.example as Json, cities.map((city) => stationBody(ctx, template, city)));
  },
  getStation(ctx) {
    const city = stationOwner(ctx);
    return isError(city) ? city : stationBody(ctx, ctx.example as Json, city);
  },
  createStation(ctx) {
    const values = parsedBody(ctx);
    if (isError(values)) return values;
    if (!inRange(values.latitude, values.longitude)) return fail(400, "invalid_request", "latitude must be in -90..90 and longitude in -180..180.", "latitude");
    return createdStation(ctx, ctx.example as Json, values, newId("stn", values));
  },
  updateStation(ctx) {
    const city = stationOwner(ctx);
    if (isError(city)) return city;
    const values = parsedBody(ctx, { partial: true });
    if (isError(values)) return values;
    if ((values.latitude !== undefined || values.longitude !== undefined) && !inRange(values.latitude ?? city.latitude, values.longitude ?? city.longitude)) {
      return fail(400, "invalid_request", "latitude must be in -90..90 and longitude in -180..180.", "latitude");
    }
    const base = stationBody(ctx, ctx.example as Json, city);
    return createdStation(ctx, ctx.example as Json, values, String(base.id), base);
  },

  createApiKey(ctx) {
    const values = parsedBody(ctx);
    if (isError(values)) return values;
    const example = ctx.example as Json;
    const id = newId("key", values);
    const scopes = values.scopes as string[] | undefined;
    const allowed = ["weather:read", "stations:write", "alerts:manage", "exports:create"];
    if (scopes && scopes.some((scope) => !allowed.includes(scope))) return fail(400, "invalid_request", `scopes must contain only ${allowed.join(", ")}.`, "scopes");
    const origins = values.allowed_origins as string[] | undefined;
    if (origins && !origins.every(isOrigin)) return fail(400, "invalid_request", "allowed_origins must contain origins, such as https://example.com.", "allowed_origins");
    const secret = `wx_test_${hash32(JSON.stringify(values)).toString(36)}${hash32(id).toString(36)}`.slice(0, 32);
    const key = fill((example.key as Json | undefined) ?? example, {
      id,
      name: values.name,
      prefix: secret.slice(0, 12),
      scopes: scopes ?? ["weather:read"],
      allowed_origins: origins ?? [],
      created_at: iso(ctx.now),
      last_used_at: null,
      expires_at: values.expires_at ?? null,
    });
    return "key" in example ? fill(example, { key, secret }) : key;
  },
  inviteMember(ctx) {
    const values = parsedBody(ctx);
    if (isError(values)) return values;
    const email = String(values.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "invalid_request", "email must be an email address.", "email");
    const member = fill(ctx.example as Json, { id: newId("usr", values), email, role: values.role });
    delete member.joined_at;
    return member;
  },
  createSubscription(ctx) {
    const values = parsedBody(ctx);
    if (isError(values)) return values;
    const url = String(values.url);
    if (!isHttpsUrl(url)) return fail(400, "invalid_request", "url must be an https:// URL.", "url");
    const events = values.events as string[];
    if (!Array.isArray(events) || events.length === 0) return fail(400, "invalid_request", "events must have at least one event.", "events");
    return fill(ctx.example as Json, {
      id: newId("sub", values),
      url,
      events,
      zones: values.zones ?? [],
      min_severity: values.min_severity ?? "minor",
      active: true,
      created_at: iso(ctx.now),
    });
  },
};

function listAlerts(ctx: Ctx): unknown {
  const country = stringQuery(ctx, "country");
  const cities = country ? world.inCountry(country) : world.cities;
  const alerts = alertFilters(ctx, standingAlerts(ctx, listTemplate(ctx), cities));
  return paginate(ctx, ctx.example as Json, alerts);
}

function daily(ctx: Ctx): unknown {
  const city = nearest(ctx);
  const days = integerQuery(ctx, "days", 7);
  return forecastEnvelope(ctx, city, "days", dailySeries(ctx, city, ctx.now, days));
}

function dailyHistory(ctx: Ctx): unknown {
  const range = dateRange(ctx, "daily");
  if (isError(range)) return range;
  const city = nearest(ctx);
  const example = withPlace(ctx.example as Json, city, isV1(ctx));
  return fill(example, { days: dailySeries(ctx, city, range.start, range.days) });
}

function nearestObservation(ctx: Ctx): unknown {
  return observation(ctx, ctx.example as Json, nearest(ctx), ctx.now);
}

function latestObservation(ctx: Ctx): unknown {
  const city = stationOwner(ctx);
  return isError(city) ? city : observation(ctx, ctx.example as Json, city, ctx.now);
}

/** Another operation's route in the same version, for composing bodies (batch). */
let routesByVersion: Record<string, Route[]> = {};

export function registerRoutes(routes: Record<string, Route[]>): void {
  routesByVersion = routes;
}

function routeFor(ctx: Ctx, operationId: string): Route | undefined {
  return routesByVersion[ctx.version]?.find((route) => route.operationId === operationId);
}

/** Exported for tests. */
export const internals = { withPlace, fill, HANDLERS, STANDING_ALERTS };
