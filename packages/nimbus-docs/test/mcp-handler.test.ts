// The remote MCP server, driven with raw Requests and no client: the
// HTTP surface (methods, CORS, Origin, body cap), the handshake, the two
// tools, their visibility rules, pagination and URL resolution.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_LIST_PAGE_SIZE,
  MCP_MAX_DRAIN_BYTES,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_PAGE_CONTENT_LIMIT,
  cachedPerOrigin,
  createDocsMcpHandler,
  originIsWellFormed,
  resolvePageRecord,
} from "../src/_internal/mcp/handler.js";
import { mcpServerIdentity, mcpUrl } from "../src/_internal/mcp/identity.js";
import type { McpPageIndex, McpPageRecord } from "../src/_internal/mcp/page-index.js";
import { INITIALIZE_PARAMS, MODERN_META, readRpcResponse, rpcRequest, toolText } from "./fixtures/mcp/rpc.js";

const SITE = "https://docs.example.com";

function record(
  path: string,
  overrides: Partial<McpPageRecord> & { base?: string } = {},
): McpPageRecord {
  const { base = "/", ...rest } = overrides;
  const prefix = base === "/" ? "" : base.replace(/\/$/, "");
  const markdownPath = path === "/" ? "/index.md" : `${path.replace(/\/$/, "")}/index.md`;
  const title = path === "/" ? "Home" : path.split("/").filter(Boolean).join(" ");
  return {
    title,
    url: `${SITE}${prefix}${path}`,
    markdownUrl: `${SITE}${prefix}${markdownPath}`,
    markdownPath,
    section: path.split("/").filter(Boolean)[0] ?? "index",
    searchable: true,
    ...rest,
  };
}

const INDEX: McpPageIndex = {
  version: 1,
  versions: ["v2", "v1"],
  pages: [
    record("/", { version: "v2" }),
    record("/guide/", { version: "v2", description: "Start here" }),
    record("/guide/install/", { version: "v2" }),
    record("/internal/", { version: "v2", searchable: false }),
    record("/findable/", { version: "v2", searchable: true }),
    record("/v1/guide/", { version: "v1", deprecated: true, section: "v1" }),
    record("/blog/hello/", { section: "blog" }),
    record("/api/pets/", { section: "api" }),
  ],
};

function identity(base = "/") {
  return mcpServerIdentity({ site: SITE, base, title: "Example", version: "0.19.0", endpointUrl: mcpUrl(SITE, base) });
}

function handlerFor(index: McpPageIndex, base = "/", pages: Record<string, string> = {}) {
  return createDocsMcpHandler({
    identity: identity(base),
    base,
    source: {
      readIndex: async () => index,
      readPage: async (page) => pages[page.markdownPath] ?? `# ${page.title}\n\nBody of ${page.markdownPath}.\n`,
    },
  });
}

const URL_ = `${SITE}/mcp`;

function oversizedPost(chunks: number, chunkSize: number, contentLength?: number) {
  const state = { read: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.read === chunks) return controller.close();
      state.read++;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const request = new Request(URL_, {
    method: "POST",
    body,
    duplex: "half",
    headers: { "Content-Type": "application/json", ...(contentLength ? { "Content-Length": String(contentLength) } : {}) },
  } as RequestInit);
  return { request, state };
}

test("a body over the limit is read to its end before the 413, so the connection stays usable", async () => {
  for (const declared of [undefined, MCP_MAX_REQUEST_BODY_BYTES * 2]) {
    const handler = handlerFor(INDEX);
    const { request, state } = oversizedPost(4, MCP_MAX_REQUEST_BODY_BYTES / 2, declared);
    const response = await handler.fetch(request);
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(state, { read: 4, cancelled: false });
    assert.equal((await handler.fetch(rpcRequest(URL_, "initialize", INITIALIZE_PARAMS))).status, 200);
  }
});

test("a body past the drain cap is cancelled: at once when declared, at the cap when streamed", async () => {
  const handler = handlerFor(INDEX);
  const atCap = oversizedPost(16, 64 * 1024, MCP_MAX_DRAIN_BYTES);
  assert.equal((await handler.fetch(atCap.request)).status, 413);
  assert.deepEqual(atCap.state, { read: 16, cancelled: false });

  const declared = oversizedPost(Infinity, 64 * 1024, MCP_MAX_DRAIN_BYTES + 1);
  assert.equal((await handler.fetch(declared.request)).status, 413);
  assert.equal(declared.state.cancelled, true);
  assert.ok(declared.state.read <= 1, `read ${declared.state.read} chunks`);

  const streamed = oversizedPost(Infinity, 64 * 1024);
  assert.equal((await handler.fetch(streamed.request)).status, 413);
  assert.equal(streamed.state.cancelled, true);
  assert.ok(streamed.state.read <= MCP_MAX_DRAIN_BYTES / (64 * 1024) + 2, `read ${streamed.state.read} chunks`);
});

test("OPTIONS allows the requested headers; GET and DELETE are 405 with Allow; a bad Origin is 403", async () => {
  const handler = handlerFor(INDEX);
  const requested = "content-type, mcp-method, mcp-name, mcp-protocol-version";
  const preflight = await handler.fetch(
    new Request(URL_, {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": requested },
    }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-headers"), requested);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(preflight.headers.get("vary"), "Access-Control-Request-Headers");
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await handler.fetch(new Request(URL_, { method }));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
  for (const origin of ["null", "example.com", "https://a b", "https://docs.example.com/path"]) {
    const response = await handler.fetch(rpcRequest(URL_, "initialize", INITIALIZE_PARAMS, 1, { Origin: origin }));
    assert.equal(response.status, 403, origin);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_origin");
  }
  assert.equal(originIsWellFormed("https://app.example.com:8443"), true);
  assert.equal(originIsWellFormed("chrome-extension://abcdefghijklmnop"), true);
  assert.equal(originIsWellFormed("https://Example.com"), true, "non-canonical case is still an origin");
  assert.equal(originIsWellFormed("http://example.com:80"), true, "a default port is still an origin");
  assert.equal(originIsWellFormed("https://example.com/app"), false, "a path is not an origin");
  assert.equal(originIsWellFormed("https://example.com/?q"), false, "a query is not an origin");
  assert.equal(originIsWellFormed(null), true);
});

test("every tool call reads the index and the page with the request being served", async () => {
  const seen: string[] = [];
  const handler = createDocsMcpHandler({
    identity: identity(),
    base: "/",
    source: {
      readIndex: async (request) => {
        seen.push(new URL(request.url).hostname);
        return INDEX;
      },
      readPage: async (page, request) => {
        seen.push(`page@${new URL(request.url).hostname}`);
        return `# ${page.title}`;
      },
    },
  });
  for (const host of ["first.test", "second.test"]) {
    const request = rpcRequest(`https://${host}/mcp`, "tools/call", { name: "get_page", arguments: { url: "/guide/" } });
    await readRpcResponse(await handler.fetch(request));
  }
  assert.deepEqual(seen, ["first.test", "page@first.test", "second.test", "page@second.test"]);
});

test("the index cache is per origin, so one request's Host never decides another's read, and a failed read is retried", async () => {
  const reads: string[] = [];
  let fail = true;
  const read = cachedPerOrigin(async (request) => {
    const host = new URL(request.url).host;
    reads.push(host);
    if (host === "flaky.test" && fail) {
      fail = false;
      throw new Error("unavailable");
    }
    return host;
  });
  const at = (host: string) => read(new Request(`https://${host}/mcp`));
  assert.equal(await at("docs.example.com"), "docs.example.com");
  assert.equal(await at("docs.example.com"), "docs.example.com");
  assert.equal(await at("169.254.169.254"), "169.254.169.254");
  assert.equal(await at("docs.example.com"), "docs.example.com");
  await assert.rejects(at("flaky.test"));
  assert.equal(await at("flaky.test"), "flaky.test");
  assert.deepEqual(reads, ["docs.example.com", "169.254.169.254", "docs.example.com", "flaky.test", "flaky.test"]);
});

test("a page store that cannot be read is a structured unavailable error, not a raw one", async () => {
  const handler = createDocsMcpHandler({
    identity: identity(),
    base: "/",
    source: {
      readIndex: async () => INDEX,
      readPage: async () => {
        throw new Error("nimbus-docs: build output file x returned 404. Check the site's client files (dist/client) were deployed with the server.");
      },
    },
  });
  const { value, isError } = await call(handler, "get_page", { url: "/guide/" });
  assert.equal(isError, true);
  assert.equal((value.error as { code: string }).code, "unavailable");
  assert.doesNotMatch((value.error as { message: string }).message, /dist\/client|returned 404/);
});

test("initialize reports the derived name, the package version, instructions and the tools capability", async () => {
  const handler = handlerFor(INDEX);
  const response = await handler.fetch(
    rpcRequest(URL_, "initialize", INITIALIZE_PARAMS, 1, { Origin: "https://app.example.com" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const message = await readRpcResponse(response);
  const result = message.result as {
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
    instructions: string;
    protocolVersion: string;
  };
  assert.deepEqual(result.serverInfo, {
    name: "com.example.docs/docs",
    version: "0.19.0",
    title: "Example",
    websiteUrl: "https://docs.example.com/",
    description: "Read the Example documentation: get_page and list_pages, no search.",
  });
  assert.deepEqual(result.capabilities.tools, { listChanged: false });
  assert.match(result.instructions, /two tools and no search/);
});

test("the 2026-07-28 protocol discovers the server and calls a tool with its headers", async () => {
  const handler = handlerFor(INDEX);
  const modern = (method: string, params: Record<string, unknown>, name?: string) =>
    rpcRequest(URL_, method, { ...params, _meta: MODERN_META }, 1, {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    });
  const discover = await readRpcResponse(await handler.fetch(modern("server/discover", {})));
  assert.deepEqual((discover.result as { capabilities: { tools: unknown } }).capabilities.tools, { listChanged: false });
  const page = await readRpcResponse(
    await handler.fetch(modern("tools/call", { name: "get_page", arguments: { url: "/guide/" } }, "get_page")),
  );
  assert.equal((toolText(page) as { url: string }).url, `${SITE}/guide/`);
  const tools = await readRpcResponse(await handler.fetch(modern("tools/list", {})));
  assert.deepEqual((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name), ["get_page", "list_pages"]);
  const list = await readRpcResponse(await handler.fetch(modern("tools/call", { name: "list_pages", arguments: {} }, "list_pages")));
  assert.ok((toolText(list) as { pages: unknown[] }).pages.length > 0);
});

test("every request is answered with one JSON body, never a stream; a notification is 202 with no body", async () => {
  const handler = handlerFor(INDEX);
  const responses = [
    await handler.fetch(rpcRequest(URL_, "initialize", INITIALIZE_PARAMS, 1)),
    await handler.fetch(rpcRequest(URL_, "tools/call", { name: "get_page", arguments: { url: "/guide/" } }, 2)),
    await handler.fetch(
      rpcRequest(URL_, "server/discover", { _meta: MODERN_META }, 3, {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover",
      }),
    ),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal((JSON.parse(await response.text()) as { jsonrpc: string }).jsonrpc, "2.0");
  }
  const notification = await handler.fetch(
    new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
  );
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("tools/list returns get_page and list_pages with strict input schemas and read-only annotations", async () => {
  const handler = handlerFor(INDEX);
  const message = await readRpcResponse(await handler.fetch(rpcRequest(URL_, "tools/list")));
  const tools = (message.result as { tools: Array<Record<string, unknown>> }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get_page", "list_pages"],
  );
  for (const tool of tools) {
    const schema = tool.inputSchema as { additionalProperties?: boolean; properties: Record<string, unknown> };
    assert.equal(schema.additionalProperties, false);
    assert.equal((tool.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
  }
  assert.deepEqual(Object.keys((tools[0]!.inputSchema as { properties: object }).properties), ["url", "offset"]);
  assert.deepEqual(Object.keys((tools[1]!.inputSchema as { properties: object }).properties), ["section", "version", "cursor"]);
});

async function call(handler: ReturnType<typeof handlerFor>, name: string, args: Record<string, unknown>) {
  const message = await readRpcResponse(await handler.fetch(rpcRequest(URL_, "tools/call", { name, arguments: args })));
  if (message.error) return { rpcError: message.error };
  return { isError: (message.result as { isError?: boolean }).isError === true, value: toolText(message) as Record<string, unknown> };
}

async function callText(handler: ReturnType<typeof handlerFor>, name: string, args: Record<string, unknown>) {
  const message = await readRpcResponse(await handler.fetch(rpcRequest(URL_, "tools/call", { name, arguments: args })));
  const result = message.result as { isError?: boolean; content: Array<{ text: string }> };
  return { rpcError: message.error, isError: result?.isError === true, text: result?.content[0]?.text ?? "" };
}

test("list_pages by default matches search: noindex out unless searchable, deprecated out, other collections in", async () => {
  const handler = handlerFor(INDEX);
  const { value, isError } = await call(handler, "list_pages", {});
  assert.equal(isError, false);
  const pages = value.pages as Array<{ url: string; section: string; version?: string; description?: string }>;
  assert.deepEqual(
    pages.map((page) => page.url),
    [
      `${SITE}/`,
      `${SITE}/guide/`,
      `${SITE}/guide/install/`,
      `${SITE}/findable/`,
      `${SITE}/blog/hello/`,
      `${SITE}/api/pets/`,
    ],
  );
  assert.equal(pages[1]!.description, "Start here");
  assert.equal(pages[1]!.section, "guide");
  assert.equal(pages[1]!.version, "v2");
  assert.equal("nextCursor" in value, false);
});

test("list_pages filters by section and by an explicit version, which allows a deprecated one", async () => {
  const handler = handlerFor(INDEX);
  const guide = await call(handler, "list_pages", { section: "guide" });
  assert.deepEqual((guide.value.pages as Array<{ url: string }>).map((p) => p.url), [`${SITE}/guide/`, `${SITE}/guide/install/`]);
  const v1 = await call(handler, "list_pages", { version: "v1" });
  assert.deepEqual((v1.value.pages as Array<{ url: string }>).map((p) => p.url), [`${SITE}/v1/guide/`]);
  const none = await call(handler, "list_pages", { section: "nope" });
  assert.deepEqual(none.value.pages, []);
  const unknown = await call(handler, "list_pages", { version: "v9" });
  assert.equal(unknown.isError, true);
  assert.deepEqual((unknown.value.error as { code: string }).code, "invalid_input");
  assert.match((unknown.value.error as { message: string }).message, /Versions: v2, v1/);
});

test("list_pages pages 200 at a time through an opaque cursor and rejects a cursor from other filters", async () => {
  const many: McpPageIndex = {
    version: 1,
    versions: [],
    pages: Array.from({ length: MCP_LIST_PAGE_SIZE + 50 }, (_, i) =>
      record(`/p/${String(i).padStart(3, "0")}/`),
    ),
  };
  const handler = handlerFor(many);
  const first = await call(handler, "list_pages", {});
  assert.equal((first.value.pages as unknown[]).length, MCP_LIST_PAGE_SIZE);
  const cursor = first.value.nextCursor as string;
  assert.equal(typeof cursor, "string");
  assert.doesNotMatch(cursor, /[=+/]/);
  const second = await call(handler, "list_pages", { cursor });
  assert.equal((second.value.pages as unknown[]).length, 50);
  assert.equal("nextCursor" in second.value, false);
  assert.equal((second.value.pages as Array<{ url: string }>)[0]!.url, `${SITE}/p/200/`);
  const mismatched = await call(handler, "list_pages", { cursor, section: "p" });
  assert.equal(mismatched.isError, true);
  assert.equal((mismatched.value.error as { code: string }).code, "invalid_input");
  const key = cursor.split(".")[1];
  for (const bad of ["not-a-cursor", `0x10.${key}`, `-1.${key}`, `1e2.${key}`]) {
    const garbage = await call(handler, "list_pages", { cursor: bad });
    assert.equal(garbage.isError, true, bad);
  }
});

test("get_page accepts an absolute URL, a site path, a .md path, a query and a fragment, and reports not_found", async () => {
  const handler = handlerFor(INDEX);
  for (const url of [
    `${SITE}/guide/`,
    `${SITE}/guide`,
    "/guide/",
    "/guide",
    "guide",
    "/guide/index.md",
    `${SITE}/guide/#install`,
    `${SITE}/guide/?version=v1`,
    "https://preview.example.workers.dev/guide/",
    "./guide/",
    "guide/../guide/",
    "guide?tab=1",
  ]) {
    const { value, isError } = await call(handler, "get_page", { url });
    assert.equal(isError, false, url);
    assert.deepEqual(
      { title: value.title, url: value.url, markdownUrl: value.markdownUrl },
      { title: "guide", url: `${SITE}/guide/`, markdownUrl: `${SITE}/guide/index.md` },
      url,
    );
    assert.equal(value.content, "# guide\n\nBody of /guide/index.md.\n");
    assert.equal("truncated" in value, false);
  }
  const home = await call(handler, "get_page", { url: "/" });
  assert.equal(home.value.title, "Home");
  const hidden = await call(handler, "get_page", { url: "/internal/" });
  assert.equal(hidden.isError, false, "noindex pages resolve, like search");
  for (const url of ["/missing/", `${SITE}/v0/guide/`, "/guide/index.mdx"]) {
    const { value, isError } = await call(handler, "get_page", { url });
    assert.equal(isError, true, url);
    assert.equal((value.error as { code: string }).code, "not_found");
  }
});

test("get_page strips a configured base and an .html extension from URLs and paths", () => {
  const base = "/docs/";
  const index: McpPageIndex = { version: 1, versions: [], pages: [record("/", { base }), record("/guide/", { base })] };
  for (const url of [`${SITE}/docs/guide/`, "/docs/guide/", "/guide/", "/docs/guide/index.md", "/docs/guide.html", "/docs/guide/index.html", `${SITE}/docs/guide.html`]) {
    assert.equal(resolvePageRecord(url, index, base)?.markdownPath, "/guide/index.md", url);
  }
  for (const url of ["/docs/", "/docs/index.html", `${SITE}/docs/index.html`]) {
    assert.equal(resolvePageRecord(url, index, base)?.markdownPath, "/index.md", url);
  }
});

test("get_page cuts long pages near the limit and says so", async () => {
  const long = "é".repeat(MCP_PAGE_CONTENT_LIMIT + 10);
  const handler = handlerFor(INDEX, "/", { "/guide/index.md": long });
  const { value } = await call(handler, "get_page", { url: "/guide/" });
  assert.equal(value.truncated, true);
  assert.equal([...(value.content as string)].length, MCP_PAGE_CONTENT_LIMIT);
});

test("get_page reads on from offset, so a page needs no Markdown URL to be read whole", async () => {
  const long = "é".repeat(MCP_PAGE_CONTENT_LIMIT + 10);
  const handler = handlerFor(INDEX, "/", { "/guide/index.md": long });
  const first = await call(handler, "get_page", { url: "/guide/" });
  assert.equal(first.value.nextOffset, MCP_PAGE_CONTENT_LIMIT);
  const rest = await call(handler, "get_page", { url: "/guide/", offset: first.value.nextOffset });
  assert.equal(rest.isError, false);
  assert.equal(rest.value.offset, MCP_PAGE_CONTENT_LIMIT);
  assert.equal([...(rest.value.content as string)].length, 10);
  assert.equal("truncated" in rest.value, false);
  assert.equal("nextOffset" in rest.value, false);
});

test("a page record without a Markdown URL lists and reads without one", async () => {
  const { pages, ...rest } = INDEX;
  const index: McpPageIndex = { ...rest, pages: pages.map(({ markdownUrl: _dropped, ...page }) => page) };
  const handler = handlerFor(index, "/", { "/guide/index.md": "# guide\n\nBody.\n" });
  const listed = await call(handler, "list_pages", {});
  assert.ok((listed.value.pages as Array<Record<string, unknown>>).every((page) => !("markdownUrl" in page)));
  const page = await call(handler, "get_page", { url: "/guide/" });
  assert.equal(page.isError, false);
  assert.equal("markdownUrl" in page.value, false);
  assert.equal(page.value.content, "# guide\n\nBody.\n");
});

test("schema-invalid arguments are the SDK's tool error, and a body over 64 KB is 413", async () => {
  const handler = handlerFor(INDEX);
  for (const [name, args, detail] of [
    ["get_page", { url: "/guide/", extra: true }, /extra/],
    ["get_page", {}, /url/],
    ["get_page", { url: 5 }, /url/],
    ["list_pages", { version: "" }, /version/],
    ["list_pages", { limit: 5 }, /limit/],
  ] as const) {
    const { text, isError, rpcError } = await callText(handler, name, args);
    assert.equal(rpcError, undefined);
    assert.equal(isError, true, JSON.stringify(args));
    assert.match(text, /^Input validation error: Invalid arguments for tool /);
    assert.match(text, detail);
  }
  const big = new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MCP_MAX_REQUEST_BODY_BYTES) } }),
  });
  assert.equal((await handler.fetch(big)).status, 413);
});

test("a JSON-RPC batch is refused before any work; single messages and malformed JSON are unchanged", async () => {
  let reads = 0;
  const handler = createDocsMcpHandler({
    identity: identity(),
    base: "/",
    source: {
      readIndex: async () => (reads++, INDEX),
      readPage: async () => (reads++, "# Page"),
    },
  });
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_page", arguments: { url: "/guide/" } } };
  const note = { jsonrpc: "2.0", method: "notifications/initialized" };
  const modern = { ...call, params: { ...call.params, _meta: MODERN_META } };
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request(URL_, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    });
  for (const [label, batch, headers] of [
    ["empty", [], {}],
    ["single", [call], {}],
    ["notifications", [note, note], {}],
    ["mixed", [call, note, { ...call, id: 2, method: "tools/list", params: {} }], {}],
    ["modern", [modern], { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_page" }],
  ] as const) {
    const response = await handler.fetch(post(JSON.stringify(batch), headers));
    assert.equal(response.status, 400, label);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*", label);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batch requests are not supported; send one JSON-RPC message per request." },
    }, label);
  }
  assert.equal(reads, 0);
  const single = await readRpcResponse(await handler.fetch(rpcRequest(URL_, "tools/call", call.params)));
  assert.equal((toolText(single) as { url: string }).url, `${SITE}/guide/`);
  // Malformed JSON is still the transport's parse error.
  const malformed = await (await handler.fetch(post("[{"))).json();
  assert.equal((malformed as { error: { code: number } }).error.code, -32700);
});

test("a client asking for 2025-03-26, the revision that requires batches, is offered a newer one", async () => {
  const handler = handlerFor(INDEX);
  const response = await readRpcResponse(
    await handler.fetch(rpcRequest(URL_, "initialize", { ...INITIALIZE_PARAMS, protocolVersion: "2025-03-26" })),
  );
  const offered = (response.result as { protocolVersion: string }).protocolVersion;
  assert.notEqual(offered, "2025-03-26");
  assert.match(offered, /^\d{4}-\d{2}-\d{2}$/);
  const kept = await readRpcResponse(await handler.fetch(rpcRequest(URL_, "initialize", INITIALIZE_PARAMS)));
  assert.equal((kept.result as { protocolVersion: string }).protocolVersion, INITIALIZE_PARAMS.protocolVersion);
});

test("get_page cuts between code points, and an offset past the end reads nothing", async () => {
  const long = "😀".repeat(MCP_PAGE_CONTENT_LIMIT + 5);
  const handler = handlerFor(INDEX, "/", { "/guide/index.md": long });
  const first = await call(handler, "get_page", { url: "/guide/" });
  assert.equal([...(first.value.content as string)].length, MCP_PAGE_CONTENT_LIMIT);
  assert.doesNotMatch(first.value.content as string, /[\uD800-\uDBFF]$/u);
  const rest = await call(handler, "get_page", { url: "/guide/", offset: first.value.nextOffset });
  assert.equal(rest.value.content, "😀".repeat(5));
  const beyond = await call(handler, "get_page", { url: "/guide/", offset: MCP_PAGE_CONTENT_LIMIT * 2 });
  assert.equal(beyond.isError, false);
  assert.equal(beyond.value.content, "");
  assert.equal("truncated" in beyond.value, false);
});
