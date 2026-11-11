/**
 * The wire protocol between the Try it client and the site's proxy route.
 * The browser sends one `POST`: the upstream request's method, URL and headers
 * in `Nimbus-Try-Request`, its body as the request body, byte for byte. The
 * route answers `200` with the upstream status and headers in
 * `Nimbus-Try-Meta` and the upstream body streamed, or a typed JSON refusal
 * marked by `Nimbus-Try-Failure`.
 */
import type { PlanId } from "./plan.js";

export const PROXY_PATH = "/_nimbus/try";
export const H_TRY = "Nimbus-Try";
export const H_API = "Nimbus-Try-Api";
export const H_REQUEST = "Nimbus-Try-Request";
export const H_META = "Nimbus-Try-Meta";
export const H_FAILURE = "Nimbus-Try-Failure";

/** Each metadata header's encoded value, at most. */
export const META_BYTES = 4096;

export interface ProxyRequestMeta {
  method: string;
  url: string;
  headers: [string, string][];
}

export interface ProxyResponseMeta {
  status: number;
  headers: [string, string][];
  headersTruncated: boolean;
}

export type ProxyFailure = "refused" | "limited" | "upstream" | "timeout";

export interface ProxyFailureBody {
  failure: ProxyFailure;
  reason: string;
  retryAfterSeconds?: number;
}

/** The API entry a request belongs to, as `Nimbus-Try-Api` names it. */
export function apiKey(id: Pick<PlanId, "family" | "version">): string {
  return id.version ? `${id.family}@${id.version}` : id.family;
}

/** JSON as a header value: ASCII only, every other character a JSON Unicode escape. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
