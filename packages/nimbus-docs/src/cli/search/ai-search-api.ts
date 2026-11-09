/**
 * The slice of the Cloudflare AI Search REST API `search sync` uses: the
 * instance, and its built-in storage items. Every request is paced (the
 * account API allows 1,200 requests per 5 minutes per user, shared with
 * deploys and the dashboard) and retried with backoff on 429 and 5xx.
 */

export const AI_SEARCH_FIELDS = [
  { field_name: "url", data_type: "text" },
  { field_name: "title", data_type: "text" },
  { field_name: "version", data_type: "text" },
  { field_name: "deprecated", data_type: "boolean" },
] as const;

export type ItemStatus = "queued" | "running" | "completed" | "error" | "skipped" | "outdated";

export interface AiSearchItem {
  id: string;
  key: string;
  status: ItemStatus;
  /** The service's error or skip code, when the listing carries one. */
  code?: string;
}

export interface AiSearchInstance {
  custom_metadata?: Array<{ field_name: string; data_type: string }>;
  [setting: string]: unknown;
}

export class AiSearchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface AiSearchApiOptions {
  accountId: string;
  token: string;
  instance: string;
  /** Tests and the local stand-in only. */
  apiBase?: string;
  /** Minimum gap between requests. Default 334 ms (three a second). */
  gapMs?: number;
  /** Backoff base. Default 1 s. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

const DEFAULT_API = "https://api.cloudflare.com/client/v4";
const RETRIES = 5;

export function createAiSearchApi(options: AiSearchApiOptions) {
  const api = (options.apiBase ?? DEFAULT_API).replace(/\/+$/u, "");
  const root = `${api}/accounts/${encodeURIComponent(options.accountId)}/ai-search/namespaces/default/instances/${encodeURIComponent(options.instance)}`;
  const gap = options.gapMs ?? 334;
  const backoff = options.backoffMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const doFetch = options.fetch ?? fetch;
  let next = 0;
  let requests = 0;

  async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    for (let attempt = 0; ; attempt += 1) {
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      next = Date.now() + gap;
      requests += 1;
      let response: Response;
      try {
        response = await doFetch(`${root}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${options.token}`, ...(init.headers ?? {}) },
        });
      } catch (error) {
        if (attempt >= RETRIES) throw new AiSearchApiError(`network error: ${(error as Error).message}`, 0);
        await sleep(backoff * 2 ** attempt);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoff * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      return { status: response.status, body };
    }
  }

  function failure(what: string, status: number, body: Record<string, unknown>): AiSearchApiError {
    const errors = (body.errors as Array<{ code?: unknown; message?: unknown }> | undefined) ?? [];
    const first = errors[0];
    const detail = first?.message ? `: ${String(first.message)}` : "";
    const hint =
      status === 401 || status === 403
        ? " Check the token has AI Search Edit and Run on this account."
        : status === 404
          ? " Check the instance name and the account id."
          : "";
    return new AiSearchApiError(
      `${what} failed (HTTP ${status})${detail}.${hint}`,
      status,
      first?.code !== undefined ? String(first.code) : undefined,
    );
  }

  return {
    get requests() {
      return requests;
    },

    async instance(): Promise<AiSearchInstance> {
      const { status, body } = await request("");
      if (status !== 200) throw failure(`Reading instance "${options.instance}"`, status, body);
      return (body.result ?? {}) as AiSearchInstance;
    },

    /** Every built-in item, or those with one status. */
    async listItems(status?: ItemStatus): Promise<AiSearchItem[]> {
      const items: AiSearchItem[] = [];
      for (let page = 1; ; page += 1) {
        const query = new URLSearchParams({ source: "builtin", per_page: "50", page: String(page) });
        if (status) query.set("status", status);
        const response = await request(`/items?${query}`);
        if (response.status !== 200) throw failure("Listing items", response.status, response.body);
        const result = (response.body.result as Array<Record<string, unknown>> | undefined) ?? [];
        for (const item of result) {
          const error = item.error as { code?: unknown } | string | undefined;
          const code =
            typeof error === "string" ? error : error?.code !== undefined ? String(error.code) : typeof item.error_code === "string" ? item.error_code : undefined;
          items.push({
            id: String(item.id),
            key: String(item.key),
            status: String(item.status) as ItemStatus,
            ...(code ? { code } : {}),
          });
        }
        const info = response.body.result_info as { total_count?: number; per_page?: number } | undefined;
        if (result.length < 50 || (info?.total_count !== undefined && page * 50 >= info.total_count)) break;
      }
      return items;
    },

    /** Upload one item. A metadata warning means the fields didn't attach, so it counts as a failure. */
    async upload(key: string, content: Uint8Array, metadata: Record<string, string | boolean>): Promise<{ id?: string; warning?: string }> {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(content)], { type: "text/markdown" }), key);
      // The upload rejects JSON booleans; it takes "true"/"false" and stores booleans.
      const fields = Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name, String(value)]));
      form.append("metadata", JSON.stringify(fields));
      const { status, body } = await request("/items", { method: "POST", body: form });
      if (status === 409) return {};
      if (status !== 200 && status !== 201) throw failure(`Uploading ${key}`, status, body);
      const messages = [
        ...((body.messages as Array<{ code?: unknown; message?: unknown }> | undefined) ?? []),
        ...(((body.result as Record<string, unknown> | undefined)?.warnings as Array<{ code?: unknown; message?: unknown }> | undefined) ?? []),
      ];
      const warning = messages.find((message) => /^custom_metadata_/u.test(String(message.code ?? "")));
      const id = (body.result as { id?: unknown } | undefined)?.id;
      return {
        ...(id !== undefined ? { id: String(id) } : {}),
        ...(warning ? { warning: String(warning.code) } : {}),
      };
    },

    /** Delete one item; already gone is success. */
    async deleteItem(id: string): Promise<void> {
      const { status, body } = await request(`/items/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (status === 404 || status === 200 || status === 204) return;
      throw failure(`Deleting item ${id}`, status, body);
    },
  };
}

export type AiSearchApi = ReturnType<typeof createAiSearchApi>;
