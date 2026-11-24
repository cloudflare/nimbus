/** The Try it details an operation page carries: never the plan itself, which loads on click. */
import type { DeliveryMode, RequestPlan, TryItInfo, TryItSource } from "./plan.js";

/** Where staged plans are served, relative to the site's base. */
export const PLAN_PREFIX = "/_nimbus/try-it/";

export function tryItInfo(plan: RequestPlan, file: string, source: TryItSource): TryItInfo {
  const unavailable = unavailableDelivery(plan, source.proxy);
  const blocked = new Set(unavailable.map((u) => u.delivery));
  // The default first: the proxy, unless direct carries the API's own cookies.
  const order: DeliveryMode[] = source.credentials === "include" ? ["direct", "proxy"] : ["proxy", "direct"];
  const info: TryItInfo = {
    kind: "http-request",
    planId: plan.id,
    planUrl: `${PLAN_PREFIX}${file}`,
    deliveryModes: order.filter((mode) => !blocked.has(mode)),
  };
  if (unavailable.length > 0) info.unavailable = unavailable;
  return info;
}

/** Why each delivery mode can't send this plan at all, known at build time. */
export function unavailableDelivery(plan: RequestPlan, proxy: boolean): { delivery: DeliveryMode; reason: string }[] {
  const out: { delivery: DeliveryMode; reason: string }[] = [];
  const cookieParam = plan.params.some((p) => p.in === "cookie" && p.required);
  const cookieAuth =
    plan.auth.length > 0 && plan.auth.every((a) => a.schemes.some((s) => s.type === "apiKey" && s.in === "cookie"));
  if (cookieParam || cookieAuth) out.push({ delivery: "direct", reason: "Direct: cookie parameters can't be sent from a browser." });
  if (!proxy) out.push({ delivery: "proxy", reason: "Via this site: the proxy is off for this API." });
  return out;
}
