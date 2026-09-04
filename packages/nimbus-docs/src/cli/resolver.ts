/**
 * Registry resolver.
 *
 * Two entry points:
 *
 *   - `resolveComponentTree(slug)` walks `registryDependencies` transitively
 *     and returns a flat ordered list of components/utilities to install
 *     (dependencies first, root last). Cycles are detected as repeated
 *     visits and skipped.
 *
 *   - `fetchFeatureMarkdown(slug)` returns the raw markdown for an
 *     agent-handoff feature; the caller decides what to do with it.
 *
 * The base URL for hosted artifacts is read from the bundled index, with
 * an `NIMBUS_REGISTRY_URL` env override for local development.
 */

import { z } from "astro/zod";

import {
  BUNDLED_INDEX,
  REGISTRY_BASE_URL,
  type RegistryIndexEntry,
} from "./_registry.generated.js";
import { invocation } from "./pm.js";

export interface RegistryFile {
  path: string;
  content: string;
}

export interface ComponentItem {
  name: string;
  type: "registry:ui" | "registry:lib";
  title: string;
  description: string;
  /** Registry release this item shipped in (provenance; drift is decided by hash). Optional. */
  version?: string;
  dependencies: string[];
  registryDependencies: string[];
  files: RegistryFile[];
}

// ---------------------------------------------------------------------------
// Payload validation (trust boundary)
// ---------------------------------------------------------------------------
//
// Registry responses are untrusted: TLS authenticates the host, not the
// bytes. Validate every payload's shape before it drives a write or install,
// and constrain the fields that reach a shell (`dependencies`) or a URL
// (`registryDependencies`).

// npm package name with optional version suffix (`clsx`, `@astrojs/react`,
// `foo@^1.2.3`); excludes shell/path metacharacters.
const NPM_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.^~><=*|-]+)?$/;

// Registry slug (`card-grid`, `404-page`), interpolated into the fetch URL.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const INDEX_MAX_BYTES = 1024 * 1024;
const COMPONENT_MAX_BYTES = 10 * 1024 * 1024;
const FEATURE_MAX_BYTES = 2 * 1024 * 1024;
const SINGLE_LINE_DISPLAY_RE = /^[^\u0000-\u001f\u007f-\u009f]*$/;

// Not strict: unknown keys strip (not reject) so the wire format can grow without
// breaking installed CLIs. Safety is per-field (shell/URL/fs constraints), below.
const registryFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const componentItemSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["registry:ui", "registry:lib"]),
  title: z.string().regex(SINGLE_LINE_DISPLAY_RE),
  description: z.string().regex(SINGLE_LINE_DISPLAY_RE),
  version: z.string().optional(),
  dependencies: z.array(
    z.string().regex(NPM_NAME_RE, "is not a valid npm package name"),
  ),
  registryDependencies: z.array(
    z.string().regex(SLUG_RE, "is not a valid registry slug"),
  ),
  files: z.array(registryFileSchema),
});

const registryIndexEntrySchema = z.object({
  name: z.string().regex(SLUG_RE, "is not a valid registry slug").max(100),
  type: z.enum(["registry:ui", "registry:lib", "registry:feature"]),
  title: z.string().max(200).regex(SINGLE_LINE_DISPLAY_RE),
  description: z.string().max(1_000).regex(SINGLE_LINE_DISPLAY_RE),
});

const registryIndexSchema = z
  .object({
    version: z.literal(1),
    registryVersion: z.string().min(1).max(100),
    items: z.record(z.string(), registryIndexEntrySchema),
  })
  .superRefine((index, context) => {
    const entries = Object.entries(index.items);
    if (entries.length > 2_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "contains more than 2000 entries",
      });
    }
    for (const [slug, entry] of entries) {
      if (!SLUG_RE.test(slug) || slug.length > 100) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", slug],
          message: "key is not a valid registry slug",
        });
      } else if (entry.name !== slug) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", slug, "name"],
          message: `must match its key "${slug}"`,
        });
      }
    }
  });

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Read the registry base URL on every call so `.env` files loaded after
 * module-import time (see cli/dotenv.ts) are picked up. The cost is
 * negligible — string interpolation of an env var.
 */
function getBaseUrl(): string {
  return (process.env.NIMBUS_REGISTRY_URL ?? REGISTRY_BASE_URL).replace(
    /\/$/,
    "",
  );
}

/** The registry host in use (honors `NIMBUS_REGISTRY_URL`) — recorded as a component's `source`. */
export function registrySource(): string {
  return getBaseUrl();
}

/**
 * Warning string when `NIMBUS_REGISTRY_URL` overrides the default host, else
 * `null`. Pure; `maybeWarnOverride` owns the print-once side effect.
 */
export function registryOverrideWarning(): string | null {
  const override = process.env.NIMBUS_REGISTRY_URL;
  if (!override) return null;

  const defaultHost = new URL(REGISTRY_BASE_URL).host;
  let overrideHost: string;
  try {
    overrideHost = new URL(override).host;
  } catch {
    overrideHost = override;
  }
  if (overrideHost === defaultHost) return null;

  return (
    `Using a non-default registry host: ${overrideHost} (via NIMBUS_REGISTRY_URL). ` +
    `Only add components from a registry you trust — payloads run on your machine.`
  );
}

let overrideWarned = false;
function maybeWarnOverride(): void {
  if (overrideWarned) return;
  overrideWarned = true;
  const msg = registryOverrideWarning();
  if (msg) process.stderr.write(`⚠ ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Index lookup (offline — no network)
// ---------------------------------------------------------------------------

export function getIndexEntry(slug: string): RegistryIndexEntry | undefined {
  return Object.hasOwn(BUNDLED_INDEX.items, slug)
    ? BUNDLED_INDEX.items[slug]
    : undefined;
}

export function listEntries(filter?: {
  type?: RegistryIndexEntry["type"];
}): RegistryIndexEntry[] {
  const all = Object.values(BUNDLED_INDEX.items);
  if (!filter?.type) return all;
  return all.filter((e) => e.type === filter.type);
}

export async function resolveIndexEntry(
  slug: string,
): Promise<RegistryIndexEntry> {
  return (await resolveIndexEntryWithSnapshot(slug)).entry;
}

export async function resolveIndexEntryWithSnapshot(slug: string): Promise<{
  entry: RegistryIndexEntry;
  liveIndex?: Record<string, RegistryIndexEntry>;
}> {
  if (!SLUG_RE.test(slug) || slug.length > 100) {
    throw new Error(
      `Invalid registry item: \`${slug}\`. Names use lowercase letters, numbers, and hyphens.`,
    );
  }
  const bundled = getIndexEntry(slug);
  if (bundled) return { entry: bundled };

  const liveIndex = await fetchLiveIndexItems();
  const entry = liveIndex[slug];
  if (!entry) {
    throw unknownRegistryItemError(slug);
  }
  return { entry, liveIndex };
}

async function fetchLiveIndexItems(): Promise<Record<string, RegistryIndexEntry>> {
  const url = `${getBaseUrl()}/registry.json`;
  const data = await fetchJson(url, "registry index", INDEX_MAX_BYTES);
  const parsed = registryIndexSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Live registry index at ${url} failed validation:\n` +
        formatZodIssues(parsed.error),
    );
  }
  return parsed.data.items;
}

function unknownRegistryItemError(slug: string): Error {
  const url = `${getBaseUrl()}/registry.json`;
  return new Error(
    `Unknown registry item: \`${slug}\`. The live registry index at ${url} was checked successfully; verify the spelling or browse the registry for current names.`,
  );
}

// ---------------------------------------------------------------------------
// Network: component JSON + feature markdown
// ---------------------------------------------------------------------------

function errorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) messages.push(current.message || current.name);
    else messages.push(String(current));
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return messages.filter(Boolean).join(" -> ");
}

function transportError(url: string, error: unknown): Error {
  const detail = errorChain(error);
  if (
    (error instanceof Error && error.name === "TimeoutError") ||
    /timed?\s*out|timeout|abort due to timeout/i.test(detail)
  ) {
    return new Error(
      `Registry request for ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds. Check your connection or registry URL and try again.`,
    );
  }

  const proxy = /proxy|connect|tunnel|econnrefused|enotfound|eai_again/i.test(detail);
  return new Error(
    `Could not reach the registry at ${url}.\n` +
      `  ${proxy ? "Proxy/connection error" : "Underlying error"}: ${detail || "Unknown transport failure"}\n\n` +
      `  Things to try:\n` +
      `    - ${proxy ? "Check HTTPS_PROXY/HTTP_PROXY and whether the proxy permits CONNECT to the registry host.\n    - " : ""}Set the registry URL: NIMBUS_REGISTRY_URL=https://example.com ${invocation("add <slug>")}\n` +
      `    - Check the value in your project's .env file.\n` +
      `    - Working in the Nimbus monorepo? Start the local registry with \`pnpm local\`.`,
  );
}

function statusError(url: string, res: Response): Error {
  const retryAfter = res.headers.get("retry-after");
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `Registry access was denied (${res.status}) for ${url}. Check registry authentication and proxy credentials.`,
    );
  }
  if (res.status === 404) {
    return new Error(
      `Registry resource was not found (404) at ${url}. Check the registry URL and requested slug.`,
    );
  }
  if (res.status === 429) {
    return new Error(
      `Registry rate limit exceeded (429) for ${url}.${retryAfter ? ` Retry after ${retryAfter}.` : " Wait and try again."}`,
    );
  }
  if (res.status >= 500) {
    return new Error(
      `Registry server is unavailable (${res.status}) for ${url}. Try again later or use another registry host.`,
    );
  }
  return new Error(
    `Registry returned ${res.status} ${res.statusText || "HTTP error"} for ${url}.`,
  );
}

async function httpGet(url: string, accept: string): Promise<Response> {
  maybeWarnOverride();
  const requestedOrigin = new URL(url).origin;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let currentUrl = url;

  for (let redirects = 0; ; redirects += 1) {
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        headers: { accept },
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw transportError(url, error);
    }

    const finalOrigin = new URL(res.url || currentUrl).origin;
    if (finalOrigin !== requestedOrigin) {
      throw new Error(
        `Registry request for ${url} was redirected across origins ` +
          `(${requestedOrigin} → ${finalOrigin}). Refusing to follow for safety. ` +
          `If the redirect is legitimate, point NIMBUS_REGISTRY_URL at the final host directly.`,
      );
    }

    if (![301, 302, 303, 307, 308].includes(res.status)) {
      if (!res.ok) throw statusError(currentUrl, res);
      return res;
    }

    if (redirects >= MAX_REDIRECTS) {
      await res.body?.cancel();
      throw new Error(
        `Registry request for ${url} exceeded the limit of ${MAX_REDIRECTS} redirects.`,
      );
    }
    const location = res.headers.get("location");
    if (!location) throw statusError(currentUrl, res);
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== requestedOrigin) {
      await res.body?.cancel();
      throw new Error(
        `Registry request for ${url} was redirected across origins ` +
          `(${requestedOrigin} → ${nextUrl.origin}). Refusing to follow for safety. ` +
          `If the redirect is legitimate, point NIMBUS_REGISTRY_URL at the final host directly.`,
      );
    }
    await res.body?.cancel();
    currentUrl = nextUrl.href;
  }
}

function contentType(res: Response): string {
  return (res.headers.get("content-type") ?? "").toLowerCase();
}

async function readText(
  res: Response,
  url: string,
  label: string,
  maxBytes: number,
): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel();
    throw new Error(
      `Registry ${label} at ${url} exceeds the ${maxBytes} byte size limit (Content-Length: ${declared}).`,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(
          `Registry ${label} at ${url} exceeds the ${maxBytes} byte size limit.`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message.includes("byte size limit")) {
      throw error;
    }
    throw transportError(url, error);
  }
}

async function fetchJson(
  url: string,
  label: string,
  maxBytes: number,
): Promise<unknown> {
  const res = await httpGet(url, "application/json");
  if (contentType(res).includes("text/html")) {
    throw new Error(
      `Expected JSON ${label} from ${url} but the server returned HTML. The registry host is likely serving an error or fallback page.`,
    );
  }
  const text = await readText(res, url, label, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Registry ${label} at ${url} was not valid JSON.`);
  }
}

export async function fetchComponent(
  slug: string,
  expected?: RegistryIndexEntry,
): Promise<ComponentItem> {
  const url = `${getBaseUrl()}/components/${slug}.json`;
  const data = await fetchJson(
    url,
    `component response for "${slug}"`,
    COMPONENT_MAX_BYTES,
  );

  const parsed = componentItemSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Registry payload for "${slug}" failed validation:\n` +
        formatZodIssues(parsed.error),
    );
  }
  if (parsed.data.name !== slug) {
    throw new Error(
      `Registry payload name "${parsed.data.name}" does not match requested slug "${slug}".`,
    );
  }
  if (expected && parsed.data.type !== expected.type) {
    throw new Error(
      `Registry payload type "${parsed.data.type}" for "${slug}" does not match index type "${expected.type}".`,
    );
  }
  return parsed.data;
}

export async function fetchFeatureMarkdown(slug: string): Promise<string> {
  const url = `${getBaseUrl()}/features/${slug}.md`;
  const res = await httpGet(url, "text/markdown");

  // Features pipe straight into a coding agent; markdown can't be schema-
  // checked, so at least reject an HTML error page posing as the feature.
  if (contentType(res).includes("text/html")) {
    throw new Error(
      `Expected markdown for "${slug}" from ${url} but the server returned HTML. ` +
        `The registry host is likely serving an error or fallback page.`,
    );
  }

  return await readText(res, url, `feature markdown for "${slug}"`, FEATURE_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// Transitive dep resolution
// ---------------------------------------------------------------------------

/**
 * Depth-first walk of registryDependencies. Returns items in install order
 * (deps before dependents), deduplicated by slug.
 */
export async function resolveComponentTree(
  rootSlug: string,
  rootEntry?: RegistryIndexEntry,
  initialIndex?: Record<string, RegistryIndexEntry>,
): Promise<ComponentItem[]> {
  const visited = new Set<string>();
  const ordered: ComponentItem[] = [];
  const entries = new Map<string, RegistryIndexEntry>();
  let liveIndexItems: Promise<Record<string, RegistryIndexEntry>> | undefined =
    initialIndex ? Promise.resolve(initialIndex) : undefined;
  if (rootEntry) entries.set(rootSlug, rootEntry);

  async function entryFor(slug: string): Promise<RegistryIndexEntry> {
    const cached = entries.get(slug) ?? getIndexEntry(slug);
    if (cached) return cached;
    liveIndexItems ??= fetchLiveIndexItems();
    const entry = (await liveIndexItems)[slug];
    if (!entry) throw unknownRegistryItemError(slug);
    return entry;
  }

  async function visit(slug: string): Promise<void> {
    if (visited.has(slug)) return;
    visited.add(slug);

    const entry = await entryFor(slug);
    entries.set(slug, entry);
    if (entry.type === "registry:feature") {
      throw new Error(
        `Registry component "${slug}" cannot depend on feature "${entry.name}".`,
      );
    }
    const item = await fetchComponent(slug, entry);

    // Walk deps first so they're earlier in the install order.
    for (const dep of item.registryDependencies) {
      await visit(dep);
    }

    ordered.push(item);
  }

  await visit(rootSlug);
  return ordered;
}
