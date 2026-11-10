/**
 * The demo's fixture API, at api.demo.nimbus-docs.com: the Sample Co weather
 * API's latest version (v2), answering every operation with its documented
 * response, so Try it can be used for real. Writes store nothing.
 *
 * - Auth: any `wx_test_` key, as a bearer token (the demo's test keys); anything
 *   else gets the spec's 401 envelope.
 * - Rate limit: 10 requests a minute per key (per IP without one), with
 *   `RateLimit-Policy: 10;w=60` on every answer and `429` with
 *   `Retry-After: 60` past it. Needs the RATE_LIMITER binding; without it
 *   (local `wrangler dev`) nothing is limited.
 * - CORS for the demo site and its previews, so direct sending works too.
 */
import data from "./routes.json";

interface Env {
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

interface Route {
  method: string;
  path: string;
  pattern: string;
  auth: boolean;
  requiredQuery: string[];
  status: number;
  mediaType?: string;
  body?: string;
}

const routes = (data.routes as Route[]).map((route) => ({ ...route, re: new RegExp(route.pattern) }));
const errors = data.errors as Record<string, { error?: Record<string, unknown> }>;

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

function problem(request: Request, status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  const envelope = errors[String(status)] ?? { error: {} };
  const type = status === 401 ? "authentication" : status === 429 ? "rate_limit" : envelope.error?.type;
  const body = { ...envelope, error: { ...envelope.error, ...(type ? { type } : {}), code, message } };
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "RateLimit-Policy": "10;w=60", ...cors(request), ...extra },
  });
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
    // Only the latest version is served; earlier ones answer 404.
    if (!url.pathname.startsWith(`${data.base}/`)) return problem(request, 404, "not_found", "This sandbox serves v2 only.");
    const rest = url.pathname.slice(data.base.length);
    const candidates = routes.filter((route) => route.re.test(rest));
    if (!candidates.length) return problem(request, 404, "not_found", `No operation at ${rest}.`);
    const route = candidates.find((candidate) => candidate.method === request.method);
    if (!route) {
      return problem(request, 405, "method_not_allowed", `${request.method} isn't allowed here.`, {
        Allow: [...new Set(candidates.map((candidate) => candidate.method))].join(", "),
      });
    }
    const key = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (route.auth) {
      if (!key) return problem(request, 401, "missing_key", "Send `Authorization: Bearer <key>` with a test key (wx_test_…).");
      if (!key.startsWith("wx_test_")) return problem(request, 401, "invalid_key", "This sandbox takes test keys only (wx_test_…).");
    }
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: key ?? request.headers.get("cf-connecting-ip") ?? "anonymous" });
      if (!success) return problem(request, 429, "rate_limited", "Over 10 requests a minute. Wait and try again.", { "Retry-After": "60" });
    }
    const missing = route.requiredQuery.filter((name) => !url.searchParams.has(name));
    if (missing.length) return problem(request, 400, "invalid_request", `Missing required query parameter: ${missing.join(", ")}.`);
    // Drain the body: writes store nothing.
    await request.arrayBuffer().catch(() => {});
    const headers: Record<string, string> = {
      "X-Request-Id": `req_${crypto.randomUUID().slice(0, 8)}`,
      "RateLimit-Policy": "10;w=60",
      ...cors(request),
    };
    if (route.status >= 300 && route.status < 400) {
      return new Response(null, { status: route.status, headers: { ...headers, Location: `${url.origin}${data.base}${rest}.csv` } });
    }
    if (route.status === 204 || route.body === undefined || request.method === "HEAD") return new Response(null, { status: route.status, headers });
    return new Response(route.body, { status: route.status, headers: { ...headers, "Content-Type": route.mediaType ?? "application/json" } });
  },
};
