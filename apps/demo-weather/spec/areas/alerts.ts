/**
 * Alerts. v1 had its own three-level format; v2 adopted the Common Alerting
 * Protocol's fields and added webhook subscriptions.
 */

import {
  arr,
  bool,
  enm,
  int,
  lat,
  list,
  lon,
  nullable,
  num,
  obj,
  op,
  paging,
  path,
  paths,
  query,
  ref,
  str,
  time,
  type Area,
  type PathEntry,
  type Schema,
  type Version,
} from "../lib";

const EVENTS = ["alert.issued", "alert.updated", "alert.cancelled", "alert.expired"];

export function alerts(v: Version): Area {
  const tag = "Alerts";
  const schemas: Record<string, Schema> = {};

  if (v === 1) {
    schemas.Alert = obj(
      {
        id: str("Alert id.", "a-20260114-0042"),
        level: enm("Alert level.", ["advisory", "watch", "warning"], "warning"),
        title: str("Headline.", "Heavy snow warning for Oslo and Akershus"),
        description: str("Full text.", "15–25 cm of snow expected between 18:00 and 06:00…"),
        regions: arr(str("", "Oslo")),
        starts: time("Start.", "2026-01-14T17:00:00Z"),
        expires: time("End.", "2026-01-15T05:00:00Z"),
      },
      ["id", "level", "title", "starts", "expires"],
      "A weather alert.",
    );
  } else {
    const base = {
      id: str("Alert id.", "alt_20260114_0042"),
      status: enm("CAP status.", ["actual", "exercise", "test"], "actual"),
      severity: enm("CAP severity.", ["minor", "moderate", "severe", "extreme"], "severe"),
      urgency: enm("CAP urgency.", ["immediate", "expected", "future", "past"], "expected"),
      certainty: enm("CAP certainty.", ["observed", "likely", "possible", "unlikely"], "likely"),
      headline: str("Headline.", "Heavy snow warning for Oslo and Akershus"),
      description: str("Full text.", "15–25 cm of snow expected between 18:00 and 06:00, locally more on high ground."),
      instruction: nullable(str("What people should do.", "Allow extra time for travel. Public transport may be disrupted.")),
      sender: str("Issuing agency.", "Norwegian Meteorological Institute"),
      areas: arr(ref("AlertArea")),
      onset: time("When the hazard begins.", "2026-01-14T17:00:00Z"),
      expires: time("When the alert ends.", "2026-01-15T05:00:00Z"),
      references: arr(str("", "alt_20260114_0031"), "Earlier alerts this one updates or cancels."),
    };
    const kind = (event: string, details: Record<string, Schema>, example: string) =>
      obj(
        { event: enm("Hazard.", [event]), ...base, details: obj(details, Object.keys(details)) },
        ["event", "id", "severity", "headline", "areas", "onset", "expires"],
        example,
      );
    schemas.AlertArea = obj(
      {
        zone_id: str("Zone id.", "zone_no_03"),
        name: str("Zone name.", "Oslo"),
        geometry: obj({ type: str("GeoJSON type.", "Polygon"), coordinates: arr(arr(arr(num("", 10.7)))) }, ["type", "coordinates"], "GeoJSON geometry."),
      },
      ["zone_id", "name"],
    );
    schemas.WinterStormAlert = kind("winter_storm", {
      snowfall_cm: obj({ min: num("", 15), max: num("", 25) }),
      ice_accretion_mm: nullable(num("", 0)),
    }, "Snow, ice, and blizzard alerts.");
    schemas.FloodAlert = kind("flood", {
      river: nullable(str("Affected river.", "Glomma")),
      expected_crest_m: nullable(num("Expected crest above flood stage.", 1.4)),
    }, "River, coastal, and flash flood alerts.");
    schemas.HeatAlert = kind("heat", {
      max_heat_index: num("Highest expected heat index.", 41),
      overnight_low: num("Expected overnight low.", 27),
    }, "Extreme heat alerts.");
    schemas.WindAlert = kind("wind", {
      gust_max: num("Highest expected gust, m/s.", 32),
    }, "High wind and storm alerts.");
    schemas.Alert = {
      oneOf: [ref("WinterStormAlert"), ref("FloodAlert"), ref("HeatAlert"), ref("WindAlert")],
      discriminator: {
        propertyName: "event",
        mapping: {
          winter_storm: "#/components/schemas/WinterStormAlert",
          flood: "#/components/schemas/FloodAlert",
          heat: "#/components/schemas/HeatAlert",
          wind: "#/components/schemas/WindAlert",
        },
      },
      description: "A weather alert. The `event` field says which shape `details` has.",
    };
    schemas.Subscription = obj(
      {
        id: str("Subscription id.", "sub_8Jd2"),
        url: str("HTTPS endpoint that receives events.", "https://example.com/hooks/weather"),
        events: arr(enm("", EVENTS, "alert.issued")),
        zones: arr(str("", "zone_no_03"), "Only alerts touching these zones. Empty means everywhere."),
        min_severity: enm("Only alerts at or above this severity.", ["minor", "moderate", "severe", "extreme"], "moderate"),
        active: bool("Whether events are being delivered.", true),
        created_at: time("", "2025-09-02T10:14:00Z"),
      },
      ["id", "url", "events", "active"],
      "A webhook subscription to alert events.",
    );
    schemas.AlertEvent = obj(
      {
        id: str("Event id. Deliveries can repeat; deduplicate on this.", "evt_3Lw9pQ"),
        type: enm("Event type.", EVENTS, "alert.issued"),
        created_at: time("", "2026-01-14T09:02:11Z"),
        alert: ref("Alert"),
      },
      ["id", "type", "created_at", "alert"],
    );
  }

  const subscriptionPaths: PathEntry[] = v >= 2
    ? [
        ["/alerts/subscriptions", "get", op(tag, {
          id: "listSubscriptions",
          summary: "List subscriptions",
          params: paging(v),
          responses: { "200": list(v, ref("Subscription"), "Subscriptions.") },
        })],
        ["/alerts/subscriptions", "post", op(tag, {
          id: "createSubscription",
          summary: "Subscribe to alerts",
          description: "Events are signed with your webhook secret. See the Webhooks guide for verifying them.",
          body: obj(
            {
              url: str("", "https://example.com/hooks/weather"),
              events: arr(enm("", EVENTS, "alert.issued")),
              zones: arr(str("", "zone_no_03")),
              min_severity: enm("", ["minor", "moderate", "severe", "extreme"], "moderate"),
            },
            ["url", "events"],
          ),
          responses: { "201": ref("Subscription") },
        })],
        ["/alerts/subscriptions/{subscription_id}", "get", op(tag, {
          id: "getSubscription",
          summary: "Get a subscription",
          params: [path("subscription_id", "Subscription id.", "sub_8Jd2")],
          responses: { "200": ref("Subscription") },
        })],
        ["/alerts/subscriptions/{subscription_id}", "patch", op(tag, {
          id: "updateSubscription",
          summary: "Update a subscription",
          params: [path("subscription_id", "Subscription id.", "sub_8Jd2")],
          body: obj({ active: bool("", false), min_severity: enm("", ["minor", "moderate", "severe", "extreme"], "severe") }),
          responses: { "200": ref("Subscription") },
        })],
        ["/alerts/subscriptions/{subscription_id}", "delete", op(tag, {
          id: "deleteSubscription",
          summary: "Delete a subscription",
          params: [path("subscription_id", "Subscription id.", "sub_8Jd2")],
          responses: { "204": null },
        })],
        ["/alerts/subscriptions/{subscription_id}/test", "post", op(tag, {
          id: "sendTestEvent",
          summary: "Send a test event",
          description: "Delivers a sample `alert.issued` event with `status: test`.",
          params: [path("subscription_id", "Subscription id.", "sub_8Jd2")],
          responses: { "202": obj({ delivery_id: str("", "dlv_0aP3") }) },
        })],
      ]
    : [];

  const webhook = (event: string, summary: string) => ({
    post: {
      operationId: `on${event.split(".")[1]!.replace(/^./, (c) => c.toUpperCase())}Alert`,
      summary,
      tags: [tag],
      requestBody: { required: true, content: { "application/json": { schema: ref("AlertEvent") } } },
      parameters: [
        { name: "Webhook-Signature", in: "header", required: true, description: "HMAC-SHA256 of the timestamp and body, with your webhook secret.", schema: { type: "string", example: "t=1768381331,v1=5257a869e7ec…" } },
      ],
      responses: { "200": { description: "Return any 2xx within 10 seconds, or the delivery is retried." } },
    },
  });

  return {
    group: "Weather",
    tag: { name: tag, description: "Official warnings for severe weather." },
    schemas,
    ...(v >= 2
      ? {
          webhooks: {
            alertIssued: webhook("alert.issued", "Alert issued"),
            alertUpdated: webhook("alert.updated", "Alert updated"),
            alertCancelled: webhook("alert.cancelled", "Alert cancelled"),
            alertExpired: webhook("alert.expired", "Alert expired"),
          },
        }
      : {}),
    paths: paths([
      ["/alerts", "get", op(tag, {
        id: v === 1 ? "listAlerts" : "listActiveAlerts",
        summary: v === 1 ? "List alerts" : "List active alerts",
        params: [
          query("country", "ISO 3166-1 alpha-2 country code.", str("", "NO")),
          ...(v === 1
            ? [query("level", "Minimum level.", enm("", ["advisory", "watch", "warning"]))]
            : [
                query("severity", "Minimum severity.", enm("", ["minor", "moderate", "severe", "extreme"])),
                query("event", "Only this hazard.", enm("", ["winter_storm", "flood", "heat", "wind"])),
              ]),
          ...paging(v),
        ],
        responses: { "200": list(v, ref("Alert"), "Alerts in effect.") },
      })],
      ["/alerts/{alert_id}", "get", op(tag, {
        id: "getAlert",
        summary: "Get an alert",
        params: [path("alert_id", "Alert id.", v === 1 ? "a-20260114-0042" : "alt_20260114_0042")],
        responses: { "200": ref("Alert") },
      })],
      ["/alerts/point", "get", op(tag, {
        id: "listAlertsForPoint",
        summary: "List alerts for a point",
        params: [lat(v), lon(v)],
        responses: { "200": arr(ref("Alert")) },
      })],
      v >= 2 && ["/alerts/zones", "get", op(tag, {
        id: "listZones",
        summary: "List alert zones",
        params: [query("country", "ISO 3166-1 alpha-2 country code.", str("", "NO"), true), ...paging(v)],
        responses: { "200": list(v, obj({ id: str("", "zone_no_03"), name: str("", "Oslo"), kind: enm("", ["county", "forecast_zone", "marine_zone", "fire_zone"], "county") }), "Zones.") },
      })],
      v >= 2 && ["/alerts/zones/{zone_id}", "get", op(tag, {
        id: "getZone",
        summary: "Get an alert zone",
        params: [path("zone_id", "Zone id.", "zone_no_03")],
        responses: { "200": ref("AlertArea") },
      })],
      v >= 2 && ["/alerts/history", "get", op(tag, {
        id: "listPastAlerts",
        summary: "List past alerts",
        description: "Alerts that have expired or been cancelled, back to 2015.",
        params: [
          query("zone", "Zone id.", str("", "zone_no_03")),
          query("start", "Earliest onset.", time("", "2025-01-01T00:00:00Z"), true),
          query("end", "Latest onset.", time("", "2025-12-31T23:59:59Z")),
          ...paging(v),
        ],
        responses: { "200": list(v, ref("Alert"), "Past alerts.") },
      })],
      ...subscriptionPaths,
      v >= 2 && ["/alerts/subscriptions/{subscription_id}/deliveries", "get", op(tag, {
        id: "listDeliveries",
        summary: "List deliveries",
        description: "Every attempt to deliver an event to this subscription in the last 30 days.",
        params: [path("subscription_id", "Subscription id.", "sub_8Jd2"), ...paging(v)],
        responses: {
          "200": list(v, obj({
            id: str("", "dlv_0aP3"),
            event_id: str("", "evt_3Lw9pQ"),
            status_code: nullable(int("Your endpoint's response.", 200)),
            attempt: int("", 1),
            delivered_at: time("", "2026-01-14T09:02:12Z"),
            duration_ms: int("", 184),
          }), "Deliveries."),
        },
      })],
      v >= 2 && ["/alerts/subscriptions/{subscription_id}/deliveries/{delivery_id}/retry", "post", op(tag, {
        id: "retryDelivery",
        summary: "Retry a delivery",
        params: [path("subscription_id", "Subscription id.", "sub_8Jd2"), path("delivery_id", "Delivery id.", "dlv_0aP3")],
        responses: { "202": null },
      })],
    ]),
  };
}

