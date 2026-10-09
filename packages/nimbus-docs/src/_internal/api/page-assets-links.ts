import type { ParsedPageAssetIndex } from "../page-assets.js";
import { pageUrl, type ResolvedApiVersion } from "./resolve-versions.js";

const prefix = "nimbus-ref:v1:";
function coordinate(token: string): { id: string; fragment: string } {
  const match = /^nimbus-ref:v1:([A-Za-z0-9_-]+)(?:#(.*))?$/.exec(token);
  if (!match) throw new Error("Malformed generated page link token.");
  const bytes = Uint8Array.from(
    atob(match[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
  const id = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!id) throw new Error("Empty generated page link identity.");
  const fragment =
    match[2] === undefined
      ? ""
      : `#${encodeURIComponent(decodeURIComponent(match[2]))}`;
  return { id, fragment };
}

/** Copy before contextualizing: cached records belong to every version/request. */
export function resolveApiAssetLinks(
  value: unknown,
  target: ResolvedApiVersion,
  index: Pick<ParsedPageAssetIndex, "byId">,
): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("nimbus-ref:")) return value;
    if (!value.startsWith(prefix))
      throw new Error("Unsupported generated page link token revision.");
    const ref = coordinate(value);
    const row = index.byId.get(ref.id);
    if (!row)
      throw new Error(`Generated link points to missing page ${ref.id}.`);
    return pageUrl(target, row.slug) + ref.fragment;
  }
  if (Array.isArray(value))
    return value.map((item) => resolveApiAssetLinks(item, target, index));
  if (!value || typeof value !== "object") return value;
  const out = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveApiAssetLinks(item, target, index),
    ]),
  );
  if (out.apiSchemaVersion === 1 && typeof out.coordinate === "string") {
    const row = index.byId.get(out.coordinate);
    if (!row) throw new Error("Prepared page is absent from its index.");
    if (target.isDefault) {
      const base = target.mountPath;
      out.markdownHref = `${base}${row.slug ? `/${row.slug}` : ""}/index.md`;
    } else delete out.markdownHref;
  }
  return out;
}
