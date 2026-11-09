/** Try it's per-API settings, with their defaults applied. */
import type { ApiTryIt } from "../../types.js";

export interface TryItLimits {
  /** Milliseconds. */
  timeoutMs: number;
  responseBytes: number;
  uploadBytes: number;
}

export interface ResolvedTryIt {
  servers: "spec" | "editable";
  credentials: "omit" | "include";
  limits: TryItLimits;
  /** As configured: `false` turns the proxy off; otherwise it runs where on-request routes do. */
  proxy: false | { explicit: boolean; extraOrigins: string[] };
}

export const DEFAULT_LIMITS: TryItLimits = { timeoutMs: 30_000, responseBytes: 2_000_000, uploadBytes: 4_000_000 };

export function resolveTryIt(value: boolean | ApiTryIt | undefined): ResolvedTryIt | undefined {
  if (!value) return undefined;
  const config: ApiTryIt = value === true ? {} : value;
  const proxy = config.proxy;
  return {
    servers: config.servers ?? "spec",
    credentials: config.credentials ?? "omit",
    limits: {
      timeoutMs: (config.limits?.timeout ?? DEFAULT_LIMITS.timeoutMs / 1000) * 1000,
      responseBytes: config.limits?.responseBytes ?? DEFAULT_LIMITS.responseBytes,
      uploadBytes: config.limits?.uploadBytes ?? DEFAULT_LIMITS.uploadBytes,
    },
    proxy:
      proxy === false
        ? false
        : { explicit: proxy !== undefined, extraOrigins: typeof proxy === "object" ? (proxy.extraOrigins ?? []) : [] },
  };
}

/** Why an `extraOrigins` entry is invalid, or `undefined` when it's fine. */
export function originPatternProblem(pattern: string): string | undefined {
  if (pattern === "*" || /^https?:\/\/\*$/.test(pattern)) return "a bare * would make the proxy an open relay";
  const wildcard = pattern.indexOf("*");
  const probe = pattern.replace("://*.", "://wildcard.");
  if (wildcard >= 0 && (!/^https?:\/\/\*\./.test(pattern) || probe.includes("*"))) {
    return "a wildcard is allowed only as the host's first label, as in https://*.api.example.com";
  }
  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    return "it isn't a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "it must be http or https";
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return "it must be an origin only, such as https://uploads.example.com";
  }
  return undefined;
}

/** Whether `origin` (a URL's origin) matches an allowed origin or wildcard pattern. */
export function originMatches(origin: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    try {
      return new URL(pattern).origin === origin;
    } catch {
      return false;
    }
  }
  let target: URL;
  let probe: URL;
  try {
    target = new URL(origin);
    probe = new URL(pattern.replace("://*.", "://wildcard."));
  } catch {
    return false;
  }
  if (target.protocol !== probe.protocol || target.port !== probe.port) return false;
  const suffix = `.${probe.hostname.slice("wildcard.".length)}`;
  // One or more extra labels before the suffix; never the suffix itself.
  return target.hostname.endsWith(suffix) && target.hostname.length > suffix.length;
}
