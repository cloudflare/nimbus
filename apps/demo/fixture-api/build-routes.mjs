#!/usr/bin/env node
// Precompute the fixture API's answers from the demo's latest spec (v2): each
// operation's documented success response, and the spec's error envelope.
// The Worker (src/worker.ts) only matches and replays. Run after the spec
// changes: `pnpm fixture-api:routes`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sample } from "openapi-sampler";

const spec = parse(readFileSync(fileURLToPath(new URL("../src/api/weather-v2.yaml", import.meta.url)), "utf8"));

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
    routes.push({
      method: method.toUpperCase(),
      path,
      pattern: `^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`,
      templated: path.includes("{"),
      auth: security.length > 0 && !security.some((alt) => Object.keys(alt).length === 0),
      requiredQuery: params.filter((p) => p?.in === "query" && p.required).map((p) => p.name),
      status: Number(status),
      ...answer(response),
    });
  }
}
// Literal paths win over templated ones (`/alerts/subscriptions` before `/alerts/{alert_id}`).
routes.sort((a, b) => Number(a.templated) - Number(b.templated));

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

writeFileSync(
  fileURLToPath(new URL("./src/routes.json", import.meta.url)),
  `${JSON.stringify({ base: "/v2", routes, errors: { 400: envelope(400), 401: envelope(401), 404: envelope(404), 405: envelope(405), 429: envelope(429) } }, null, 2)}\n`,
);
console.log(`fixture-api: ${routes.length} operations`);
