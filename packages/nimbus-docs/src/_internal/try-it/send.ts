/**
 * `sendRequest(plan, values, options)`: one try, straight from the browser or
 * through the site's proxy. Never rejects: every outcome is a response (any
 * status, redirects included) or a typed failure, with whatever partial output
 * arrived. No retries, no switching delivery mode, redirects never followed.
 */
import type { DeliveryMode, HttpBody, HttpRequest, RequestPlan, RequestValues } from "./plan.js";
import { serializeRequest } from "./serialize.js";
import { maskText } from "./render.js";
import {
  H_API,
  H_FAILURE,
  H_META,
  H_REQUEST,
  H_TRY,
  META_BYTES,
  PROXY_PATH,
  apiKey,
  headerJson,
  type ProxyFailureBody,
  type ProxyResponseMeta,
} from "./protocol.js";

export type SendFailure = "network" | "timeout" | "refused" | "upstream" | "limited" | "stopped";

export type SendOutcome =
  | {
      ok: true;
      via: DeliveryMode;
      status: number;
      headers: [string, string][];
      headersTruncated: boolean;
      body: Uint8Array;
      text?: string;
      truncated: boolean;
      durationMs: number;
      /** Masked; absent when the browser hides a direct redirect. */
      finalUrl?: string;
      redirect?: { location?: string };
    }
  | {
      ok: false;
      via: DeliveryMode;
      failure: SendFailure;
      reason: string;
      retryAfterSeconds?: number;
      partial?: { status?: number; headers?: [string, string][]; body: Uint8Array; durationMs: number };
    };

export interface SendOptions {
  delivery: DeliveryMode;
  signal?: AbortSignal;
  onChunk?: (bytes: Uint8Array, text?: string) => void;
  /** The proxy route, with the site's base: `/docs/_nimbus/try`. */
  proxyUrl?: string;
  /** The docs origin, for relative servers. */
  origin?: string;
}

export const NETWORK_REASON = "The request didn't complete: a network error or the API's browser policy (CORS). It may have reached the API.";

export async function sendRequest(plan: RequestPlan, values: RequestValues, options: SendOptions): Promise<SendOutcome> {
  const via = options.delivery;
  const serialized = serializeRequest(plan, values, options.origin ? { origin: options.origin } : {});
  if ("refused" in serialized) return { ok: false, via, failure: "refused", reason: serialized.refused };
  return send(plan, serialized, options);
}

/** Send an already-serialised request. */
export async function send(plan: RequestPlan, request: HttpRequest, options: SendOptions): Promise<SendOutcome> {
  const via = options.delivery;
  const fail = (failure: SendFailure, reason: string, extra: Partial<Extract<SendOutcome, { ok: false }>> = {}): SendOutcome =>
    ({ ok: false, via, failure, reason, ...extra });
  if (via === "direct" && request.headers.some(([name]) => name.toLowerCase() === "cookie")) {
    return fail("refused", "Direct: cookie parameters can't be sent from a browser. Send it via this site.");
  }
  // Over the limit before encoding (files are known by size): refused without reading them.
  const floor = bodyFloor(request.body);
  if (floor > plan.send.uploadBytes) {
    return fail("refused", `The body is at least ${floor.toLocaleString("en")} bytes, over this site's ${plan.send.uploadBytes.toLocaleString("en")}-byte limit.`);
  }
  let payload: { body?: BodyInit; contentType?: string; size: number };
  try {
    payload = await encodeBody(request.body);
  } catch {
    return fail("refused", "The body couldn't be read.");
  }
  if (payload.size > plan.send.uploadBytes) {
    return fail("refused", `The body is ${payload.size.toLocaleString("en")} bytes, over this site's ${plan.send.uploadBytes.toLocaleString("en")}-byte limit.`);
  }
  const headers = payload.contentType ? [...request.headers, ["Content-Type", payload.contentType] as [string, string]] : request.headers;

  // One deadline for the whole exchange, body included.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, plan.send.timeoutMs);
  const onStop = () => controller.abort();
  options.signal?.addEventListener("abort", onStop);
  if (options.signal?.aborted) controller.abort();
  const started = now();
  const elapsed = () => Math.round(now() - started);
  const stoppedOrTimedOut = (partial: Extract<SendOutcome, { ok: false }>["partial"]): SendOutcome =>
    timedOut
      ? fail("timeout", `No complete answer after ${Math.round(plan.send.timeoutMs / 1000)} s.`, partial ? { partial } : {})
      : fail("stopped", stoppedReason(partial), partial ? { partial } : {});

  try {
    let response: Response;
    try {
      response = via === "direct"
        ? await fetch(request.url, {
            method: request.method,
            headers: headers,
            ...(payload.body !== undefined ? { body: payload.body } : {}),
            credentials: plan.send.credentials,
            cache: "no-store",
            referrerPolicy: "no-referrer",
            redirect: "manual",
            signal: controller.signal,
          })
        : await fetch(options.proxyUrl ?? PROXY_PATH, {
            method: "POST",
            headers: proxyHeaders(plan, request, headers),
            ...(payload.body !== undefined ? { body: payload.body } : {}),
            credentials: "same-origin",
            cache: "no-store",
            redirect: "manual",
            signal: controller.signal,
          });
    } catch (error) {
      if (controller.signal.aborted) return stoppedOrTimedOut(undefined);
      if (error instanceof ProxyRequestTooLarge) return fail("refused", error.message);
      return fail("network", via === "direct" ? NETWORK_REASON : "The connection to this site failed. The request may have reached the API.");
    }

    let status = response.status;
    let responseHeaders: [string, string][] = [...response.headers];
    let headersTruncated = false;
    const finalUrl = maskText(request.url, request.secrets);
    if (via === "proxy") {
      const meta = response.headers.get(H_META);
      if (!meta) return await proxyFailure(response, fail);
      let parsed: ProxyResponseMeta;
      try {
        parsed = JSON.parse(meta) as ProxyResponseMeta;
      } catch {
        return fail("network", "This site's proxy sent a response it couldn't read: a deployment error.");
      }
      status = parsed.status;
      responseHeaders = parsed.headers;
      headersTruncated = parsed.headersTruncated;
    } else if (response.type === "opaqueredirect") {
      return {
        ok: true, via, status: 0, headers: [], headersTruncated: false, body: new Uint8Array(), truncated: false,
        durationMs: elapsed(), redirect: {},
      };
    }

    const mediaType = headerValue(responseHeaders, "content-type") ?? "";
    const text = isTextMedia(mediaType);
    const read = await readBody(response, plan.send.responseBytes, text, options.onChunk);
    const partial = { status, headers: responseHeaders, body: read.bytes, durationMs: elapsed() };
    if (read.error) {
      if (controller.signal.aborted) return stoppedOrTimedOut(partial);
      return via === "proxy"
        ? fail("upstream", "The connection to the API or to this site ended mid-response.", { partial })
        : fail("network", "The connection to the API ended mid-response.", { partial });
    }
    const outcome: SendOutcome = {
      ok: true, via, status, headers: responseHeaders, headersTruncated, body: read.bytes, truncated: read.truncated,
      durationMs: elapsed(), finalUrl,
    };
    if (text) outcome.text = read.text;
    if (status >= 300 && status < 400) {
      const location = headerValue(responseHeaders, "location");
      outcome.redirect = location !== undefined ? { location } : {};
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onStop);
  }
}

function stoppedReason(partial: { body: Uint8Array; durationMs: number } | undefined): string {
  const bytes = partial?.body.byteLength ?? 0;
  const seconds = ((partial?.durationMs ?? 0) / 1000).toFixed(1);
  return `Stopped after ${bytes.toLocaleString("en")} bytes, ${seconds} s.`;
}

class ProxyRequestTooLarge extends Error {}

function proxyHeaders(plan: RequestPlan, request: HttpRequest, headers: [string, string][]): Headers {
  const meta = headerJson({ method: request.method, url: request.url, headers });
  if (meta.length > META_BYTES) {
    throw new ProxyRequestTooLarge("The request's URL and headers are over this site's 4 KiB limit for the proxy.");
  }
  return new Headers({
    [H_TRY]: "1",
    [H_API]: apiKey(plan.id),
    [H_REQUEST]: meta,
    "Content-Type": "application/octet-stream",
  });
}

async function proxyFailure(
  response: Response,
  fail: (failure: SendFailure, reason: string, extra?: Partial<Extract<SendOutcome, { ok: false }>>) => SendOutcome,
): Promise<SendOutcome> {
  if (!response.headers.get(H_FAILURE)) {
    return fail("network", `This site answered ${response.status} instead of the proxy: a deployment error, not the API's response.`);
  }
  try {
    const body = (await response.json()) as ProxyFailureBody;
    const failure: SendFailure = body.failure === "timeout" ? "timeout" : body.failure;
    return fail(failure, body.reason, body.retryAfterSeconds !== undefined ? { retryAfterSeconds: body.retryAfterSeconds } : {});
  } catch {
    return fail("network", "This site's proxy sent a refusal it couldn't read.");
  }
}

// The fewest bytes a body can encode to: its files and texts, without the framing.
function bodyFloor(body: HttpBody | undefined): number {
  if (!body) return 0;
  const bytes = (value: string | Blob) => (typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.size);
  switch (body.kind) {
    case "multipart":
      return body.parts.reduce((total, part) => total + bytes(part.value), 0);
    case "bytes":
      return body.file.size;
    default:
      return 0;
  }
}

async function encodeBody(body: HttpBody | undefined): Promise<{ body?: BodyInit; contentType?: string; size: number }> {
  if (!body) return { size: 0 };
  switch (body.kind) {
    case "json":
    case "text": {
      const bytes = new TextEncoder().encode(body.text);
      return { body: bytes, size: bytes.byteLength };
    }
    case "bytes":
      return { body: body.file, size: body.file.size };
    case "form": {
      const text = new URLSearchParams(body.fields.map(({ name, value }) => [name, value] as [string, string])).toString();
      return { body: text, size: new TextEncoder().encode(text).byteLength };
    }
    case "multipart": {
      // The browser writes the boundary; the bytes are read once so both
      // delivery modes send, and the limit counts, the same body.
      const form = new FormData();
      for (const part of body.parts) {
        const value = typeof part.value === "string"
          ? part.contentType ? new Blob([part.value], { type: part.contentType }) : part.value
          : part.contentType && part.value.type !== part.contentType ? new Blob([part.value], { type: part.contentType }) : part.value;
        if (typeof value === "string") form.append(part.name, value);
        else form.append(part.name, value, part.filename ?? (typeof part.value === "string" ? "" : fileName(part.value) ?? "blob"));
      }
      const encoded = new Request("http://nimbus.invalid/", { method: "POST", body: form });
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      return { body: bytes, contentType: encoded.headers.get("content-type") ?? "multipart/form-data", size: bytes.byteLength };
    }
  }
}

function fileName(file: Blob): string | undefined {
  const name = (file as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

const TEXT_MEDIA = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|x-ndjson|ndjson|problem\+json|graphql)\b)|[+/](json|xml)\b/i;

export function isTextMedia(mediaType: string): boolean {
  return TEXT_MEDIA.test(mediaType.split(";")[0]!.trim());
}

function headerValue(headers: [string, string][], name: string): string | undefined {
  return headers.find(([n]) => n.toLowerCase() === name)?.[1];
}

async function readBody(
  response: Response,
  limit: number,
  text: boolean,
  onChunk: SendOptions["onChunk"],
): Promise<{ bytes: Uint8Array; text: string; truncated: boolean; error: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let error = false;
  let decoded = "";
  const decoder = text ? new TextDecoder() : undefined;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = value;
        if (size + chunk.byteLength > limit) {
          chunk = chunk.subarray(0, limit - size);
          truncated = true;
        }
        size += chunk.byteLength;
        if (chunk.byteLength > 0) {
          chunks.push(chunk);
          if (decoder) decoded += decoder.decode(chunk, { stream: true });
          onChunk?.(chunk, decoder ? decoded : undefined);
        }
        if (truncated) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch {
      error = true;
    }
  }
  if (decoder) decoded += decoder.decode();
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, text: decoded, truncated, error };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
