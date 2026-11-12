/** Test helpers: the specs, their response schemas, and a validator for them. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import routesData from "../src/routes.json" with { type: "json" };
import type { Route, Version } from "../src/answer";

export const VERSIONS: Version[] = ["v1", "v2", "v3-preview"];

type Json = Record<string, unknown>;

const specs = new Map<Version, Json>();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats.default ? addFormats.default(ajv) : (addFormats as unknown as (a: Ajv2020) => void)(ajv);

/** Ajv has its own discriminator support that rejects OpenAPI's `mapping`; the `oneOf` beside it is enough. */
function withoutDiscriminators(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDiscriminators);
  if (typeof node !== "object" || node === null) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "discriminator") continue;
    out[key] = withoutDiscriminators(value);
  }
  return out;
}

export function spec(version: Version): Json {
  let doc = specs.get(version);
  if (!doc) {
    const file = fileURLToPath(new URL(`../../src/api/weather-${version}.yaml`, import.meta.url));
    doc = withoutDiscriminators(parse(readFileSync(file, "utf8"))) as Json;
    specs.set(version, doc);
    ajv.addSchema(doc, `spec:${version}`);
  }
  return doc;
}

export function routes(version: Version): Route[] {
  return (routesData as { versions: Record<string, { routes: Route[] }> }).versions[`/${version}`]?.routes ?? [];
}

const pointer = (segment: string) => segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** Validate a body against the operation's documented success response; returns error text or null. */
export function validateResponse(version: Version, route: Route, body: unknown): string | null {
  spec(version);
  const ref = `spec:${version}#/paths/${pointer(route.path)}/${route.method.toLowerCase()}/responses/${route.status}/content/${pointer(route.mediaType ?? "application/json")}/schema`;
  const validate = ajv.getSchema(ref) ?? ajv.compile({ $ref: ref });
  if (validate(body)) return null;
  return ajv.errorsText(validate.errors, { dataVar: "body" });
}
