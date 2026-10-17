/**
 * Writes the three Weather API specs into src/api/.
 *
 *   pnpm generate-spec
 *
 * Edit the area files, not the YAML: each version is derived from the same
 * model, so a field renamed in v2 stays renamed everywhere.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { coreResponses, coreSchemas } from "./core";
import { alerts } from "./areas/alerts";
import { history, imagery } from "./areas/data";
import { agriculture, airQuality, aviation, energy, lightning, marine, tropical } from "./areas/domains";
import { platform } from "./areas/platform";
import { stations } from "./areas/stations";
import { forecasts, locations, observations } from "./areas/weather";
import type { Area, Version } from "./lib";

const RELEASES: Record<Version, { file: string; version: string; summary: string }> = {
  1: {
    file: "weather-v1.yaml",
    version: "1.14.2",
    summary:
      "**v1 is deprecated** and stops responding on 2026-12-31. It reports imperial units only. See the migration guide for moving to v2.",
  },
  2: {
    file: "weather-v2.yaml",
    version: "2.8.0",
    summary: "Forecasts, observations, alerts, imagery, and climate data for anywhere on Earth.",
  },
  3: {
    file: "weather-v3-preview.yaml",
    version: "3.0.0-preview.4",
    summary:
      "**Preview.** v3 adds ensemble and probabilistic forecasts. Fields may change before release; don't build production systems on it yet.",
  },
};

function areasFor(v: Version): Area[] {
  const shared = [locations(v), forecasts(v), observations(v), stations(v), alerts(v), imagery(v), history(v), platform(v)];
  if (v === 1) return shared;
  return [
    ...shared.slice(0, 7),
    airQuality(v),
    marine(v),
    aviation(v),
    tropical(v),
    lightning(v),
    agriculture(v),
    energy(v),
    shared[7]!,
  ];
}

function build(v: Version): Record<string, unknown> {
  const release = RELEASES[v];
  const areas = areasFor(v);
  const tags = [...areas.map((a) => a.tag), { name: "Service", description: "Health checks." }];
  const groups = new Map<string, string[]>();
  for (const area of areas) groups.set(area.group, [...(groups.get(area.group) ?? []), area.tag.name]);
  groups.set("Platform", [...(groups.get("Platform") ?? []), "Service"]);

  const pathsOut: Record<string, Record<string, unknown>> = {};
  for (const area of areas) {
    for (const [p, methods] of Object.entries(area.paths)) Object.assign((pathsOut[p] ??= {}), methods);
  }
  const webhooks = Object.assign({}, ...areas.map((a) => a.webhooks ?? {}));

  const securitySchemes =
    v === 1
      ? { apiKey: { type: "apiKey", in: "query", name: "key", description: "Your API key, as the `key` query parameter." } }
      : {
          bearer: { type: "http", scheme: "bearer", description: "Your API key: `Authorization: Bearer wx_live_…`." },
          oauth2: {
            type: "oauth2",
            description: "Client credentials for account management.",
            flows: {
              clientCredentials: {
                tokenUrl: "https://auth.weather.example/oauth/token",
                scopes: { account: "Manage keys, members, and billing." },
              },
            },
          },
        };

  return {
    openapi: "3.1.0",
    info: {
      title: "Weather API",
      version: release.version,
      description: release.summary,
      contact: { name: "Weather API support", email: "support@weather.example" },
      termsOfService: "https://weather.example/terms",
    },
    servers: [{ url: v === 3 ? "https://api.weather.example/v3-preview" : `https://api.weather.example/v${v}` }],
    security: [v === 1 ? { apiKey: [] } : { bearer: [] }],
    tags,
    "x-tagGroups": [...groups].map(([name, members]) => ({ name, tags: members })),
    paths: pathsOut,
    ...(Object.keys(webhooks).length ? { webhooks } : {}),
    components: {
      schemas: Object.assign(coreSchemas(v), ...areas.map((a) => a.schemas ?? {})),
      responses: coreResponses(),
      securitySchemes,
    },
  };
}

const kebab = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();

/** Every operation's URL: `<tag>/<operation-id>`, e.g. `forecasts/get-daily-forecast`. */
function routesOf(doc: Record<string, unknown>): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const methods of Object.values(doc.paths as Record<string, Record<string, { operationId: string; tags: string[] }>>)) {
    for (const operation of Object.values(methods)) {
      routes[operation.operationId] = `${kebab(operation.tags[0]!)}/${kebab(operation.operationId)}`;
    }
  }
  return routes;
}

const out = new URL("../src/api/", import.meta.url);
const routes: Record<string, Record<string, string>> = {};
for (const v of [1, 2, 3] as const) {
  const doc = build(v);
  routes[v === 3 ? "v3-preview" : `v${v}`] = routesOf(doc);
  const file = new URL(RELEASES[v].file, out);
  writeFileSync(
    file,
    `# Generated by spec/generate.ts. Edit the model, then run \`pnpm generate-spec\`.\n${stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false })}`,
  );
  const ops = Object.values(doc.paths as Record<string, object>).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`${fileURLToPath(file)}: ${ops} operations`);
}
writeFileSync(new URL("routes.json", out), `${JSON.stringify(routes, null, 2)}\n`);
