/**
 * Which request and response bodies a request-rendered operation page defers
 * to a server island, and what it shows until the island arrives.
 */
import type {
  ApiFieldView,
  ApiPageProps,
  ApiUnionView,
  ApiVariant,
} from "./api-view-types.js";

/** One body on an operation page: no `status` is the request body, no
 * `mediaType` the primary media type. */
export interface ApiSchemaRef {
  status?: string;
  mediaType?: string;
}

/** What a field list renders for one body. */
export interface ApiSchemaView {
  fields: ApiFieldView[];
  truncated?: { total: number };
  union?: ApiUnionView;
  descriptionHtml?: string;
}

/**
 * Bodies with more field rows than this defer their nested rows. Rows cost
 * 1–2 KB of HTML each. On Cloudflare's spec, 8% of operation pages pass it,
 * including the largest, and none has more than three such bodies. At the
 * 90th percentile, a body has 27 rows on Cloudflare, 23 on GitHub and 13 on
 * OpenAI.
 */
export const DEFERRED_FIELD_ROWS = 50;

export function apiSchemaView(
  page: ApiPageProps,
  ref: ApiSchemaRef,
): ApiSchemaView | undefined {
  if (page.kind !== "operation") return undefined;
  if (ref.status === undefined) {
    if (ref.mediaType === undefined)
      return {
        fields: page.body,
        truncated: page.bodyTruncated,
        union: page.bodyUnion,
        descriptionHtml: page.bodyDescriptionHtml,
      };
    const body = page.additionalBodies?.find(
      (body) => body.mediaType === ref.mediaType,
    );
    return (
      body && {
        fields: body.fields,
        truncated: body.truncated,
        union: body.union,
      }
    );
  }
  const response = page.responses.find((r) => r.status === ref.status);
  if (!response) return undefined;
  if (ref.mediaType === undefined)
    return {
      fields: response.fields,
      truncated: response.truncated,
      union: response.bodyUnion,
    };
  const media = response.additionalMedia?.find(
    (media) => media.mediaType === ref.mediaType,
  );
  return (
    media && {
      fields: media.fields,
      truncated: media.truncated,
      union: media.union,
    }
  );
}

// The variants a union explorer renders: its discriminator mapping, if any.
function unionRows(union: ApiUnionView): number {
  const variants = union.mapping?.length
    ? union.mapping.map((entry) => entry.variant)
    : union.variants;
  return variants.reduce(
    (rows, variant) => rows + fieldRows(variant.fields ?? []),
    0,
  );
}
function fieldRows(fields: ApiFieldView[]): number {
  return fields.reduce(
    (rows, field) =>
      rows +
      1 +
      fieldRows(field.children) +
      (field.union ? unionRows(field.union) : 0),
    0,
  );
}

export function deferSchema(view: ApiSchemaView): boolean {
  return (
    fieldRows(view.fields) + (view.union ? unionRows(view.union) : 0) >
    DEFERRED_FIELD_ROWS
  );
}

const labelOnly = ({ fields: _fields, ...variant }: ApiVariant): ApiVariant =>
  variant;
function shallowUnion(union: ApiUnionView): ApiUnionView {
  return {
    ...union,
    variants: union.variants.map(labelOnly),
    ...(union.mapping
      ? {
          mapping: union.mapping.map((entry) => ({
            ...entry,
            variant: labelOnly(entry.variant),
          })),
        }
      : {}),
  };
}

/** The top-level rows only. A nested list becomes the field list's own
 * "more fields omitted" row; a union keeps its variant names. */
export function shallowSchema(view: ApiSchemaView): ApiSchemaView {
  return {
    ...view,
    fields: view.fields.map((field) => ({
      ...field,
      children: [],
      truncated: field.truncated || field.children.length > 0,
      ...(field.union ? { union: shallowUnion(field.union) } : {}),
    })),
    ...(view.union ? { union: shallowUnion(view.union) } : {}),
  };
}
