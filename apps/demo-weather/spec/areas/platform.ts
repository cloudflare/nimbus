/** Account management: keys, usage, organization, members, audit log. */

import {
  arr,
  bool,
  date,
  enm,
  int,
  list,
  nullable,
  obj,
  op,
  paging,
  path,
  paths,
  props,
  query,
  ref,
  str,
  time,
  type Area,
  type Version,
} from "../lib";

const ROLES = ["owner", "admin", "developer", "billing", "viewer"];
const oauth = [{ oauth2: ["account"] }];

export function platform(v: Version): Area {
  const tag = "Account";
  const keyId = path(v === 1 ? "id" : "key_id", "Key id.", v === 1 ? "4211" : "key_9bR4");
  const key = obj(
    props({
      id: str("Key id.", v === 1 ? "4211" : "key_9bR4"),
      name: str("A label for the key.", "Production"),
      prefix: str("First characters, for recognizing the key in logs.", "wx_live_9bR4"),
      scopes: v === 1 ? undefined : arr(enm("", ["weather:read", "stations:write", "alerts:manage", "exports:create"], "weather:read")),
      allowed_origins: v === 1 ? undefined : arr(str("", "https://example.com"), "Browser origins allowed to use this key. Empty means server-side only."),
      created_at: time("", "2025-03-11T12:00:00Z"),
      last_used_at: nullable(time("", "2026-01-14T07:59:41Z")),
      expires_at: v === 1 ? undefined : nullable(time("", "2026-12-31T23:59:59Z")),
    }),
    ["id", "name", "prefix", "created_at"],
  );
  const created = obj({ key: ref("ApiKey"), secret: str("The full key. Shown only once.", "wx_live_9bR4Tq0sXk1mZp8vYw2c") }, ["key", "secret"]);

  return {
    group: "Platform",
    tag: { name: tag, description: "API keys, usage, and your organization." },
    schemas: props({
      ApiKey: key,
      CreatedApiKey: created,
      Member: v === 1 ? undefined : obj({ id: str("", "usr_2Hc8"), email: str("", "ingrid@example.com"), role: enm("", ROLES, "developer"), joined_at: time("", "2025-04-02T08:30:00Z") }, ["id", "email", "role"]),
    }),
    paths: paths([
      [v === 1 ? "/keys" : "/account/keys", "get", op(tag, {
        id: "listApiKeys", summary: "List API keys", params: v === 1 ? [] : paging(v),
        responses: { "200": v === 1 ? arr(ref("ApiKey")) : list(v, ref("ApiKey"), "Keys.") },
        security: v === 1 ? undefined : oauth,
      })],
      [v === 1 ? "/keys" : "/account/keys", "post", op(tag, {
        id: "createApiKey", summary: "Create an API key",
        body: obj(props({
          name: str("", "Staging"),
          scopes: v === 1 ? undefined : arr(str("", "weather:read")),
          allowed_origins: v === 1 ? undefined : arr(str("", "https://example.com"), "Browser origins allowed to use the key. Leave out for a server-side key."),
          expires_at: v === 1 ? undefined : time("", "2026-12-31T23:59:59Z"),
        }), ["name"]),
        responses: { "201": ref("CreatedApiKey") },
        security: v === 1 ? undefined : oauth,
      })],
      [v === 1 ? "/keys/{id}" : "/account/keys/{key_id}", "delete", op(tag, {
        id: v === 1 ? "deleteApiKey" : "revokeApiKey",
        summary: v === 1 ? "Delete an API key" : "Revoke an API key",
        description: "Requests with the key fail immediately.",
        params: [keyId],
        responses: { "204": null },
        security: v === 1 ? undefined : oauth,
      })],
      v >= 2 && ["/account/keys/{key_id}/rotate", "post", op(tag, {
        id: "rotateApiKey", summary: "Rotate an API key",
        description: "Issue a new secret. The old one keeps working for `grace_period` seconds so you can deploy the change.",
        params: [keyId],
        body: obj({ grace_period: int("Seconds.", 86400, { maximum: 604800 }) }),
        responses: { "200": ref("CreatedApiKey") },
        security: oauth,
      })],
      [v === 1 ? "/usage" : "/account/usage", "get", op(tag, {
        id: "getUsage", summary: "Get usage",
        params: v === 1 ? [] : [query("start_date", "First day.", date("", "2026-01-01")), query("end_date", "Last day.", date("", "2026-01-14")), query("group_by", "Break down by.", enm("", ["day", "key", "product"]))],
        responses: { "200": obj(props({
          period_start: date("", "2026-01-01"),
          period_end: date("", "2026-01-31"),
          calls: int("Billable calls.", 1_482_093),
          included: int("Calls included in your plan.", 2_000_000),
          breakdown: v === 1 ? undefined : arr(obj({ key: str("", "2026-01-13"), calls: int("", 104_221) })),
        })) },
        security: v === 1 ? undefined : oauth,
      })],
      v >= 2 && ["/account/rate-limits", "get", op(tag, {
        id: "getRateLimits", summary: "Get rate limits",
        responses: { "200": arr(obj({ product: str("", "forecasts"), per_second: int("", 50), per_day: int("", 500_000) })) },
        security: oauth,
      })],
      v >= 2 && ["/account/organization", "get", op(tag, {
        id: "getOrganization", summary: "Get your organization",
        responses: { "200": obj({ id: str("", "org_7Tn1"), name: str("", "Nordlys Logistics"), plan: enm("", ["free", "developer", "business", "enterprise"], "business"), created_at: time("", "2024-11-05T09:12:00Z") }) },
        security: oauth,
      })],
      v >= 2 && ["/account/members", "get", op(tag, {
        id: "listMembers", summary: "List members", params: paging(v),
        responses: { "200": list(v, ref("Member"), "Members.") },
        security: oauth,
      })],
      v >= 2 && ["/account/members", "post", op(tag, {
        id: "inviteMember", summary: "Invite a member",
        body: obj({ email: str("", "ola@example.com"), role: enm("", ROLES, "developer") }, ["email", "role"]),
        responses: { "201": ref("Member") },
        security: oauth,
      })],
      v >= 2 && ["/account/members/{member_id}", "patch", op(tag, {
        id: "updateMember", summary: "Change a member's role",
        params: [path("member_id", "Member id.", "usr_2Hc8")],
        body: obj({ role: enm("", ROLES, "admin") }, ["role"]),
        responses: { "200": ref("Member") },
        security: oauth,
      })],
      v >= 2 && ["/account/members/{member_id}", "delete", op(tag, {
        id: "removeMember", summary: "Remove a member",
        params: [path("member_id", "Member id.", "usr_2Hc8")],
        responses: { "204": null },
        security: oauth,
      })],
      v >= 2 && ["/account/audit-log", "get", op(tag, {
        id: "listAuditEvents", summary: "List audit events",
        description: "Changes to keys, members, subscriptions, and private stations, kept for one year.",
        params: [query("actor", "Member id.", str("", "usr_2Hc8")), query("action", "Action.", str("", "key.revoked")), ...paging(v)],
        responses: { "200": list(v, obj({ id: str("", "aud_k2P0"), action: str("", "key.revoked"), actor: str("", "usr_2Hc8"), target: str("", "key_9bR4"), ip: str("", "203.0.113.24"), occurred_at: time("", "2026-01-12T16:40:03Z") }), "Events, newest first.") },
        security: oauth,
      })],
      ["/status", "get", op("Service", {
        id: "getServiceStatus", summary: "Get service status",
        description: "Whether each product is operating normally. No key needed.",
        responses: { "200": obj({
          status: enm("", ["operational", "degraded", "outage"]),
          products: arr(obj({ name: str("", "forecasts"), status: str("", "operational") })),
          updated_at: time("", "2026-01-14T08:00:00Z"),
        }) },
        security: [],
      })],
      v <= 2 && ["/ping", "get", op("Service", {
        id: "ping", summary: "Ping",
        description: v === 2 ? "Kept for v1 clients. Use `GET /status` instead." : "Check that the API is reachable.",
        deprecated: v === 2,
        responses: { "200": obj({ ok: bool("", true) }) },
        security: [],
        extra: v === 2 ? { "x-successor": "getServiceStatus" } : {},
      })],
    ]),
  };
}
