/**
 * `api[].extensions`: which listed `x-*` names a version never uses, and the
 * one warning that says so.
 */

import type { ApiModel } from "./api-view-types.js";
import { unwrapModel } from "./model-handle.js";

/** The listed names that no operation, parameter or field in the model declares. */
export function unusedExtensions(model: ApiModel, names: readonly string[] | undefined): string[] {
  if (!names?.length) return [];
  const used = new Set<string>();
  for (const node of unwrapModel(model).nodes.values()) {
    const values = (node.facts as { extensions?: Record<string, unknown> }).extensions;
    if (values) for (const name of Object.keys(values)) used.add(name);
  }
  return names.filter((name) => !used.has(name));
}

// Several build paths prepare the same version, and a cached version is reused
// without parsing, so the warning is deduplicated for the whole process.
const warned = new Set<string>();

/** Warn once per collection and version about listed names it never uses. */
export function warnUnusedExtensions(
  collection: string,
  version: string | null,
  unused: readonly string[],
  warn: (message: string) => void,
): void {
  if (unused.length === 0) return;
  const key = `${collection}\0${version ?? ""}\0${unused.join("\0")}`;
  if (warned.has(key)) return;
  warned.add(key);
  const where = version ? `"${collection}" version "${version}"` : `"${collection}"`;
  const list = unused.map((name) => `"${name}"`).join(", ");
  const them = unused.length === 1 ? "it" : "them";
  warn(
    `API ${where}: extensions lists ${list}, but no operation or field carries ${them}. Check the spelling, or remove ${them} from extensions.`,
  );
}
