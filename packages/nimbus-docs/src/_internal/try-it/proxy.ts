/**
 * The site's Try it proxy: a checked relay for the request the browser built.
 * It sends only to an API entry's allowed origins (the spec's servers and the
 * owner's `extraOrigins`), forwards only the request's explicit headers, never
 * follows a redirect, and streams the answer back as inert bytes. Fetch API
 * only, so it runs on every adapter. Nothing is logged.
 */
import { isLocalHost, originMatches, type TryItLimits } from "./config.js";
import {
  H_API,
  H_FAILURE,
  H_META,
  H_REQUEST,
  H_TRY,
  META_BYTES,
  headerJson,
  type ProxyFailure,
  type ProxyRequestMeta,
} from "./protocol.js";
import { isTransportHeader } from "./serialize.js";

/** One API entry's policy, from the build. */
export interface ProxyPolicy {
  /** The spec's servers' exact origins, local and private ones left out. */
  origins: string[];
  /** The owner's `extraOrigins`, wildcards included. */
  extraOrigins: string[];
  limits: TryItLimits;
}

export type ProxyTable = Record<string, ProxyPolicy>;

/** At most this many exchanges at once, per instance: it bounds buffered uploads. */
export const MAX_IN_FLIGHT = 16;
let inFlight = 0;

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Headers a request may carry once. */
const SINGLETONS = new Set(["authorization", "content-type", "cookie", "origin", "referer", "user-agent", "content-encoding"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Common headers that tell the API who is calling: a caller could dodge its per-address limits with them. */
const CALLER_ADDRESS = /^(x-real-ip|true-client-ip|forwarded|x-forwarded-.+|cf-connecting-ip.*)$/;

function refusal(status: number, failure: ProxyFailure, reason: string, retryAfterSeconds?: number): Response {
  const headers = new Headers({ ...SECURITY_HEADERS, "Content-Type": "application/json", [H_FAILURE]: failure });
  if (retryAfterSeconds !== undefined) headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify({ failure, reason, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }), { status, headers });
}

export interface ProxyOptions {
  /** Injected for tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
}

export async function handleTryIt(request: Request, table: ProxyTable, options: ProxyOptions = {}): Promise<Response> {
  // Admission, before the body is read. No CORS answers, ever: a cross-site
  // page has to preflight `Nimbus-Try`, and the preflight gets a plain 405.
  // These checks stop other sites' pages; a client outside a browser can say
  // anything, and reaches only the API's own servers.
  if (request.method !== "POST") return refusal(405, "refused", "The Try it proxy takes POST only.");
  if (request.headers.get(H_TRY) !== "1") return refusal(400, "refused", "Not a Try it request.");
  if (!fromThisSite(request)) return refusal(403, "refused", "The proxy takes requests from this site's own pages only.");
  // Own entries only: `constructor` or `__proto__` names no API.
  const api = request.headers.get(H_API) ?? "";
  const policy = Object.hasOwn(table, api) ? table[api] : undefined;
  if (!policy) return refusal(404, "refused", "Via this site: the proxy is off for this API.");

  const raw = request.headers.get(H_REQUEST) ?? "";
  if (raw.length > META_BYTES) return refusal(431, "refused", "The request's URL and headers are over the proxy's 4 KiB limit.");
  let meta: ProxyRequestMeta;
  try {
    meta = JSON.parse(raw) as ProxyRequestMeta;
  } catch {
    return refusal(400, "refused", "The request's metadata isn't valid JSON.");
  }
  const checked = checkTarget(meta, policy);
  if (typeof checked === "string") return refusal(403, "refused", checked);
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > policy.limits.uploadBytes) return tooLarge(policy);

  if (inFlight >= MAX_IN_FLIGHT) return refusal(429, "limited", "This site's proxy is busy.", 1);
  inFlight++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      inFlight--;
    }
  };

  // One deadline from here: the upload, DNS, the upstream answer and its body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), policy.limits.timeoutMs);
  const onAbort = () => controller.abort();
  // Already cancelled: nothing reaches the API, a write included.
  if (request.signal?.aborted) controller.abort();
  request.signal?.addEventListener("abort", onAbort);
  const finish = () => {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    release();
  };
  const timedOut = () => controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError";

  try {
    const body = await readUpload(request, policy.limits.uploadBytes, controller.signal);
    if (body === "overflow") {
      finish();
      return tooLarge(policy);
    }
    if (controller.signal.aborted && !timedOut()) {
      finish();
      return refusal(400, "refused", "The request was cancelled before it was sent.");
    }
    let upstream: Response;
    try {
      upstream = await (options.fetch ?? fetch)(upstreamRequest(meta, body, controller.signal), { signal: controller.signal });
    } catch {
      finish();
      if (timedOut()) return refusal(504, "timeout", `No answer from the API after ${Math.round(policy.limits.timeoutMs / 1000)} s.`);
      return refusal(502, "upstream", "This site couldn't reach the API: name resolution, TLS or the connection failed.");
    }
    const headers = new Headers({
      ...SECURITY_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      [H_META]: responseMeta(upstream),
    });
    return new Response(boundedStream(upstream, policy.limits.responseBytes + 1, controller.signal, finish), { status: 200, headers });
  } catch {
    finish();
    if (timedOut()) return refusal(504, "timeout", `The upload didn't finish within ${Math.round(policy.limits.timeoutMs / 1000)} s.`);
    return refusal(400, "refused", "The upload was cancelled.");
  }
}

/** A browser on one of this site's pages. `Sec-Fetch-Site` says so where a
 *  browser sends it; otherwise the Origin must be this site's. `request.url`
 *  isn't always the public address (a Node server without `allowedDomains`
 *  reads localhost), so the Host the browser sent counts too. */
function fromThisSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (origin === new URL(request.url).origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

function tooLarge(policy: ProxyPolicy): Response {
  return refusal(413, "refused", `The body is over this site's ${policy.limits.uploadBytes.toLocaleString("en")}-byte limit.`);
}

/** Why the target can't be sent, or the request when it can. */
export function checkTarget(meta: ProxyRequestMeta, policy: ProxyPolicy): string | true {
  if (!meta || typeof meta.method !== "string" || typeof meta.url !== "string" || !Array.isArray(meta.headers)) {
    return "The request's metadata is incomplete.";
  }
  const method = meta.method.toUpperCase();
  if (!TOKEN.test(method) || method === "TRACE" || method === "CONNECT") return `${meta.method} requests can't be sent.`;
  let url: URL;
  try {
    url = new URL(meta.url);
  } catch {
    return "The target isn't a URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The target must be http or https.";
  if (url.username || url.password) return "The target can't carry a username or password.";
  const allowed = policy.origins.includes(url.origin) || policy.extraOrigins.some((pattern) => originMatches(url.origin, pattern));
  if (!allowed && isLocalHost(url.hostname)) return `${url.origin} is a local or private address: this site's relay doesn't carry it.`;
  if (!allowed) return `${url.origin} isn't one of this API's servers.`;
  const seen = new Set<string>();
  for (const entry of meta.headers) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") return "A header is malformed.";
    const [name, value] = entry;
    const lower = name.toLowerCase();
    if (!TOKEN.test(name)) return `${name} isn't a header name.`;
    if (isTransportHeader(lower)) return `The ${name} header can't be sent.`;
    if (CALLER_ADDRESS.test(lower)) return `The ${name} header can't be sent through this site: it would name the caller.`;
    if (/[\r\n\0]/.test(value)) return `The ${name} header can't hold a line break or NUL.`;
    if (SINGLETONS.has(lower) && seen.has(lower)) return `The ${name} header appears twice.`;
    seen.add(lower);
  }
  return true;
}

/** The upload, read into memory up to the limit, before any upstream request opens. */
async function readUpload(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined | "overflow"> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort);
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return "overflow";
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (signal.aborted) throw signal.reason;
  if (size === 0) return undefined;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function upstreamRequest(meta: ProxyRequestMeta, body: Uint8Array<ArrayBuffer> | undefined, signal: AbortSignal): Request {
  // A fresh request: only the metadata's own headers, nothing from the docs request.
  const headers = new Headers();
  for (const [name, value] of meta.headers) headers.append(name, value);
  const init: RequestInit = { method: meta.method.toUpperCase(), headers, redirect: "manual", signal };
  if (body !== undefined && !["GET", "HEAD"].includes(init.method!)) init.body = body;
  try {
    return new Request(meta.url, { ...init, cache: "no-store" });
  } catch {
    // Runtimes without the `cache` option (older Workers compatibility dates).
    return new Request(meta.url, init);
  }
}

/** The upstream status and headers, `set-cookie` removed, whole entries dropped to fit 4 KiB. */
export function responseMeta(upstream: Response): string {
  const headers: [string, string][] = [];
  let truncated = false;
  const encode = () => headerJson({ status: upstream.status, headers, headersTruncated: truncated });
  for (const [name, value] of upstream.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers.push([name, value]);
    if (encode().length > META_BYTES - 32) {
      headers.pop();
      truncated = true;
    }
  }
  return encode();
}

/** The upstream body, at most `limit` bytes, then upstream cancelled and the stream ended normally. */
function boundedStream(upstream: Response, limit: number, signal: AbortSignal, done: () => void): ReadableStream<Uint8Array> | null {
  const source = upstream.body;
  if (!source) {
    done();
    return null;
  }
  const reader = source.getReader();
  let sent = 0;
  // The deadline holds even when the reader stops reading: upstream is cancelled and the slot freed.
  signal.addEventListener("abort", () => {
    void reader.cancel().catch(() => {});
    done();
  }, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          // Cancelling at the deadline ends the read too: that's a cut-off body, not a whole one.
          if (signal.aborted) controller.error(new Error("The relay's deadline passed before the response finished."));
          else controller.close();
          done();
          return;
        }
        let chunk = value;
        if (sent + chunk.byteLength >= limit) {
          chunk = chunk.subarray(0, limit - sent);
          controller.enqueue(chunk);
          controller.close();
          await reader.cancel().catch(() => {});
          done();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
        done();
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
      done();
    },
  });
}
