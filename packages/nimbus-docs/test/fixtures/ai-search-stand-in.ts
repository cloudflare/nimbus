/**
 * A local stand-in for a Cloudflare AI Search instance: the account Items API
 * `search sync` calls and the public `/search` endpoint the dialog calls,
 * shaped as the service documents them. Tests drive `search sync` against
 * it; run directly, it serves a site's dialog locally without an account:
 *
 *   node --import tsx test/fixtures/ai-search-stand-in.ts --port 8788
 *
 * Retrieval is plain keyword scoring over heading-sized chunks: enough to
 * exercise filters, ranking order and result shapes, not to judge quality.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface StandInItem {
  id: string;
  key: string;
  content: string;
  metadata: Record<string, string | boolean>;
  status: "queued" | "running" | "completed" | "error" | "skipped" | "outdated";
  error?: string;
}

export interface StandInOptions {
  port?: number;
  token?: string;
  accountId?: string;
  instance?: string;
  /** The instance's custom metadata schema; the four fields by default. */
  fields?: Array<{ field_name: string; data_type: string }>;
  /** Milliseconds an upload stays queued. Default 0: completed on the next list. */
  processingMs?: number;
  /** Answer the next n account requests with 429 (tests). */
  throttle?: number;
}

export const FIVE_FIELDS = [
  { field_name: "url", data_type: "text" },
  { field_name: "title", data_type: "text" },
  { field_name: "version", data_type: "text" },
  { field_name: "deprecated", data_type: "boolean" },
];

export async function startAiSearchStandIn(options: StandInOptions = {}) {
  const token = options.token ?? "test-token";
  const accountId = options.accountId ?? "acct0000000000000000000000001234";
  const instance = options.instance ?? "nimbus-demo";
  const items = new Map<string, StandInItem>();
  const uploadedAt = new Map<string, number>();
  const log: Array<{ method: string; path: string }> = [];
  let nextId = 1;
  const state = { throttle: options.throttle ?? 0, fields: options.fields ?? FIVE_FIELDS };
  const prefix = `/client/v4/accounts/${accountId}/ai-search/namespaces/default/instances/${instance}`;

  const settle = () => {
    for (const item of items.values()) {
      if (item.status !== "queued") continue;
      if (Date.now() - (uploadedAt.get(item.id) ?? 0) < (options.processingMs ?? 0)) continue;
      const body = item.content.replace(/^#{1,6}\s.*$/gmu, "").trim();
      if (!body) {
        item.status = "error";
        item.error = "file_content_empty";
      } else item.status = "completed";
    }
  };

  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };

  const readBody = (request: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stand-in");
    log.push({ method: request.method ?? "", path: url.pathname + url.search });
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };

    if (url.pathname === "/search") {
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors);
        response.end();
        return;
      }
      settle();
      const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
      const query = String(body.query ?? body.messages?.at(-1)?.content ?? "");
      const retrieval = body.ai_search_options?.retrieval ?? {};
      const chunks = search(query, retrieval.filters ?? {}, retrieval.max_num_results ?? 10);
      send(response, 200, { success: true, result: { search_query: query, chunks } }, cors);
      return;
    }

    if (!url.pathname.startsWith(prefix)) return send(response, 404, { success: false, errors: [{ code: 7003, message: "No route" }] });
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(response, 403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    if (state.throttle > 0) {
      state.throttle -= 1;
      return send(response, 429, { success: false, errors: [{ code: 971, message: "Too many requests" }] }, { "retry-after": "0" });
    }
    const rest = url.pathname.slice(prefix.length);
    settle();
    if (rest === "" && request.method === "GET")
      return send(response, 200, { success: true, result: {
          id: instance,
          custom_metadata: state.fields,
          indexing_options: { keyword_tokenizer: "trigram" },
          public_endpoint_params: { enabled: true, search_endpoint: { disabled: false }, rate_limit: { requests: 120, period_ms: 60_000, technique: "sliding" } },
        } });
    if (rest === "/items" && request.method === "GET") {
      const status = url.searchParams.get("status");
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 20), 50);
      const page = Number(url.searchParams.get("page") ?? 1);
      const all = [...items.values()].filter((item) => !status || item.status === status);
      const result = all.slice((page - 1) * perPage, page * perPage).map((item) => ({
        id: item.id,
        key: item.key,
        status: item.status,
        source_id: "builtin",
        metadata: { filename: item.key, folder: item.key.includes("/") ? `${item.key.slice(0, item.key.lastIndexOf("/"))}/` : "" },
        ...(item.error ? { error: item.error } : {}),
      }));
      return send(response, 200, { success: true, result, result_info: { count: result.length, total_count: all.length, page, per_page: perPage } });
    }
    if (rest === "/items" && request.method === "POST") {
      const form = await new Request("http://stand-in", {
        method: "POST",
        headers: { "content-type": request.headers["content-type"] ?? "" },
        body: await readBody(request),
      }).formData();
      const file = form.get("file") as File;
      const raw = JSON.parse(String(form.get("metadata") ?? "{}")) as Record<string, unknown>;
      // Like the service: values must be strings; boolean fields store "true"/"false" as booleans.
      if (Object.values(raw).some((value) => typeof value !== "string"))
        return send(response, 400, { success: false, errors: [{ code: 7056, message: "invalid_metadata_format" }] });
      const booleans = new Set(state.fields.filter((field) => field.data_type === "boolean").map((field) => field.field_name));
      const metadata = Object.fromEntries(
        Object.entries(raw as Record<string, string>).map(([name, value]) => [name, booleans.has(name) ? value === "true" : value]),
      );
      const key = file.name;
      if ([...items.values()].some((item) => item.key === key))
        return send(response, 409, { success: false, errors: [{ code: 7409, message: "Item exists" }] });
      const known = new Set(state.fields.map((field) => field.field_name));
      const unknown = Object.keys(metadata).filter((name) => !known.has(name));
      const id = `item-${nextId++}`;
      items.set(id, { id, key, content: await file.text(), metadata, status: "queued" });
      uploadedAt.set(id, Date.now());
      return send(response, 200, {
        success: true,
        result: { id, key },
        messages: unknown.map((name) => ({ code: "custom_metadata_field_not_filterable", message: `${name} is not in the schema` })),
      });
    }
    const match = /^\/items\/([^/]+)$/u.exec(rest);
    if (match && request.method === "DELETE") {
      const id = decodeURIComponent(match[1]!);
      if (!items.delete(id)) return send(response, 404, { success: false, errors: [{ code: 7404, message: "Not found" }] });
      return send(response, 200, { success: true, result: null });
    }
    send(response, 404, { success: false, errors: [{ code: 7003, message: "No route" }] });
  });

  function matches(metadata: Record<string, string | boolean>, filters: Record<string, unknown>): boolean {
    return Object.entries(filters).every(([field, condition]) => {
      const value = metadata[field];
      if (condition && typeof condition === "object" && "$in" in condition) return (condition.$in as unknown[]).includes(value);
      if (condition && typeof condition === "object" && "$eq" in condition) return condition.$eq === value;
      return condition === value;
    });
  }

  function search(query: string, filters: Record<string, unknown>, limit: number) {
    const terms = query.toLowerCase().split(/\W+/u).filter(Boolean);
    const found: Array<{ id: string; type: "text"; score: number; text: string; item: { key: string; metadata: Record<string, unknown> } }> = [];
    for (const item of items.values()) {
      if (item.status !== "completed" || !matches(item.metadata, filters)) continue;
      const sections = item.content.split(/\n(?=#{1,6}\s)/u);
      sections.forEach((text, index) => {
        const lower = `${String(item.metadata.title ?? "")} ${text}`.toLowerCase();
        const hits = terms.filter((term) => lower.includes(term)).length;
        if (hits === 0 || hits < terms.length) return;
        found.push({ id: `${item.id}-${index}`, type: "text", score: hits / terms.length, text, item: { key: item.key, metadata: { ...item.metadata } } });
      });
    }
    return found.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    apiBase: `${origin}/client/v4`,
    token,
    accountId,
    instance,
    items,
    log,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 8788);
  const standIn = await startAiSearchStandIn({ port, processingMs: 500 });
  process.stdout.write(
    `AI Search stand-in on ${standIn.origin}\n` +
      `  search endpoint:   ${standIn.origin}\n` +
      `  sync with:         NIMBUS_AI_SEARCH_API=${standIn.apiBase} CLOUDFLARE_ACCOUNT_ID=${standIn.accountId} NIMBUS_AI_SEARCH_TOKEN=${standIn.token}\n`,
  );
}
