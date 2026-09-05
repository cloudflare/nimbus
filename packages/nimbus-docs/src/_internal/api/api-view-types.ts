/**
 * The frozen view-model contract — the seam between the spine IR and the user's
 * copied `registry:ui` slugs. `apiSchemaVersion` is 1; every change is additive.
 * The projection that produces these shapes lives in `view-model.ts`.
 */

import type { RoutePolicy } from "./route-policy.js";

export const apiSchemaVersion = 1;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ApiNodeKind = "api" | "section" | "operation" | "schema";

/** How an operation page's `resource-action-v1` slug was resolved: a config `override`, a
 *  method+path `derived` slug, or a `fallback` to the operation coordinate. This
 *  is the view-surface home of the union; the spine's `RouteProvenance` aliases
 *  it so the type never originates in the IR when it crosses the `./api` seam. */
export type ApiRouteProvenance = "override" | "derived" | "fallback";

export interface SpecSource {
  collection: string;
  spec: string | Record<string, JsonValue>;
  label?: string;
  /** Base URL for this model's pages. Defaults to `/<collection>` when absent. */
  mountPath?: string;
  /** Fail the build on an operation missing a usable `operationId`. Default false. */
  requireOperationId?: boolean;
  /** Route convention for this model's pages. Absent = legacy operationId URLs. */
  routes?: RoutePolicy;
}

declare const ApiModelBrand: unique symbol;
export interface ApiModel {
  readonly [ApiModelBrand]: true;
}

export interface ApiRef {
  label: string;
  href: string;
  anchor?: string;
}

export interface ApiConstraint {
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface ApiTypeShape {
  kind: "array" | "map";
  inner: string;
}

export interface ApiFieldView {
  coordinate: string;
  name: string;
  type: string;
  typeShape?: ApiTypeShape;
  typeRef?: ApiRef;
  typeRefs?: ApiRef[];
  required: boolean;
  deprecated?: boolean;
  nullable?: boolean;
  constraints?: ApiConstraint;
  default?: JsonValue;
  enum?: JsonValue[];
  example?: JsonValue;
  description?: string;
  descriptionHtml?: string;
  anchor: string;
  children: ApiFieldView[];
  childCount: number;
  truncated: boolean;
  link?: ApiRef;
  /** The field's union shape, when it is a `oneOf`/`anyOf` (or an array of one). */
  union?: ApiUnionView;
}

export interface ApiBreadcrumb {
  label: string;
  href: string;
}

export interface ApiPageBase {
  apiSchemaVersion: number;
  collection: string;
  coordinate: string;
  href: string;
  markdownHref: string;
  tokenCount?: number;
  title: string;
  description?: string;
  descriptionHtml?: string;
  deprecated?: boolean;
  deprecation?: { successor?: ApiRef; migrationHref?: string };
  breadcrumbs: ApiBreadcrumb[];
}

export interface ApiParamGroup {
  location: "path" | "query" | "header" | "cookie";
  label: string;
  anchor: string;
  fields: ApiFieldView[];
  /** Set only when the field list hit `FIELD_INLINE_CEILING`; `total` is the
   *  true count so a renderer can note how many were omitted. Never fires on the
   *  measured corpus — a safety net for a pathological spec. */
  truncated?: { total: number };
}

export interface ApiAuthView {
  scheme: string;
  type?: string;
  in?: "header" | "query" | "cookie";
  headerName?: string;
  bearerFormat?: string;
  scopes: string[];
}

export interface ApiResponseView {
  coordinate: string;
  status: string;
  statusClass?: "info" | "success" | "redirect" | "client-error" | "server-error";
  description?: string;
  descriptionHtml?: string;
  anchor: string;
  headers?: ApiFieldView[];
  fields: ApiFieldView[];
  /** Set only when `fields` hit `FIELD_INLINE_CEILING` (see `ApiParamGroup`). */
  truncated?: { total: number };
  /** The response body's union shape, when it is a top-level `oneOf`/`anyOf`. */
  bodyUnion?: ApiUnionView;
  /** Derived example response body for this status. Symmetric with the request
   *  `ApiOperationPage.example`; present when the engine could resolve one. */
  example?: ApiExampleView;
}

export interface ApiOperationPage extends ApiPageBase {
  kind: "operation";
  method: string;
  path: string;
  /** Effective server base URL (trailing slash trimmed), so the header can show
   *  the full request URL. Absent when the spec declares no servers. */
  server?: string;
  isWebhook?: boolean;
  auth: ApiAuthView[][];
  parameters: ApiParamGroup[];
  body: ApiFieldView[];
  /** Set only when `body` hit `FIELD_INLINE_CEILING` (see `ApiParamGroup`). */
  bodyTruncated?: { total: number };
  /** The body's union shape, when the request body is a top-level `oneOf`/`anyOf`. */
  bodyUnion?: ApiUnionView;
  /** The primary request body's media type, so the renderer labels it correctly
   *  instead of assuming JSON. Present when the operation has a request body. */
  bodyMediaType?: string;
  /** Request bodies for media types BEYOND the primary (e.g. a `multipart/form-data`
   *  variant beside JSON). Each renders its own field list/example; the fields are
   *  fully citable under their own coordinates. Absent for a single-media body. */
  additionalBodies?: ApiRequestBodyView[];
  responses: ApiResponseView[];
  /** Derived minimal request body, for the request example display. */
  example?: ApiExampleView;
  /** Per-language request samples; `x-codeSamples` from the spec win. */
  samples: ApiCodeSampleView[];
}

export interface ApiExampleView {
  mediaType: string;
  value: JsonValue;
  highlightedHtml?: string;
}

export interface ApiRequestBodyView {
  mediaType: string;
  anchor: string;
  fields: ApiFieldView[];
  /** Set only when `fields` hit `FIELD_INLINE_CEILING` (see `ApiParamGroup`). */
  truncated?: { total: number };
  /** The body's union shape, when this media type is a top-level `oneOf`/`anyOf`. */
  union?: ApiUnionView;
  /** Derived example for this media type, when the engine could resolve one. */
  example?: ApiExampleView;
}

export interface ApiCodeSampleView {
  lang: string;
  label: string;
  source: string;
  highlightedHtml?: string;
}

export interface ApiScalarView {
  type: string;
  enum?: JsonValue[];
  constraints?: ApiConstraint;
  default?: JsonValue;
  example?: JsonValue;
  nullable?: boolean;
}

export interface ApiSchemaPage extends ApiPageBase {
  kind: "schema";
  fields: ApiFieldView[];
  /** Set only when `fields` hit `FIELD_INLINE_CEILING` (see `ApiParamGroup`). */
  truncated?: { total: number };
  /** The schema's own leaf shape when it is a scalar/enum/array (no fields). */
  scalar?: ApiScalarView;
  /** The schema's union shape when it is a top-level `oneOf`/`anyOf`. */
  union?: ApiUnionView;
}

/** One branch of a union. `href` is present only when the branch resolves to a
 *  named component schema page; an anonymous inline branch has a label only. */
export interface ApiVariant {
  label: string;
  href?: string;
  /**
   * The variant's own properties, inlined so a field union renders an in-place
   * explorer instead of only a link. Present only for field unions (one level
   * deep) when the branch resolves to a named schema; schema-page unions and
   * nested variant unions link out instead.
   */
  fields?: ApiFieldView[];
}

export interface ApiUnionView {
  kind: "oneOf" | "anyOf";
  variants: ApiVariant[];
  discriminator?: string;
  mapping?: ApiDiscriminatorEntry[];
}

export interface ApiDiscriminatorEntry {
  value: string;
  variant: ApiVariant;
}

export interface ApiSectionPage extends ApiPageBase {
  kind: "section";
  operations: ApiRef[];
}

export interface ApiRootPage extends ApiPageBase {
  kind: "api";
  version?: string;
  servers: string[];
  sections: ApiRef[];
}

export type ApiPageProps =
  | ApiOperationPage
  | ApiSchemaPage
  | ApiSectionPage
  | ApiRootPage;

export interface ApiNavItem {
  coordinate: string;
  label: string;
  kind: ApiNodeKind;
  /** Absent for nav-only grouping nodes — an `x-tagGroups` category has no page
   *  of its own, so its row is a disclosure header, not a link. */
  href?: string;
  method?: string;
  deprecated?: boolean;
  active?: boolean;
  expanded?: boolean;
  children: ApiNavItem[];
}

export interface ApiNav {
  apiSchemaVersion: number;
  collection: string;
  items: ApiNavItem[];
}

export interface ApiPageIndexEntry {
  coordinate: string;
  slug: string;
  title: string;
  description?: string;
}
