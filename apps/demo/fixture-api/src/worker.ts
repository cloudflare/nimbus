/**
 * The demo's fixture API, at api.demo.nimbus-docs.com: every version of the
 * Sample Co weather API (/v1, /v2, /v3-preview), answering each operation with
 * its documented response, so Try it can be used for real. Writes store nothing.
 *
 * - Auth: any `wx_test_` key (the demo's test keys), sent the way that
 *   version's spec says: `?key=` for v1, a bearer token for v2 and v3-preview.
 *   Anything else gets the spec's 401 envelope.
 * - Rate limit: 10 requests a minute per key (per IP without one), a
 *   demonstration of the documented limit rather than abuse protection, with
 *   `RateLimit-Policy: 10;w=60` on every answer and `429` with
 *   `Retry-After: 60` past it. Needs the RATE_LIMITER binding; without it
 *   (local `wrangler dev`) nothing is limited.
 * - CORS for the demo site and its previews, so direct sending works too.
 */
import data from "./routes.json";

interface Env {
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

interface Key {
  in: "header" | "query";
  name: string;
  bearer?: boolean;
}

interface Route {
  method: string;
  path: string;
  pattern: string;
  key: Key | null;
  requiredQuery: string[];
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

function problem(request: Request, errors: Errors, status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  const envelope = errors[String(status)] ?? { error: {} };
  const type = status === 401 ? "authentication" : status === 429 ? "rate_limit" : envelope.error?.type;
  const body = { ...envelope, error: { ...envelope.error, ...(type ? { type } : {}), code, message } };
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
    const version = versions.find((candidate) => url.pathname.startsWith(`${candidate.base}/`));
    if (!version) return problem(request, versions[0]?.errors ?? {}, 404, "not_found", `This sandbox serves ${NAMES}.`);
    const { base, errors } = version;
    const rest = url.pathname.slice(base.length);
    const candidates = version.routes.filter((route) => route.re.test(rest));
    if (!candidates.length) return problem(request, errors, 404, "not_found", `No operation at ${rest}.`);
    const route = candidates.find((candidate) => candidate.method === request.method);
    if (!route) {
      return problem(request, errors, 405, "method_not_allowed", `${request.method} isn't allowed here.`, {
        Allow: [...new Set(candidates.map((candidate) => candidate.method))].join(", "),
      });
    }
    const key = route.key ? keyFrom(request, url, route.key) : undefined;
    if (route.key) {
      const how = route.key.in === "query" ? `\`?${route.key.name}=<key>\`` : route.key.bearer ? "`Authorization: Bearer <key>`" : `\`${route.key.name}: <key>\``;
      if (!key) return problem(request, errors, 401, "missing_key", `Send ${how} with a test key (wx_test_…).`);
      if (!key.startsWith("wx_test_")) return problem(request, errors, 401, "invalid_key", "This sandbox takes test keys only (wx_test_…).");
    }
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: key ?? request.headers.get("cf-connecting-ip") ?? "anonymous" });
      if (!success) return problem(request, errors, 429, "rate_limited", "Over 10 requests a minute. Wait and try again.", { "Retry-After": "60" });
    }
    const missing = route.requiredQuery.filter((name) => !url.searchParams.has(name));
    if (missing.length) return problem(request, errors, 400, "invalid_request", `Missing required query parameter: ${missing.join(", ")}.`);
    // Drain the body: writes store nothing.
    await request.arrayBuffer().catch(() => {});
    const headers: Record<string, string> = {
      "X-Request-Id": `req_${crypto.randomUUID().slice(0, 8)}`,
      "RateLimit-Policy": "10;w=60",
      ...cors(request),
    };
    if (route.status >= 300 && route.status < 400) {
      return new Response(null, { status: route.status, headers: { ...headers, Location: `${url.origin}${base}${rest}.csv` } });
    }
    if (route.status === 204 || route.body === undefined || request.method === "HEAD") return new Response(null, { status: route.status, headers });
    return new Response(route.body, { status: route.status, headers: { ...headers, "Content-Type": route.mediaType ?? "application/json" } });
  },
};
