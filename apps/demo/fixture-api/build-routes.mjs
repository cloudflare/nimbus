#!/usr/bin/env node
// Precompute the fixture API's answers from each of the demo's specs: every
// operation's documented success response, how it takes a key, the query and
// body fields it declares (type, format, enum, range), and the spec's error
// envelope. The Worker (src/worker.ts) matches, validates, and overlays the
// request onto the example (src/answer.ts). Run after a spec changes:
// `pnpm fixture-api:routes`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sample } from "openapi-sampler";

const VERSIONS = ["v1", "v2", "v3-preview"];

let spec;

const resolve = (node) => {
  let n = node;
  while (n && typeof n === "object" && typeof n.$ref === "string") {
    n = n.$ref.replace(/^#\//, "").split("/").reduce((acc, key) => acc?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
  }
  return n;
};

const answer = (response) => {
  const content = resolve(response)?.content ?? {};
  const [mediaType, media] = Object.entries(content).find(([t]) => /json/.test(t)) ?? Object.entries(content)[0] ?? [];
  if (!mediaType) return {};
  let body = media.example ?? Object.values(media.examples ?? {}).map(resolve).find((e) => e?.value !== undefined)?.value;
  if (body === undefined) {
    try {
      body = sample(media.schema ?? {}, { skipWriteOnly: true, quiet: true }, spec);
    } catch {
      body = {};
    }
  }
  return { mediaType, body: typeof body === "string" ? body : JSON.stringify(body, null, 2) };
};

// Where an operation takes its key: a query parameter or header for `apiKey`,
// the bearer header for `http` bearer and OAuth 2. Null when it needs none.
const keyOf = (security) => {
  if (!security.length || security.some((alt) => Object.keys(alt).length === 0)) return null;
  const scheme = resolve(spec.components?.securitySchemes?.[Object.keys(security[0])[0]]) ?? {};
  if (scheme.type === "apiKey") return { in: scheme.in, name: scheme.name };
  return { in: "header", name: "Authorization", bearer: true };
};

// A declared field, as the Worker validates it: type, format, enum, range,
// and for arrays what the items are.
const fieldOf = (name, schema, required) => {
  const s = resolve(schema) ?? {};
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  const items = s.items ? resolve(s.items) : undefined;
  return {
    name,
    ...(type ? { type } : {}),
    ...(s.format ? { format: s.format } : {}),
    ...(s.enum ? { enum: s.enum } : {}),
    ...(s.minimum !== undefined ? { minimum: s.minimum } : {}),
    ...(s.maximum !== undefined ? { maximum: s.maximum } : {}),
    ...(s.minItems !== undefined ? { minItems: s.minItems } : {}),
    ...(s.maxItems !== undefined ? { maxItems: s.maxItems } : {}),
    ...(items ? { items: { ...(items.type ? { type: Array.isArray(items.type) ? items.type[0] : items.type } : {}), ...(items.enum ? { enum: items.enum } : {}) } } : {}),
    required: Boolean(required),
  };
};

// The top-level fields of a JSON request body, when the operation has one.
const bodyFieldsOf = (op) => {
  const content = resolve(op.requestBody)?.content ?? {};
  const media = Object.entries(content).find(([t]) => /json/.test(t))?.[1];
  const schema = media ? resolve(media.schema) : undefined;
  if (!schema?.properties) return undefined;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => fieldOf(name, property, required.has(name)));
};

const routesOf = () => {
  const routes = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of ["get", "put", "post", "delete", "patch", "head", "options"]) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolve);
      const security = op.security ?? spec.security ?? [];
      const [status, response] =
        Object.entries(op.responses ?? {}).find(([s]) => /^2/.test(s)) ??
        Object.entries(op.responses ?? {}).find(([s]) => /^3/.test(s)) ?? ["200", {}];
      const query = params.filter((p) => p?.in === "query").map((p) => fieldOf(p.name, p.schema, p.required));
      const bodyFields = bodyFieldsOf(op);
      routes.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        // Named groups, so the Worker reads path parameters by name.
        pattern: `^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([^}]+)\\?\}/g, (_, name) => `(?<${name}>[^/]+)`)}$`,
        templated: path.includes("{"),
        key: keyOf(security),
        requiredQuery: query.filter((p) => p.required).map((p) => p.name),
        query,
        ...(bodyFields ? { bodyFields } : {}),
        status: Number(status),
        ...answer(response),
      });
    }
  }
  // Literal paths win over templated ones (`/alerts/subscriptions` before `/alerts/{alert_id}`).
  routes.sort((a, b) => Number(a.templated) - Number(b.templated));
  return routes;
};

const envelope = (status) => {
  const { body } = answer(spec.components?.responses?.[String(status)] ?? {});
  try {
    const value = JSON.parse(body ?? "null");
    if (value?.error && typeof value.error === "object") {
      const { param: _param, ...rest } = value.error;
      return { ...value, error: rest };
    }
  } catch {
    // Fall through to the plain envelope.
  }
  return { error: {} };
};

const versions = {};
for (const version of VERSIONS) {
  spec = parse(readFileSync(fileURLToPath(new URL(`../src/api/weather-${version}.yaml`, import.meta.url)), "utf8"));
  const routes = routesOf();
  versions[`/${version}`] = { routes, errors: { 400: envelope(400), 401: envelope(401), 404: envelope(404), 405: envelope(405), 429: envelope(429) } };
  console.log(`fixture-api: ${version}, ${routes.length} operations`);
}
writeFileSync(fileURLToPath(new URL("./src/routes.json", import.meta.url)), `${JSON.stringify({ versions }, null, 2)}\n`);
