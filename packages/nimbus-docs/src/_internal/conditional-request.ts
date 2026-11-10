/**
 * RFC 9110 §13.1.2 for one question: does the request's `If-None-Match`
 * name the entity tag the response would carry? Weak comparison, so a
 * `W/` prefix on either side is ignored; `*` matches any, and only as the
 * whole field. Tags are read as the quoted strings they are, so a comma
 * inside one never splits it.
 */
const ENTITY_TAG = /(?:W\/)?"([^"]*)"/g;

export function ifNoneMatchMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const current = /^(?:W\/)?"([^"]*)"$/.exec(etag.trim())?.[1];
  if (current === undefined) return false;
  for (const match of header.matchAll(ENTITY_TAG)) if (match[1] === current) return true;
  return false;
}

/** `304 Not Modified` carrying `etag` when the request already holds that entity, else `null`. */
export function notModified(request: Request | undefined, etag: string): Response | null {
  if (!request || !["GET", "HEAD"].includes(request.method)) return null;
  if (!ifNoneMatchMatches(request.headers.get("If-None-Match"), etag)) return null;
  return new Response(null, { status: 304, headers: { ETag: etag } });
}
