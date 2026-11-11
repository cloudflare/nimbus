/** One module wraps the SDK so a swap stays away from the route and tests. */
import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  fromJsonSchema,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { McpServerIdentity } from "./identity.js";
import type { McpPageIndex, McpPageRecord } from "./page-index.js";
import { stripBase, toRouteKey, withoutHtmlExtension } from "../url.js";

/** Bodies over this are answered `413` before anything is parsed. */
export const MCP_MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** A body over the limit is still read up to this, so `wrangler dev` can reuse the connection. */
export const MCP_MAX_DRAIN_BYTES = 1024 * 1024;
export const MCP_LIST_PAGE_SIZE = 200;
/** `get_page` content is cut near this many code points, with `truncated: true`. */
export const MCP_PAGE_CONTENT_LIMIT = 100_000;

export type McpToolErrorCode = "invalid_input" | "not_found" | "unavailable";
export interface McpToolError {
  error: { code: McpToolErrorCode; message: string };
}

export interface GetPageResult {
  title: string;
  url: string;
  /** The page's Markdown URL, when a route of the site serves one. */
  markdownUrl?: string;
  content: string;
  /** The character offset `content` starts at, when not 0. */
  offset?: number;
  truncated?: true;
  /** Where the next `get_page` call should start, when `truncated`. */
  nextOffset?: number;
}

export interface ListPagesResult {
  pages: Array<{
    title: string;
    url: string;
    markdownUrl?: string;
    description?: string;
    section: string;
    version?: string;
  }>;
  nextCursor?: string;
}

export interface DocsMcpSource {
  readIndex(request: Request): Promise<McpPageIndex>;
  /** The page's clean Markdown, or `null` when its twin is missing. */
  readPage(record: McpPageRecord, request: Request): Promise<string | null>;
}

export interface DocsMcpHandlerOptions {
  identity: McpServerIdentity;
  /** The site's Astro `base`, so `/docs/guide/` resolves like `/guide/`. */
  base: string;
  source: DocsMcpSource;
}

export interface DocsMcpHandler {
  fetch(request: Request): Promise<Response>;
}

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" } as const;

export const GET_PAGE_TOOL = {
  name: "get_page",
  title: "Get a documentation page",
  description:
    "Return one documentation page as Markdown. Pass the page's URL as list_pages returns it (an absolute URL), " +
    `or a site-relative path such as /guide/. Long pages are cut near ${MCP_PAGE_CONTENT_LIMIT.toLocaleString("en-US")} characters with truncated: true; ` +
    "pass offset (a character count) to read on from there, or fetch the markdownUrl when the page has one.",
  inputSchema: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2048 },
      offset: { type: "integer", minimum: 0 },
    },
  },
} as const;

export const LIST_PAGES_TOOL = {
  name: "list_pages",
  title: "List documentation pages",
  description:
    "List published documentation pages: title, URL, description, section and version, plus the Markdown URL when the site serves one. " +
    "By default the list matches site search: pages marked noindex and deprecated versions are left out. " +
    `Filter by section (a top-level path segment; the home page is index) or by one version; pass nextCursor back as cursor for the next ${MCP_LIST_PAGE_SIZE}.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      section: { type: "string", minLength: 1, maxLength: 200 },
      version: { type: "string", minLength: 1, maxLength: 100 },
      cursor: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const;

interface ListPagesInput {
  section?: string;
  version?: string;
  cursor?: string;
}

/**
 * Caches the read for the most recent origin only. Where the asset reader
 * falls back to fetching the site's own URL, a request's Host must not
 * decide what requests from another origin read.
 */
export function cachedPerOrigin<T>(read: (request: Request) => Promise<T>): (request: Request) => Promise<T> {
  let cached: { origin: string; value: Promise<T> } | undefined;
  return (request) => {
    const origin = new URL(request.url).origin;
    if (cached?.origin === origin) return cached.value;
    const value = read(request).catch((error: unknown) => {
      if (cached?.value === value) cached = undefined;
      throw error;
    });
    cached = { origin, value };
    return value;
  };
}

export function toolError(code: McpToolErrorCode, message: string): McpToolError {
  return { error: { code, message } };
}

/**
 * The page a `get_page` URL names: an absolute URL or a site path, with
 * the base, a query (`?version=` on an API URL resolves the default) and a
 * fragment dropped; a `.md` path is accepted as is.
 */
export function resolvePageRecord(
  url: string,
  index: McpPageIndex,
  base: string,
): McpPageRecord | undefined {
  let pathname: string;
  try {
    const rooted = /^https?:\/\//i.test(url) || url.startsWith("/");
    pathname = new URL(rooted ? url : `/${url}`, "https://nimbus.invalid/").pathname;
  } catch {
    return undefined;
  }
  const route = toRouteKey(withoutHtmlExtension(stripBase(pathname, base)));
  const markdownPath = /\.md$/i.test(route) ? route : route === "/" ? "/index.md" : `${route}/index.md`;
  return index.pages.find((page) => page.markdownPath === markdownPath);
}

function listFilter(index: McpPageIndex, input: ListPagesInput): McpPageRecord[] {
  return index.pages.filter(
    (page) =>
      page.searchable &&
      (input.version === undefined ? !page.deprecated : page.version === input.version) &&
      (input.section === undefined || page.section === input.section),
  );
}

/** An FNV-1a hash of the filters, so a cursor is only accepted with the filters it came from. */
function filterKey(input: ListPagesInput): string {
  let hash = 0x811c9dc5;
  for (const char of `${input.section ?? ""}\u0000${input.version ?? ""}`) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function decodeCursor(cursor: string, input: ListPagesInput): number | undefined {
  const match = /^(\d+)\.([0-9a-z]+)$/.exec(cursor);
  return match && match[2] === filterKey(input) ? Number(match[1]) : undefined;
}

export function listPages(input: ListPagesInput, index: McpPageIndex): ListPagesResult | McpToolError {
  if (input.version !== undefined && !index.versions.includes(input.version)) {
    return toolError(
      "invalid_input",
      index.versions.length
        ? `Unknown version "${input.version}". Versions: ${index.versions.join(", ")}.`
        : "This site has no versions; call list_pages without a version.",
    );
  }
  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor, input);
  if (offset === undefined) {
    return toolError(
      "invalid_input",
      "The cursor is not one list_pages returned for these filters. Start again without a cursor.",
    );
  }
  const matches = listFilter(index, input);
  const next = offset + MCP_LIST_PAGE_SIZE;
  return {
    pages: matches.slice(offset, next).map((page) => ({
      title: page.title,
      url: page.url,
      ...(page.markdownUrl ? { markdownUrl: page.markdownUrl } : {}),
      ...(page.description ? { description: page.description } : {}),
      section: page.section,
      ...(page.version ? { version: page.version } : {}),
    })),
    ...(next < matches.length ? { nextCursor: `${next}.${filterKey(input)}` } : {}),
  };
}

export function pageResult(record: McpPageRecord, content: string, offset = 0): GetPageResult {
  const result = {
    title: record.title,
    url: record.url,
    ...(record.markdownUrl ? { markdownUrl: record.markdownUrl } : {}),
  };
  // UTF-16 length bounds the code-point count, so short pages skip the spread.
  if (offset === 0 && content.length <= MCP_PAGE_CONTENT_LIMIT) return { ...result, content };
  const points = [...content];
  if (offset === 0 && points.length <= MCP_PAGE_CONTENT_LIMIT) return { ...result, content };
  const slice = points.slice(offset, offset + MCP_PAGE_CONTENT_LIMIT).join("");
  if (offset + MCP_PAGE_CONTENT_LIMIT >= points.length) return { ...result, content: slice, ...(offset ? { offset } : {}) };
  return { ...result, content: slice, ...(offset ? { offset } : {}), truncated: true, nextOffset: offset + MCP_PAGE_CONTENT_LIMIT };
}

/**
 * A present `Origin` must be an origin: a scheme and a host, nothing after.
 * The opaque `null` origin is refused. Extension schemes (`chrome-extension://id`)
 * have a `null` tuple origin in the URL parser, so they're checked by shape.
 */
export function originIsWellFormed(origin: string | null): boolean {
  if (origin === null) return true;
  if (origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Non-special schemes (extensions) parse with an empty path.
  if (parsed.host === "" || !["/", ""].includes(parsed.pathname) || parsed.search || parsed.hash) return false;
  if (parsed.origin !== "null") return true;
  return `${parsed.protocol}//${parsed.host}`.toLowerCase() === origin.toLowerCase();
}

/** The preflight allows the headers the client asks for, as the SDK's own metadata routes do. */
function preflight(request: Request): Response {
  const requested = request.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      ...(requested ? { "Access-Control-Allow-Headers": requested } : {}),
      "Access-Control-Max-Age": "86400",
      Vary: "Access-Control-Request-Headers",
    },
  });
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function readBody(request: Request): Promise<Blob | null> {
  if (!request.body) return new Blob();
  if (Number(request.headers.get("content-length")) > MCP_MAX_DRAIN_BYTES) {
    await request.body.cancel();
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_MAX_DRAIN_BYTES) {
        await reader.cancel();
        return null;
      }
      if (size <= MCP_MAX_REQUEST_BODY_BYTES) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return size > MCP_MAX_REQUEST_BODY_BYTES ? null : new Blob(chunks);
}

/**
 * 2025-03-26 is the one MCP revision that requires JSON-RPC batches, which
 * this server refuses, so it never agrees to it: a client asking for it is
 * offered the newest revision instead.
 */
const PROTOCOL_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version !== "2025-03-26");

/** Whether the body is a JSON array. Anything that isn't JSON is left to the transport. */
async function isBatch(body: Blob): Promise<boolean> {
  try {
    return Array.isArray(JSON.parse(await body.text()));
  } catch {
    return false;
  }
}

function unavailable(error: unknown) {
  console.error(error);
  return toolResult(
    toolError("unavailable", "The page data could not be read; the site's published files may not be deployed. Try again later."),
    true,
  );
}

export function createDocsMcpHandler(options: DocsMcpHandlerOptions): DocsMcpHandler {
  const { identity, base, source } = options;
  const validator = new CfWorkerJsonSchemaValidator();
  const getPageSchema = fromJsonSchema<{ url: string; offset?: number }>(GET_PAGE_TOOL.inputSchema, validator);
  const listPagesSchema = fromJsonSchema<ListPagesInput>(LIST_PAGES_TOOL.inputSchema, validator);
  const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

  const serverFor = (request: Request): McpServer => {
    const server = new McpServer(
      {
        name: identity.name,
        version: identity.version,
        title: identity.title,
        websiteUrl: identity.websiteUrl,
        description: identity.description,
      },
      {
        capabilities: { tools: { listChanged: false } },
        instructions: identity.instructions,
        jsonSchemaValidator: validator,
        supportedProtocolVersions: PROTOCOL_VERSIONS,
      },
    );
    const readIndex = () => source.readIndex(request);
    server.registerTool(
      GET_PAGE_TOOL.name,
      { title: GET_PAGE_TOOL.title, description: GET_PAGE_TOOL.description, inputSchema: getPageSchema, annotations },
      async ({ url, offset }) => {
        let record: McpPageRecord | undefined;
        let content: string | null;
        try {
          record = resolvePageRecord(url, await readIndex(), base);
          if (!record) {
            return toolResult(toolError("not_found", `No published page at ${url}. list_pages names every page.`), true);
          }
          content = await source.readPage(record, request);
        } catch (error) {
          return unavailable(error);
        }
        if (content === null) {
          return toolResult(
            toolError(
              "not_found",
              record.markdownUrl ? `No Markdown for ${record.url}; read ${record.markdownUrl} directly.` : `No Markdown for ${record.url}.`,
            ),
            true,
          );
        }
        return toolResult(pageResult(record, content, typeof offset === "number" ? offset : 0));
      },
    );
    server.registerTool(
      LIST_PAGES_TOOL.name,
      { title: LIST_PAGES_TOOL.title, description: LIST_PAGES_TOOL.description, inputSchema: listPagesSchema, annotations },
      async (args) => {
        let index: McpPageIndex;
        try {
          index = await readIndex();
        } catch (error) {
          return unavailable(error);
        }
        const result = listPages(args, index);
        return toolResult(result, "error" in result);
      },
    );
    return server;
  };

  // Every answer is one JSON body: the tools emit nothing before their
  // result, so a stream would carry a single event. The SDK's own 2025-era
  // path always streams, so that traffic is served here per request.
  const modern = createMcpHandler(({ requestInfo }) => serverFor(requestInfo!), {
    legacy: "reject",
    responseMode: "json",
    maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
  });
  const legacy = async (request: Request): Promise<Response> => {
    const server = serverFor(request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };

  return {
    async fetch(request) {
      if (request.method === "OPTIONS") return preflight(request);
      if (request.method !== "POST") {
        return json(
          { error: { code: "method_not_allowed", message: "POST a JSON-RPC message; this server is stateless." } },
          405,
          { Allow: "POST, OPTIONS" },
        );
      }
      if (!originIsWellFormed(request.headers.get("origin"))) {
        return json({ error: { code: "invalid_origin", message: "The Origin header is not a valid origin." } }, 403);
      }
      const body = await readBody(request);
      if (!body) {
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Request body exceeds ${MCP_MAX_REQUEST_BODY_BYTES} bytes.` } },
          413,
        );
      }
      // MCP dropped JSON-RPC batches in 2025-06-18: one request, one call.
      if (await isBatch(body)) {
        return json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Batch requests are not supported; send one JSON-RPC message per request." },
          },
          400,
        );
      }
      const sized = new Request(request, { body });
      const response = (await isLegacyRequest(sized.clone()))
        ? await legacy(sized)
        : await modern.fetch(sized);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}
