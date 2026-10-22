import type { ApiAuthView, ApiFieldView } from "@cloudflare/nimbus-docs/api";

function authTypeLabel(a: ApiAuthView): string {
  if (a.type === "http") {
    // `ApiAuthView` doesn't carry the HTTP sub-scheme (basic vs bearer), and a
    // bearer token needn't declare a format — so only claim Bearer when a
    // `bearerFormat` proves it; otherwise stay generic rather than mislabel.
    return a.bearerFormat ? `HTTP Bearer (${a.bearerFormat})` : "HTTP";
  }
  if (a.type === "apiKey") return `API key${a.in ? ` in ${a.in}` : ""}`;
  if (a.type === "oauth2") return "OAuth 2.0";
  if (a.type === "openIdConnect") return "OpenID Connect";
  if (a.type === "mutualTLS") return "Mutual TLS";
  return a.type ?? a.scheme;
}

function authExample(a: ApiAuthView): string | null {
  if (!a.headerName) return null;
  const prefix = a.type === "http" && a.bearerFormat ? "Bearer " : "";
  return `${a.headerName}: ${prefix}<token>`;
}

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
  const parts = [
    example ? `\`${example}\`` : "",
    scopes.length > 0 ? `Scopes: ${scopes.map((s) => `\`${s}\``).join(", ")}` : "",
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
    description: parts.length > 0 ? parts.join(" · ") : undefined,
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
