/**
 * The demo's fixture API, at api.demo.nimbus-docs.com: every version of the
 * Sample Co weather API (/v1, /v2, /v3-preview), so Try it can be used for
 * real. Each operation starts from its documented response; for locations,
 * forecasts, observations, history, alerts, stations and a few writes the
 * answer follows the request (src/answer.ts) over a world of cities
 * (src/world.json) with synthetic, deterministic weather. Other operations
 * return the documented example. Writes store nothing.
 *
 * - Auth: any non-empty key, sent the way that version's spec says: `?key=`
 *   for v1, a bearer token for v2 and v3-preview. No key gets the spec's 401
 *   envelope.
 * - Input: declared query parameters are checked against the spec's type,
 *   format, enum and range, and JSON bodies against their declared fields;
 *   a bad value gets the spec's 400 envelope naming the parameter.
 * - Rate limits: 60 requests a minute per address, before anything else, and
 *   10 a minute per key from one address, the limit the docs state (Try it
 *   starts everyone on the same key). `RateLimit-Policy: 10;w=60` is on every
 *   answer, and `429` with `Retry-After: 60` past either limit.
 * - CORS for the demo site and its previews, so direct sending works too.
 */
import data from "./routes.json";
import { type Ask, type Route as AnsweredRoute, type Version, answer, registerRoutes } from "./answer";
import { type Field, validateQuery } from "./validate";

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ADDRESS_LIMITER?: RateLimit;
  KEY_LIMITER?: RateLimit;
}

interface Key {
  in: "header" | "query";
  name: string;
  bearer?: boolean;
}

interface Route {
  operationId?: string;
  method: string;
  path: string;
  pattern: string;
  key: Key | null;
  requiredQuery: string[];
  query: Field[];
  bodyFields?: Field[];
  status: number;
  mediaType?: string;
  body?: string;
}

type Errors = Record<string, { error?: Record<string, unknown> }>;

const versions = Object.entries(data.versions as unknown as Record<string, { routes: Route[]; errors: Errors }>).map(([base, version]) => ({
  base,
  routes: version.routes.map((route) => ({ ...route, re: new RegExp(route.pattern) })),
  errors: version.errors,
}));
const NAMES = versions.map((version) => version.base.slice(1)).join(", ");
registerRoutes(Object.fromEntries(versions.map((version) => [version.base.slice(1), version.routes as AnsweredRoute[]])));

const ALLOWED = [/^https:\/\/demo\.nimbus-docs\.com$/, /^https:\/\/[a-z0-9-]+\.demo\.nimbus-docs\.com$/, /^https:\/\/[a-z0-9-]+-nimbus-demo[a-z0-9.-]*\.workers\.dev$/, /^http:\/\/localhost:\d+$/];

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED.some((re) => re.test(origin))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "RateLimit-Policy, Retry-After, X-Request-Id, Location",
    Vary: "Origin",
  };
}

function problem(request: Request, errors: Errors, status: number, code: string, message: string, extra: Record<string, string> = {}, param?: string): Response {
  const envelope = errors[String(status)] ?? { error: {} };
  const type = status === 401 ? "authentication" : status === 429 ? "rate_limited" : status === 404 ? "not_found" : status === 400 || status === 405 ? "invalid_request" : envelope.error?.type;
  const body = { ...envelope, error: { ...envelope.error, ...(type ? { type } : {}), code, message, ...(param ? { param } : {}) } };
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "RateLimit-Policy": "10;w=60", ...cors(request), ...extra },
  });
}

function keyFrom(request: Request, url: URL, key: Key): string | undefined {
  if (key.in === "query") return url.searchParams.get(key.name) || undefined;
  const value = request.headers.get(key.name) ?? "";
  return key.bearer ? /^Bearer (\S+)$/i.exec(value)?.[1] : value || undefined;
}

/** One bucket per IPv4 address or IPv6 /64, which a single caller can rotate within. */
function caller(address: string | null): string {
  if (!address) return "unknown";
  if (!address.includes(":") || address.includes(".")) return address;
  const [head = "", tail] = address.split("::");
  const lead = head ? head.split(":") : [];
  const rest = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - lead.length - rest.length).fill("0");
  return [...lead, ...zeros, ...rest].slice(0, 4).join(":");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && request.headers.get("access-control-request-method")) {
      const allow = cors(request);
      return new Response(null, {
        status: 204,
        headers: Object.keys(allow).length
          ? {
              ...allow,
              "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") ?? "*",
              "Access-Control-Max-Age": "600",
            }
          : {},
      });
    }
    const limited = (errors: Errors, message: string) => problem(request, errors, 429, "rate_limited", message, { "Retry-After": "60" });
    const address = caller(request.headers.get("cf-connecting-ip"));
    if (env.ADDRESS_LIMITER && !(await env.ADDRESS_LIMITER.limit({ key: address })).success) {
      return limited(versions[0]?.errors ?? {}, "Too many requests from this address. Wait and try again.");
    }
    const version = versions.find((candidate) => url.pathname.startsWith(`${candidate.base}/`));
    if (!version) return problem(request, versions[0]?.errors ?? {}, 404, "not_found", `This sandbox serves ${NAMES}.`);
    const { base, errors } = version;
    const rest = url.pathname.slice(base.length);
    const candidates = version.routes.filter((route) => route.re.test(rest));
    if (!candidates.length) return problem(request, errors, 404, "not_found", `No operation at ${rest}.`);
    const route = candidates.find((candidate) => candidate.method === request.method || (request.method === "HEAD" && candidate.method === "GET"));
    if (!route) {
      return problem(request, errors, 405, "method_not_allowed", `${request.method} isn't allowed here.`, {
        Allow: [...new Set(candidates.map((candidate) => candidate.method))].join(", "),
      });
    }
    const key = route.key ? keyFrom(request, url, route.key) : undefined;
    if (route.key) {
      const how = route.key.in === "query" ? `\`?${route.key.name}=<key>\`` : route.key.bearer ? "`Authorization: Bearer <key>`" : `\`${route.key.name}: <key>\``;
      if (!key) return problem(request, errors, 401, "missing_key", `Send ${how}. Any key works in this sandbox.`);
    }
    if (env.KEY_LIMITER && key && !(await env.KEY_LIMITER.limit({ key: `${address}|${key}` })).success) {
      return limited(errors, "Over 10 requests a minute. Wait and try again.");
    }
    const missing = route.requiredQuery.filter((name) => !url.searchParams.has(name));
    if (missing.length) return problem(request, errors, 400, "invalid_request", `Missing required query parameter: ${missing.join(", ")}.`, {}, missing[0]);
    const query = validateQuery(route.query, url.searchParams);
    if (!query.ok) return problem(request, errors, 400, "invalid_request", query.message, {}, query.param);
    // Read the body once; writes store nothing. A body that isn't JSON is a 400 for operations that declare one.
    const raw = await request.text().catch(() => "");
    let body: unknown;
    if (route.bodyFields && raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return problem(request, errors, 400, "invalid_request", "The request body must be JSON.", {}, "body");
      }
    }
    const headers: Record<string, string> = {
      "X-Request-Id": `req_${crypto.randomUUID().slice(0, 8)}`,
      "RateLimit-Policy": "10;w=60",
      ...cors(request),
    };
    if (route.status >= 300 && route.status < 400) {
      return new Response(null, { status: route.status, headers: { ...headers, Location: `${url.origin}${base}${rest}.csv` } });
    }
    if (route.status === 204 || route.body === undefined) return new Response(null, { status: route.status, headers });
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(Object.entries(route.re.exec(rest)?.groups ?? {}).map(([name, value]) => [name, decodeURIComponent(value ?? "")]));
    } catch {
      return problem(request, errors, 400, "invalid_request", "The path contains a malformed percent-encoding.", {}, "path");
    }
    const ask: Ask = {
      version: base.slice(1) as Version,
      params,
      query: query.values,
      body,
      now: new Date(),
    };
    const answered = answer(route as AnsweredRoute, ask);
    if ("error" in answered) {
      const { status, code, message, param } = answered.error;
      return problem(request, errors, status, code, message, {}, param);
    }
    if (request.method === "HEAD") return new Response(null, { status: answered.status, headers: { ...headers, "Content-Type": answered.mediaType ?? "application/json" } });
    return new Response(answered.body, { status: answered.status, headers: { ...headers, "Content-Type": answered.mediaType ?? "application/json" } });
  },
};
