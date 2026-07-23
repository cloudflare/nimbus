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

export interface RegistryFile {
  path: string;
  content: string;
}

export interface ComponentItem {
  name: string;
  type: "registry:ui" | "registry:lib";
  title: string;
  description: string;
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

const registryFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();

const componentItemSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["registry:ui", "registry:lib"]),
    title: z.string(),
    description: z.string(),
    dependencies: z.array(
      z
        .string()
        .regex(NPM_NAME_RE, "is not a valid npm package name"),
    ),
    registryDependencies: z.array(
      z.string().regex(SLUG_RE, "is not a valid registry slug"),
    ),
    files: z.array(registryFileSchema),
  })
  .strict();

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
  return BUNDLED_INDEX.items[slug];
}

export function listEntries(filter?: {
  type?: RegistryIndexEntry["type"];
}): RegistryIndexEntry[] {
  const all = Object.values(BUNDLED_INDEX.items);
  if (!filter?.type) return all;
  return all.filter((e) => e.type === filter.type);
}

// ---------------------------------------------------------------------------
// Network: component JSON + feature markdown
// ---------------------------------------------------------------------------

async function httpGet(url: string, accept: string): Promise<Response> {
  maybeWarnOverride();

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept } });
  } catch (err) {
    const cause = (err as Error).message;
    throw new Error(
      `Could not reach the registry at ${url}.\n` +
        `  Underlying error: ${cause}\n\n` +
        `  Things to try:\n` +
        `    - Set the registry URL: NIMBUS_REGISTRY_URL=https://example.com nimbus-docs add ...\n` +
        `    - Check the value in your project's .env file.\n` +
        `    - Working in the Nimbus monorepo? Start the local registry with \`pnpm local\`.`,
    );
  }

  // Refuse cross-origin redirects: fetch follows redirects by default, and a
  // redirect onto another origin means we're no longer talking to the registry.
  const requestedOrigin = new URL(url).origin;
  const finalOrigin = new URL(res.url || url).origin;
  if (finalOrigin !== requestedOrigin) {
    throw new Error(
      `Registry request for ${url} was redirected across origins ` +
        `(${requestedOrigin} → ${finalOrigin}). Refusing to follow for safety. ` +
        `If the redirect is legitimate, point NIMBUS_REGISTRY_URL at the final host directly.`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Registry returned ${res.status} ${res.statusText} for ${url}. ` +
        `The server is up but doesn't know about this slug — check \`nimbus-docs list\` for valid names.`,
    );
  }
  return res;
}

function contentType(res: Response): string {
  return (res.headers.get("content-type") ?? "").toLowerCase();
}

export async function fetchComponent(slug: string): Promise<ComponentItem> {
  const url = `${getBaseUrl()}/components/${slug}.json`;
  const res = await httpGet(url, "application/json");

  // A 200 HTML error/fallback page is the usual "not JSON"; name it clearly.
  if (contentType(res).includes("text/html")) {
    throw new Error(
      `Expected JSON for "${slug}" from ${url} but the server returned HTML. ` +
        `The registry host is likely serving an error or fallback page.`,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      `Registry response for "${slug}" (${url}) was not valid JSON.`,
    );
  }

  const parsed = componentItemSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Registry payload for "${slug}" failed validation:\n` +
        formatZodIssues(parsed.error),
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

  return await res.text();
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
): Promise<ComponentItem[]> {
  const visited = new Set<string>();
  const ordered: ComponentItem[] = [];

  async function visit(slug: string): Promise<void> {
    if (visited.has(slug)) return;
    visited.add(slug);

    const item = await fetchComponent(slug);

    // Walk deps first so they're earlier in the install order.
    for (const dep of item.registryDependencies) {
      await visit(dep);
    }

    ordered.push(item);
  }

  await visit(rootSlug);
  return ordered;
}
