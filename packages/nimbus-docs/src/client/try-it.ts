/**
 * Try it's client API: what an owner-written panel builds on. OpenAPI
 * outbound HTTP only; another protocol brings its own.
 */
import type { RequestPlan, TryItInfo } from "../_internal/try-it/plan.js";

export { serializeRequest } from "../_internal/try-it/serialize.js";
export { renderSample, maskText } from "../_internal/try-it/render.js";
export { sendRequest, isTextMedia } from "../_internal/try-it/send.js";
export { validateValues, checkParam } from "../_internal/try-it/validate.js";
export { paramKey } from "../_internal/try-it/plan.js";
export type {
  Credential,
  DeliveryMode,
  FormValues,
  HttpBody,
  HttpPart,
  HttpRequest,
  JsonValue,
  PlanAuth,
  PlanAuthAlternative,
  PlanBody,
  PlanBodyField,
  PlanId,
  PlanMedia,
  PlanParam,
  PlanSchema,
  PlanServer,
  RequestPlan,
  RequestValues,
  TryItInfo,
} from "../_internal/try-it/plan.js";
export type { SendOutcome, SendFailure, SendOptions } from "../_internal/try-it/send.js";
export type { SampleLang } from "../_internal/try-it/render.js";
export type { Issue } from "../_internal/try-it/validate.js";

/** Fetch an operation page's request plan. `base` is the site's base path (`import.meta.env.BASE_URL`). */
export async function loadRequestPlan(page: { tryIt?: TryItInfo }, options: { base?: string; signal?: AbortSignal } = {}): Promise<RequestPlan> {
  if (!page.tryIt) throw new Error("This operation has no Try it plan.");
  const base = (options.base ?? "/").replace(/\/+$/, "");
  const response = await fetch(`${base}${page.tryIt.planUrl}`, { ...(options.signal ? { signal: options.signal } : {}) });
  if (!response.ok) throw new Error(`Couldn't load the request form (${response.status}).`);
  return (await response.json()) as RequestPlan;
}
