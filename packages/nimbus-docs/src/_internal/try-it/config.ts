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
  testKey?: string;
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
    ...(config.testKey ? { testKey: config.testKey } : {}),
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

/**
 * Whether a URL's hostname (as `new URL()` normalises it) names a local or
 * private address: loopback, private, link-local, CGNAT and other non-public
 * IPv4 and IPv6 ranges (embedded IPv4 included), single-label names and the
 * special-use suffixes only a local network resolves. No DNS: a public name
 * that resolves to a private address isn't caught.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) return localIpv6(host.slice(1, -1));
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return localIpv4(v4.slice(1).map(Number) as [number, number, number, number]);
  if (!host.includes(".")) return true; // localhost, or a docker or cluster service name
  return /(^|\.)home\.arpa$/.test(host) || /\.(localhost|local|internal|lan|home|corp)$/.test(host);
}

function localIpv4([a, b, c]: [number, number, number, number]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata included
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function localIpv6(text: string): boolean {
  const groups = ipv6Groups(text);
  if (!groups) return true; // not one `new URL()` would print: refuse rather than guess
  const v4 = (hi: number, lo: number) => localIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0) return g6 === 0 || v4(g6, g7); // ::, ::1, and IPv4-compatible
    if (g5 === 0xffff) return v4(g6, g7); // IPv4-mapped
  }
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64
  if (g0 === 0x2002) return v4(g1, g2); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

function ipv6Groups(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}
