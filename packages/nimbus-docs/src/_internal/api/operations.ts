import {
  apiCoordinate,
  bodyFieldCoordinate,
  bodyMediaCoordinate,
  bodyMediaFieldCoordinate,
  fallbackOperationCoordinate,
  isShadowingBodyProperty,
  mediaTypeToken,
  operationCoordinate,
  parameterCoordinate,
  RESERVED_ROUTE_SEGMENTS,
  responseCoordinate,
  responseFieldCoordinate,
  routeIdentityFault,
  sectionCoordinate,
  tagRouteSegment,
} from "./coordinates.js";
import { resolveOperationRoute, routeSlugFault } from "./route-policy.js";
import {
  HTTP_METHODS,
  SCHEMA_FIELD_DEPTH,
  type HttpMethod,
  type OpenApiMediaType,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiSchema,
} from "./openapi-types.js";
import type {
  Coordinate,
  OperationFacts,
  ParameterFacts,
  ParameterLocation,
  RequestBodyFacts,
  ResponseFacts,
} from "./model.js";
import { dedupeParameters, mediaExample, picksNonPrimaryMedia, resolveAuth } from "./facts.js";
import {
  buildOperationSamples,
  resolveExampleValue,
  resolveNamedExampleValues,
} from "./samples.js";
import { addField, walkFields } from "./field-walk.js";
import {
  asString,
  constraintsOf,
  isPlainObject,
  itemsOf,
  orderedMediaEntries,
  primaryMediaEntry,
  typeLabel,
} from "./schema-algebra.js";
import type { ParseContext } from "./parse-context.js";

export function parseOperations(ctx: ParseContext): void {
  for (const [path, item] of Object.entries(ctx.doc.paths ?? {})) {
    if (item === null || typeof item !== "object") continue;
    const sharedParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      addOperation(ctx, method, path, op, sharedParams);
    }
  }
}

function addOperation(
  ctx: ParseContext,
  method: HttpMethod,
  path: string,
  op: OpenApiOperation,
  sharedParams: OpenApiParameter[],
): void {
  let opCoord: Coordinate;
  const sourceBase = `#/paths/${path}/${method}`;
  const operationId =
    typeof op.operationId === "string" && op.operationId ? op.operationId : undefined;
  if (operationId !== undefined) {
    opCoord = operationCoordinate(operationId);
    // Under a route policy the operationId is an opaque coordinate that no
    // longer routes, so it faces only the coordinate/citation constraints —
    // route-safety moves onto the resolved slug (see resolveSlug below). Legacy
    // keeps route-safety on the operationId, which is still its URL leaf.
    ctx.registry.register(opCoord, "operation", {
      source: sourceBase,
      isUserIdentity: true,
      skipRouteFault: ctx.routePolicy !== undefined,
    });
  } else {
    opCoord = fallbackOperationCoordinate(method, path);
    // `synthesized` marks it Nimbus-minted so a collision points at the fix. Route
    // safety is enforced below via `routeIdentityFault`, not `isUserIdentity`.
    ctx.registry.register(opCoord, "operation", { source: sourceBase, synthesized: true });
    const cause =
      op.operationId === undefined
        ? "has no operationId"
        : op.operationId === ""
          ? "has an empty operationId"
          : `has a non-string operationId (${typeof op.operationId})`;
    // A route-hostile path yields an unusable coordinate — fatal regardless of
    // `requireOperationId`. A usable path warns by default, or fails under strict.
    const routeFault = routeIdentityFault(opCoord);
    if (routeFault) {
      ctx.registry.addError(
        `Operation ${method.toUpperCase()} ${path} ${cause}, and its path-derived fallback ${routeFault}`,
        opCoord,
        sourceBase,
      );
    } else {
      const message =
        `Operation ${method.toUpperCase()} ${path} ${cause}. Falling back to the ` +
        `path-derived coordinate "${opCoord}", which is not stable across a path ` +
        `rename — add an operationId in the spec to pin a permanent URL and citation.`;
      if (ctx.requireOperationId) {
        ctx.registry.addError(message, opCoord, sourceBase, "missing-operation-id");
      } else {
        ctx.registry.addWarning(message, opCoord, sourceBase, "missing-operation-id");
      }
    }
  }

  const facts = assembleOperation(ctx, {
    coord: opCoord,
    op,
    sourceBase,
    protocol: { method: method.toUpperCase(), path },
    rawOp: ctx.resolver.rawOperation(path, method),
    rawSharedParams: ctx.resolver.rawPathParameters(path),
    sharedParams,
    sampleTarget: { method, path },
  });

  const tag = typeof op.tags?.[0] === "string" ? op.tags[0] : undefined;
  if (tag) ctx.ensureSection(tag);
  const parentSection = tag ? sectionCoordinate(tag) : apiCoordinate(ctx.collection);
  ctx.node(opCoord, "operation", parentSection, facts, sourceBase);

  resolveSlug(ctx, { method, path, operationId, opCoord, sourceBase, tag });
  ctx.attachToNav(tag, opCoord, asString(op.summary) ?? opCoord);
}

/**
 * Record the operation's page slug. Under a `resource-action-v1` policy the slug is
 * resolved by `override → derivation → normalized coordinate fallback`, then
 * route-safety and reserved-route checks run on that final slug (the
 * `operationId` faced neither). Legacy (no policy) keeps the exact
 * `tag ? tagRouteSegment/operationId : operationId` behavior, byte-for-byte.
 */
function resolveSlug(
  ctx: ParseContext,
  input: {
    method: HttpMethod;
    path: string;
    operationId: string | undefined;
    opCoord: Coordinate;
    sourceBase: string;
    tag: string | undefined;
  },
): void {
  const { method, path, operationId, opCoord, sourceBase, tag } = input;

  if (!ctx.routePolicy) {
    const slug = tag ? `${tagRouteSegment(tag)}/${opCoord}` : opCoord;
    ctx.page(opCoord, slug);
    return;
  }

  const label = `${method.toUpperCase()} ${path}`;
  const outcome = resolveOperationRoute(ctx.routePolicy, {
    method,
    path,
    operationId,
    coordinate: opCoord,
  });

  if (outcome.kind === "fallback-empty") {
    // Even the coordinate normalizes away — nothing can name the page. Fatal;
    // skip page registration (the build fails on this error, so the partial
    // model is discarded before any consumer reads it).
    ctx.registry.addError(
      `Operation ${label} (coordinate "${opCoord}") has no unambiguous resource-action-v1 route and its ` +
        `coordinate normalizes to an empty slug. Add an explicit route in \`routes.operations\` ` +
        `keyed by its operationId.`,
      opCoord,
      sourceBase,
      "route-fallback-empty",
    );
    return;
  }

  const slug = outcome.slug;
  if (outcome.kind === "override") {
    ctx.noteOverrideConsumed(operationId!);
  } else if (outcome.kind === "fallback") {
    ctx.registry.addWarning(
      `Operation ${label} (coordinate "${opCoord}") has no unambiguous resource-action-v1 route; falling back ` +
        `to the normalized coordinate slug "${slug}". Add an explicit route in \`routes.operations\` ` +
        `to pin a stable URL.`,
      opCoord,
      sourceBase,
      "route-fallback",
    );
  }

  // Route-safety on the final resolved slug (§Implementation boundary step 5).
  // Derived/fallback slugs are kebab-safe by construction; an override was
  // validated at config time — this is the single enforcement point and a net.
  const fault = routeSlugFault(slug);
  if (fault) {
    ctx.registry.addError(
      `Operation ${label} resolves to route slug "${slug}", which ${fault}. ` +
        `Fix the \`routes.operations\` override.`,
      opCoord,
      sourceBase,
      "route-slug-invalid",
    );
  } else if (RESERVED_ROUTE_SEGMENTS.has(slug.split("/")[0]!)) {
    const seg = slug.split("/")[0]!;
    ctx.registry.addError(
      `Operation ${label} resolves to route slug "${slug}", whose top-level segment "${seg}" is a ` +
        `reserved route ([${[...RESERVED_ROUTE_SEGMENTS].join(", ")}] and the API root). ` +
        `Add a \`routes.operations\` override so it stays distinct.`,
      opCoord,
      sourceBase,
      "route-reserved-collision",
    );
  }

  ctx.recordRouteProvenance(opCoord, outcome.kind);
  ctx.page(opCoord, slug, outcome.kind);
}

/** An operation-shaped node to assemble: a real path operation or a webhook. */
export interface OperationSite {
  coord: Coordinate;
  op: OpenApiOperation;
  /** JSON-Pointer prefix for child sources, e.g. `#/paths/{path}/{method}`. */
  sourceBase: string;
  protocol: OperationFacts["protocol"];
  /** The raw (ref-preserving) operation, for recovering union branch names. */
  rawOp: Record<string, unknown> | undefined;
  /** Raw (ref-preserving) path-item-level shared parameters — a shared union
   *  parameter recovers its branch names from here, since they don't appear
   *  under the operation's own `parameters`. */
  rawSharedParams?: unknown[];
  sharedParams: OpenApiParameter[];
  /** Present for a real endpoint → synthesise a server URL + code samples.
   *  Absent for a webhook (delivered to the subscriber, never called), so no
   *  server and no `curl`; the body/response examples still resolve. */
  sampleTarget?: { method: HttpMethod; path: string };
}

/**
 * Mint an operation's parameters, body fields, and responses, and return its
 * `OperationFacts`. Shared by real path operations and webhooks — the caller
 * owns identity (coordinate registration), the parent/nav placement, and the
 * page. Property order is load-bearing: it is the serialised model's key order.
 */
export function assembleOperation(ctx: ParseContext, site: OperationSite): OperationFacts {
  const { coord, op, sourceBase, rawOp, sharedParams } = site;
  const request: Coordinate[] = [];
  const responses: Coordinate[] = [];

  // Path-level parameters are shared; an operation-level parameter with the
  // same (name, location) OVERRIDES the shared one (OpenAPI §Path Item). Dedup
  // operation-wins so an override does not mint the coordinate twice.
  const allParams = dedupeParameters(sharedParams, op.parameters ?? []);
  for (const param of allParams) {
    request.push(addParameter(ctx, coord, param, sourceBase, rawOp, site.rawSharedParams));
  }

  // Every declared media type renders. The primary (deterministic precedence)
  // keeps the short-form coordinate (rule 1); each additional media type is a
  // child node under a token segment, so no documented field is ever dropped.
  const mediaEntries = orderedMediaEntries(op.requestBody?.content);
  const primaryEntry = mediaEntries[0];
  const bodySchema = primaryEntry?.media.schema;
  const rawBodySchema = ctx.resolver.rawContentSchema(rawOp?.requestBody);
  const bodyUnion = bodySchema
    ? ctx.resolver.unionPreferRaw(rawBodySchema, bodySchema, itemsOf(bodySchema))
    : undefined;
  if (bodySchema) {
    for (const c of addBodyFields(ctx, coord, bodySchema, sourceBase, rawBodySchema)) {
      request.push(c);
    }
  }
  for (const entry of mediaEntries.slice(1)) {
    addMediaBody(ctx, coord, entry, sourceBase, rawOp?.requestBody);
  }

  for (const [status, response] of Object.entries(op.responses ?? {})) {
    const respCoord = responseCoordinate(coord, status);
    const respSource = `${sourceBase}/responses/${status}`;
    ctx.registry.register(respCoord, "response", { source: respSource });
    const respEntry = primaryMediaEntry(response.content);
    const respSchema = respEntry?.media.schema;
    const rawRespSchema = ctx.resolver.rawContentSchema(
      isPlainObject(rawOp?.responses) ? (rawOp.responses as Record<string, unknown>)[status] : undefined,
    );
    if (picksNonPrimaryMedia(response.content)) {
      ctx.registry.addWarning(
        `Response "${respCoord}" has multiple media types and no application/json; rendering the first declared type only.`,
        respCoord,
        respSource,
      );
    }
    const facts: ResponseFacts = {
      kind: "response",
      status,
      description: asString(response.description),
    };
    // Derived response example — authored `example`/`examples` win, else
    // sampler synthesis with WRITE-only fields hidden (the inverse of the
    // request). A `oneOf`/`anyOf` body is best-effort: the sampler picks one
    // branch; authored examples sidestep that. Symmetric with the request side.
    const respExample = resolveExampleValue(
      mediaExample(respEntry),
      "response",
      ctx.sampleTools,
    );
    if (respEntry && respExample !== undefined) {
      facts.example = { mediaType: respEntry.mediaType, value: respExample };
    }
    const respUnion = respSchema
      ? ctx.resolver.unionPreferRaw(rawRespSchema, respSchema, itemsOf(respSchema))
      : undefined;
    if (respUnion) facts.union = respUnion;
    ctx.node(respCoord, "response", coord, facts);
    responses.push(respCoord);
    if (respSchema) {
      walkFields(ctx.resolver, respSchema, SCHEMA_FIELD_DEPTH, new Set(), (fieldPath, fieldSchema, required, _topLevelName, parentPath, rawField) => {
        const fieldCoord = responseFieldCoordinate(coord, status, fieldPath);
        // A nested response field parents to its container field; a top-level
        // one parents to the response node, not the operation.
        const parent = parentPath
          ? responseFieldCoordinate(coord, status, parentPath)
          : respCoord;
        addField(ctx, fieldCoord, parent, fieldSchema, required, "field", respSource, rawField);
      }, rawRespSchema);
    }
    // The first-class error catalogue (`errors.<code>`) is deliberately NOT
    // minted yet. Its identity is semantic (an error code from the spec's
    // error schema, e.g. `errors.card_declined`), not the HTTP status — and
    // coordinates can never be refactored, so it is designed from the error
    // schema in a later pass.
  }

  const auth = resolveAuth(op.security ?? ctx.doc.security);
  const facts: OperationFacts = {
    kind: "operation",
    summary: asString(op.summary),
    description: asString(op.description),
    deprecated: op.deprecated,
    auth,
    request,
    responses,
    samples: [],
    protocol: site.protocol,
  };
  if (bodyUnion) facts.bodyUnion = bodyUnion;
  if (primaryEntry) facts.bodyMediaType = primaryEntry.mediaType;
  if (site.sampleTarget && ctx.firstServer) facts.server = ctx.firstServer;

  // Resolve the request example ONCE (authored `example`/`examples` win, else
  // sampler synthesis with read-only fields hidden) so the rendered example and
  // the snippet body are the same value — an authored example is no longer
  // discarded by re-synthesizing from the schema. Authored examples resolve
  // without the sample tools; synthesis is tools-gated.
  const requestEntry = primaryMediaEntry(op.requestBody?.content);
  const requestExample = resolveExampleValue(
    mediaExample(requestEntry),
    "request",
    ctx.sampleTools,
  );
  if (requestEntry && requestExample !== undefined) {
    facts.example = { mediaType: requestEntry.mediaType, value: requestExample };
  }
  if (requestEntry) {
    const requestExamples = resolveNamedExampleValues(
      mediaExample(requestEntry)?.examples,
    ).map((example) => ({ ...example, mediaType: requestEntry.mediaType }));
    if (requestExamples.length > 0) facts.requestExamples = requestExamples;
  }
  if (site.sampleTarget && ctx.sampleTools) {
    facts.samples = buildOperationSamples(ctx.sampleTools, {
      method: site.sampleTarget.method,
      path: site.sampleTarget.path,
      server: ctx.firstServer,
      params: allParams,
      body: facts.example
        ? { mediaType: facts.example.mediaType, value: facts.example.value }
        : undefined,
      securitySchemes: ctx.doc.components?.securitySchemes,
      auth,
      xCodeSamples: op["x-codeSamples"] ?? op["x-code-samples"],
    });
  }
  return facts;
}

function addParameter(
  ctx: ParseContext,
  opCoord: Coordinate,
  param: OpenApiParameter,
  sourceBase: string,
  rawOp: Record<string, unknown> | undefined,
  rawSharedParams: unknown[] | undefined,
): Coordinate {
  const location = param.in as ParameterLocation;
  const coord = parameterCoordinate(opCoord, location, param.name);
  ctx.registry.register(coord, "parameter", {
    source: `${sourceBase}/parameters/${param.name}`,
  });
  const facts: ParameterFacts = {
    kind: "parameter",
    location,
    type: typeLabel(param.schema),
    required: param.required ?? location === "path",
    description: asString(param.description) ?? asString(param.schema?.description),
    deprecated: param.deprecated,
    constraints: constraintsOf(param.schema),
    default: param.schema?.default,
    enum: param.schema?.enum,
    example: param.schema?.example,
  };
  const union = param.schema
    ? ctx.resolver.unionPreferRaw(
        ctx.resolver.rawParameterSchema(rawOp?.parameters, rawSharedParams, param.name, location),
        param.schema,
        itemsOf(param.schema),
      )
    : undefined;
  if (union) facts.union = union;
  ctx.node(coord, "parameter", opCoord, facts);
  return coord;
}

function addBodyFields(
  ctx: ParseContext,
  opCoord: Coordinate,
  schema: OpenApiSchema,
  sourceBase: string,
  rawSchema?: OpenApiSchema,
): Coordinate[] {
  const coords: Coordinate[] = [];
  walkFields(ctx.resolver, schema, SCHEMA_FIELD_DEPTH, new Set(), (fieldPath, fieldSchema, required, topLevelName, parentPath, rawField) => {
    const coord = bodyFieldCoordinate(opCoord, fieldPath);
    // A nested body field parents to its container field; a top-level one
    // parents to the operation. Nesting is minted here because coordinates are
    // opaque — the view-model can never reconstruct hierarchy after the fact.
    const parent = parentPath ? bodyFieldCoordinate(opCoord, parentPath) : opCoord;
    // Rule 1 shadowing: a top-level body property that reads like a prefix is
    // legal but warned; an actual collision is a build error via the registry.
    if (topLevelName && isShadowingBodyProperty(topLevelName)) {
      ctx.registry.warnShadowing(coord, topLevelName, sourceBase);
    }
    addField(ctx, coord, parent, fieldSchema, required, "field", `${sourceBase}/requestBody`, rawField);
    coords.push(coord);
  }, rawSchema);
  return coords;
}

function addMediaBody(
  ctx: ParseContext,
  opCoord: Coordinate,
  entry: { mediaType: string; media: OpenApiMediaType },
  sourceBase: string,
  rawRequestBody: unknown,
): void {
  const token = mediaTypeToken(entry.mediaType);
  const mediaCoord = bodyMediaCoordinate(opCoord, token);
  const source = `${sourceBase}/requestBody/content/${entry.mediaType}`;
  ctx.registry.register(mediaCoord, "requestBody", { source });

  const schema = entry.media.schema;
  const rawSchema = ctx.resolver.rawMediaSchema(rawRequestBody, entry.mediaType);
  const facts: RequestBodyFacts = { kind: "requestBody", mediaType: entry.mediaType };
  const union = schema
    ? ctx.resolver.unionPreferRaw(rawSchema, schema, itemsOf(schema))
    : undefined;
  if (union) facts.union = union;
  const example = resolveExampleValue(mediaExample(entry), "request", ctx.sampleTools);
  if (example !== undefined) facts.example = { mediaType: entry.mediaType, value: example };
  ctx.node(mediaCoord, "requestBody", opCoord, facts, source);

  if (schema) {
    walkFields(ctx.resolver, schema, SCHEMA_FIELD_DEPTH, new Set(), (fieldPath, fieldSchema, required, _topLevelName, parentPath, rawField) => {
      const coord = bodyMediaFieldCoordinate(opCoord, token, fieldPath);
      const parent = parentPath ? bodyMediaFieldCoordinate(opCoord, token, parentPath) : mediaCoord;
      addField(ctx, coord, parent, fieldSchema, required, "field", source, rawField);
    }, rawSchema);
  }
}
