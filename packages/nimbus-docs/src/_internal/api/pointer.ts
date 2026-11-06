/** A JSON Pointer fragment (`#/paths/~1pets/get`), escaping each segment per
 *  RFC 6901: `~` as `~0`, then `/` as `~1`. */
export function pointer(...segments: Array<string | number>): string {
  let out = "#";
  for (const segment of segments) out += `/${escape(String(segment))}`;
  return out;
}

/** Most segments (`get`, `responses`, `200`) need no escaping: skip the work. */
function escape(segment: string): string {
  return segment.includes("~") || segment.includes("/")
    ? segment.replaceAll("~", "~0").replaceAll("/", "~1")
    : segment;
}

/** The deepest prefix of `fragment` that resolves in `doc`: a location inside
 *  a `$ref`'d object isn't in the document as written, its reference is. */
export function nearestPointer(doc: unknown, fragment: string): string {
  const segments = fragment === "#" ? [] : fragment.slice(2).split("/");
  let node: unknown = doc;
  let depth = 0;
  for (const raw of segments) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !(key in (node as object))) break;
    node = (node as Record<string, unknown>)[key];
    depth++;
  }
  return depth === 0 ? "#" : `#/${segments.slice(0, depth).join("/")}`;
}

/** `base` with more escaped segments appended. */
export function pointerAt(base: string, ...segments: Array<string | number>): string {
  return `${base}/${pointer(...segments).slice(2)}`;
}
