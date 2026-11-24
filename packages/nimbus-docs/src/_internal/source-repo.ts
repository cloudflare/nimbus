/**
 * Pure rules about a source's `repo` string, shared by config validation,
 * the git runner and `check`. Nimbus never holds a credential: a `repo` that
 * carries one is refused before git runs, and git's own output has any URL
 * userinfo removed before it reaches a message.
 */

const COMMIT = /^[0-9a-f]{40}$/;

/** A 40-character commit: fetched once, cached forever. */
export function isCommitRef(ref: string): boolean {
  return COMMIT.test(ref);
}

const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
// scp-like `[user[:password]@]host:path`, no scheme.
const SCP_LIKE = /^([^/:@]+(?::[^/@]*)?)@[^/:]+:/;

/**
 * Why `repo` can't be used, or `undefined`. Refused: any userinfo in an
 * `http(s)://` URL (a token as username or password), a password in a URL of
 * any scheme, and a password in an scp-like remote. An ssh username
 * (`git@host:org/repo`, `ssh://git@host/org/repo`) is not a credential.
 */
export function repoCredentialFault(repo: string): string | undefined {
  const scheme = SCHEME_URL.exec(repo);
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase();
    const authority = scheme[2]!;
    const at = authority.lastIndexOf("@");
    if (at === -1) return undefined;
    const userinfo = authority.slice(0, at);
    if (protocol === "http" || protocol === "https") return "has a username or token in the URL";
    if (userinfo.includes(":")) return "has a password in the URL";
    return undefined;
  }
  const scp = SCP_LIKE.exec(repo);
  if (scp && scp[1]!.includes(":")) return "has a password in the URL";
  return undefined;
}

/** `repo` with any userinfo replaced by `***`, for messages. */
export function redactRepo(repo: string): string {
  const scheme = SCHEME_URL.exec(repo);
  if (scheme) {
    const authority = scheme[2]!;
    const at = authority.lastIndexOf("@");
    if (at === -1) return repo;
    return `${scheme[1]}://***@${authority.slice(at + 1)}${repo.slice(scheme[0].length)}`;
  }
  const scp = SCP_LIKE.exec(repo);
  if (scp && scp[1]!.includes(":")) return `***@${repo.slice(scp[1]!.length + 1)}`;
  return repo;
}

// A URL's scheme and `//`, raw or percent-encoded, then userinfo up to `@`
// (raw or `%40`), at any length.
const URL_USERINFO =
  /(\b[a-z][a-z0-9+.-]*(?::|%3a)(?:\/\/|%2f%2f))[^\s/@]*?(?:%40|@)(?=[^\s]*)/gi;

/**
 * Text with the userinfo of every URL-shaped string removed: defence in
 * depth over git's stderr, not the guarantee (that is refusing the
 * credential in `repo`, and git keeping its own credentials to itself).
 */
export function redactUrlUserinfo(text: string): string {
  return text.replace(URL_USERINFO, (_match, prefix: string) => `${prefix}***@`);
}

/** A `sources` entry that names a URL rather than a git repository. */
export function isUrlSource(source: unknown): source is { url: string; integrity?: string } {
  return typeof source === "object" && source !== null && typeof (source as { url?: unknown }).url === "string";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why a URL source's `url` can't be used, or `undefined`. Refused: anything
 * but `https` (`http` is allowed for `localhost`), and a user or password in
 * the URL. A query string is allowed; messages never show it.
 */
export function urlSourceFault(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a URL";
  }
  if (parsed.username || parsed.password) return "has a user or password in it";
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) return undefined;
  return parsed.protocol === "http:" ? "must use https (http is allowed only for localhost)" : "must be an https URL";
}

/** A URL for messages: origin and path, without its query string or fragment. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid URL>";
  }
}

const INTEGRITY = /^sha256-([A-Za-z0-9+/]{43}=)$/;

/** The hex SHA-256 an `integrity` value names, or `undefined` when it isn't `sha256-<base64>`. */
export function integrityHex(integrity: string): string | undefined {
  const match = INTEGRITY.exec(integrity);
  return match ? Buffer.from(match[1]!, "base64").toString("hex") : undefined;
}

/** A hex SHA-256 as an `integrity` value. */
export function hexIntegrity(hex: string): string {
  return `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
}

/** The name a URL source's file is saved under: the URL's last path segment, made safe. */
export function urlFileName(url: string): string {
  let segment = "";
  try {
    segment = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    // An undecodable or invalid path keeps the fallback.
  }
  // No leading dot, so it can't be the snapshot's marker file.
  const safe = segment.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return safe || "source";
}

/** A source or spec path: forward slashes, no leading `./` or slashes, no doubled or trailing slash. */
export function normalizeSourcePath(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** The `{ source, path }` form of `api[].spec`, as distinct from an inline document. */
export function isSpecFromSource(spec: unknown): spec is { source: string; path: string } {
  return (
    typeof spec === "object" &&
    spec !== null &&
    !Array.isArray(spec) &&
    typeof (spec as { source?: unknown }).source === "string" &&
    !("openapi" in spec) &&
    !("swagger" in spec)
  );
}
