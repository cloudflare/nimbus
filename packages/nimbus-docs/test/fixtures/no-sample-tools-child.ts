// A process whose module loader cannot find the sample generators. Argument: the
// `samples.generate` list as JSON, or `null` for the default. Prints the operation
// page's samples and Markdown twin as JSON.

import { register } from "node:module";

import type { ApiSampleLang } from "../../src/types.ts";

const hook = `
  const missing = new Set(["openapi-sampler", "@readme/httpsnippet"]);
  export function resolve(specifier, context, next) {
    if (missing.has(specifier)) {
      throw Object.assign(new Error(\`Cannot find package '\${specifier}'\`), { code: "ERR_MODULE_NOT_FOUND" });
    }
    return next(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { buildApiModel, getApiPageProps, renderApiPageMarkdown } = await import("../../src/api/index.ts");

const generate = JSON.parse(process.argv[2] ?? "null") as ApiSampleLang[] | null;
const spec = {
  openapi: "3.1.0",
  info: { title: "Authored", version: "1.0.0" },
  servers: [{ url: "https://api.probe.test/v1" }],
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        "x-codeSamples": [
          { lang: "curl", label: "cURL", source: "curl https://api.probe.test/v1/ping" },
          { lang: "hcl", label: "Terraform", source: 'resource "probe_ping" "x" {}' },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};
const model = await buildApiModel({
  collection: "authored",
  spec,
  ...(generate ? { samples: { generate } } : {}),
});
const page = getApiPageProps(model, "ping");
if (page.kind !== "operation") throw new Error(`expected an operation page, got ${page.kind}`);
process.stdout.write(JSON.stringify({ samples: page.samples, markdown: renderApiPageMarkdown(page) }));
