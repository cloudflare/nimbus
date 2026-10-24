/** One `$ref` in a document, remembered so a later check can tell whether the
 *  document was resolved in place. */
export interface RefProbe {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  holder: Record<string, unknown>;
  ref: string;
}

export function refProbe(document: unknown): RefProbe | undefined {
  const stack: { parent: Record<string, unknown> | unknown[]; key: string | number; value: unknown }[] = [];
  const push = (parent: Record<string, unknown> | unknown[], value: unknown) => {
    if (Array.isArray(value)) value.forEach((item, index) => stack.push({ parent, key: index, value: item }));
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) stack.push({ parent: value as Record<string, unknown>, key, value: item });
  };
  push([], document);
  while (stack.length) {
    const { parent, key, value } = stack.pop()!;
    if (!value || typeof value !== "object") continue;
    const holder = value as Record<string, unknown>;
    if (!Array.isArray(holder) && typeof holder.$ref === "string") return { parent, key, holder, ref: holder.$ref };
    push(holder, value);
  }
  return undefined;
}

export function refProbeIntact(probe: RefProbe | undefined): boolean {
  if (!probe) return true;
  const current = Array.isArray(probe.parent) ? probe.parent[probe.key as number] : probe.parent[probe.key as string];
  return current === probe.holder && probe.holder.$ref === probe.ref;
}
