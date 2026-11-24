import type { ApiAuthView, ApiFieldView } from "@cloudflare/nimbus-docs/api";

function authTypeLabel(a: ApiAuthView): string {
  if (a.type === "http") {
    if (a.httpScheme === "bearer") return a.bearerFormat ? `HTTP Bearer (${a.bearerFormat})` : "HTTP Bearer";
    if (a.httpScheme === "basic") return "HTTP Basic";
    return "HTTP";
  }
  if (a.type === "apiKey") return `API key${a.in ? ` in ${a.in}` : ""}`;
  if (a.type === "oauth2") return "OAuth 2.0";
  if (a.type === "openIdConnect") return "OpenID Connect";
  if (a.type === "mutualTLS") return "Mutual TLS";
  return a.type ?? a.scheme;
}

function authExample(a: ApiAuthView): string | null {
  if (!a.headerName) return null;
  if (a.type === "http" && a.httpScheme === "bearer") return `${a.headerName}: Bearer <token>`;
  if (a.type === "http" && a.httpScheme === "basic") return `${a.headerName}: Basic <credentials>`;
  return `${a.headerName}: <token>`;
}

/** `value` as text in HTML. The row renders `descriptionHtml` as is, and a
 *  scope or header name is the spec's text, not markup. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;

// OpenAPI restricts scheme keys to [A-Za-z0-9._-]; belt-and-braces for a
// non-conformant spec.
const authAnchor = (scheme: string): string =>
  `auth-${scheme.replace(/[^A-Za-z0-9._-]/g, "-")}`;

interface AuthAgg {
  view: ApiAuthView;
  scopes: Set<string>;
  required: boolean;
}

function toField(agg: AuthAgg): ApiFieldView {
  const a = agg.view;
  const scopes = [...agg.scopes];
  const example = authExample(a);
  // Built as HTML here rather than rendered from Markdown: this file runs where
  // the page renders, which on a request-rendered site is the server bundle.
  const parts = [
    example ? code(example) : "",
    scopes.length > 0 ? `Scopes: ${scopes.map(code).join(", ")}` : "",
  ].filter(Boolean);
  return {
    coordinate: `auth:${a.scheme}`,
    name: a.scheme,
    type: authTypeLabel(a),
    required: agg.required,
    anchor: authAnchor(a.scheme),
    children: [],
    childCount: 0,
    truncated: false,
    descriptionHtml: parts.length > 0 ? `<p>${parts.join(" · ")}</p>` : undefined,
  };
}

// Every distinct scheme across the alternatives as one field list. `auth` is
// `ApiAuthView[][]` (outer OR, inner AND): a scheme is `required` only when it
// appears in EVERY alternative, and scopes are unioned. First-seen order.
export function authFields(auth: ApiAuthView[][]): ApiFieldView[] {
  const order: string[] = [];
  const byScheme = new Map<string, AuthAgg>();
  for (const alt of auth) {
    for (const a of alt) {
      let agg = byScheme.get(a.scheme);
      if (!agg) {
        agg = { view: a, scopes: new Set(), required: true };
        byScheme.set(a.scheme, agg);
        order.push(a.scheme);
      }
      for (const s of a.scopes) agg.scopes.add(s);
    }
  }
  for (const [scheme, agg] of byScheme) {
    agg.required = auth.every((alt) => alt.some((a) => a.scheme === scheme));
  }
  return order.map((s) => toField(byScheme.get(s)!));
}
