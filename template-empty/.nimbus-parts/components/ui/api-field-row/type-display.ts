/**
 * Type-display helpers for the API field explorer — pure projection of an
 * `ApiFieldView` into the coloured type preview (keyword vs literal vs link),
 * the collapsed-object marker, and the constraint pairs. Kept out of the
 * `.astro` files so the formatting has one home and can be unit-tested without
 * a render. Palette is deliberately restrained: muted for everything except a
 * schema link (`text-info`); no syntax colours.
 */
import type { ApiConstraint, ApiFieldView, ApiUnionView, ApiVariant } from "@cloudflare/nimbus-docs/api";

export interface TypeToken {
  text: string;
  /** Tailwind classes — semantic tokens so light/dark track automatically. */
  cls: string;
  href?: string;
  /** Monospace token — `$ref` names and literals render in mono; the property
   *  name, `optional`, punctuation, and primitives in sans. */
  mono?: boolean;
  /** Native tooltip — carries the full enum list behind a `+N more` token. */
  title?: string;
}

/** Blue link — a type that resolves to a schema page (rendered in mono). */
export const LINK_CLS = "text-info font-medium hover:underline underline-offset-2";
const MUTED_CLS = "text-muted-foreground";

/** How many enum literals fit inline. Past it, the type line counts them and
 *  `allowedValues` lists them all on a line of their own. */
const ENUM_CAP = 6;

// Enum literals render bare (not JSON-quoted) — cleaner in a docs reading
// context, and the muted mono already marks them as values.
const display = (v: unknown): string => (typeof v === "string" ? v : String(v));

/** An enum's values as type tokens: inline up to `ENUM_CAP`, else `type · one
 *  of N values`, with the list itself on the row's "Allowed values" line. */
export function literalTokens(values: readonly unknown[], type?: string): TypeToken[] {
  if (values.length > ENUM_CAP) {
    return [
      ...(type ? [{ text: type, cls: MUTED_CLS }, { text: "·", cls: MUTED_CLS }] : []),
      { text: `one of ${values.length} values`, cls: MUTED_CLS },
    ];
  }
  const out: TypeToken[] = [];
  values.forEach((v, i) => {
    if (i > 0) out.push({ text: "or", cls: MUTED_CLS });
    out.push({ text: display(v), cls: MUTED_CLS, mono: true });
  });
  return out;
}

/** Every value of an enum too long for the type line, for its "Allowed values"
 *  line: in the page text, so keyboard, touch and screen readers reach it. */
export function allowedValues(values: readonly unknown[] | undefined): string | undefined {
  return values && values.length > ENUM_CAP ? values.map(display).join(", ") : undefined;
}

/** A union's branches in display order: with a discriminator mapping, the
 *  mapped branches with their values, then the branches no value selects. */
export function unionEntries(union: ApiUnionView): Array<{ variant: ApiVariant; value?: string }> {
  if (!union.mapping || union.mapping.length === 0) return union.variants.map((variant) => ({ variant }));
  const mapped = new Set(union.mapping.map((m) => m.variant.name));
  return [
    ...union.mapping.map((m) => ({ variant: m.variant, value: m.value })),
    ...union.variants.filter((v) => !v.name || !mapped.has(v.name)).map((variant) => ({ variant })),
  ];
}

/** Variant names joined for the name tooltip on a union field. None when every
 *  branch is unnamed, untitled and labelled alike: `object or object` says nothing. */
export function unionTitle(union: ApiUnionView): string | undefined {
  const variants = unionEntries(union).map((e) => e.variant);
  const labels = variants.map((v) => v.title ?? v.label);
  const anonymous = variants.every((v) => !v.name && !v.title);
  if (anonymous && new Set(labels).size <= 1) return undefined;
  return labels.join(" or ");
}

/** A named schema's name as a token: a link when it has a page. */
function nameToken(text: string, field: ApiFieldView): TypeToken {
  return field.typeRef
    ? { text, cls: LINK_CLS, href: field.typeRef.href, mono: true }
    : { text, cls: MUTED_CLS, mono: true };
}

/** The coloured type preview for a field, as a token stream. Separators carry
 *  no baked whitespace — the renderer's `gap` supplies the spacing. */
export function typeTokens(field: ApiFieldView): TypeToken[] {
  const shape = field.typeShape;

  if (shape?.kind === "map") {
    return [
      { text: "map of", cls: MUTED_CLS },
      field.typeRef
        ? { text: shape.inner, cls: LINK_CLS, href: field.typeRef.href, mono: true }
        : { text: shape.inner || "any", cls: MUTED_CLS },
    ];
  }

  const prefix: TypeToken[] =
    shape?.kind === "array" && !field.namedArray ? [{ text: "array of", cls: MUTED_CLS }] : [];
  // A named array schema reads as its name, then says it's an array.
  const suffix: TypeToken[] = field.namedArray ? [{ text: "(array)", cls: MUTED_CLS }] : [];

  // A union shows only its schema's name, when it has one: the { n variants }
  // toggle gives the count and the open list names each variant.
  if (field.union) return field.typeName ? [...prefix, nameToken(field.typeName, field), ...suffix] : prefix;

  // Where the list stops at a repeat, the schema's name stands in for `object`.
  if (field.typeName) {
    return [...prefix, nameToken(field.typeName, field), ...suffix];
  }

  if (shape?.kind === "array") {
    if (field.enum && field.enum.length > 0) return [...prefix, ...literalTokens(field.enum, shape.inner)];
    if (field.typeRef)
      return [...prefix, { text: shape.inner, cls: LINK_CLS, href: field.typeRef.href, mono: true }];
    return [...prefix, { text: shape.inner || "any", cls: MUTED_CLS }];
  }

  if (field.enum && field.enum.length > 0) return literalTokens(field.enum, field.type);
  if (field.typeRef) return [{ text: field.type, cls: LINK_CLS, href: field.typeRef.href, mono: true }];
  if (field.typeRefs && field.typeRefs.length > 0) {
    return field.typeRefs.flatMap((r, i) => [
      ...(i > 0 ? [{ text: "or", cls: MUTED_CLS }] : []),
      { text: r.label, cls: LINK_CLS, href: r.href, mono: true },
    ]);
  }

  return [{ text: field.type, cls: MUTED_CLS }];
}

export interface ConstraintPair {
  name: string;
  value: string;
}

/** Constraints as `name: value` pairs with the value in mono, e.g.
 *  `format: int64`, `maxLength: 255`. */
export function constraintPairs(c: ApiConstraint | undefined): ConstraintPair[] {
  if (!c) return [];
  const out: ConstraintPair[] = [];
  if (c.format) out.push({ name: "format", value: c.format });
  if (c.maximum !== undefined) out.push({ name: "maximum", value: String(c.maximum) });
  if (c.minimum !== undefined) out.push({ name: "minimum", value: String(c.minimum) });
  if (c.maxLength !== undefined) out.push({ name: "maxLength", value: String(c.maxLength) });
  if (c.minLength !== undefined) out.push({ name: "minLength", value: String(c.minLength) });
  if (c.pattern) out.push({ name: "pattern", value: c.pattern });
  return out;
}

/** A field opens an expander when it nests object children or union variants. */
export function isExpandable(field: ApiFieldView): boolean {
  return Boolean(field.union) || field.children.length > 0 || field.truncated;
}

/** The "4 properties" toggle text for an expandable field or union variant. */
export function countLabel(n: number, noun: "property" | "variant"): string {
  const plural = noun === "property" ? "properties" : "variants";
  return `${n} ${n === 1 ? noun : plural}`;
}

/** The toggle text for what a field or union option opens to: its properties,
 *  its union's options, or both (`5 properties · 23 variants`). */
export function contentsLabel(properties: number, union: ApiUnionView | undefined): string {
  const parts: string[] = [];
  if (properties > 0 || !union) parts.push(countLabel(properties, "property"));
  if (union) parts.push(countLabel(union.variants.length, "variant"));
  return parts.join(" · ");
}
