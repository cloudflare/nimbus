import { apiCoordinate, webhookCoordinate } from "./coordinates.js";
import { pointer } from "./pointer.js";
import { HTTP_METHODS } from "./openapi-types.js";
import { assembleOperation, warnOrderPlace } from "./operations.js";
import type { ParseContext } from "./parse-context.js";

export function parseWebhooks(ctx: ParseContext): void {
  for (const [key, item] of Object.entries(ctx.doc.webhooks ?? {})) {
    if (item === null || typeof item !== "object") continue;
    const coord = webhookCoordinate(key);
    ctx.registry.register(coord, "operation", {
      source: pointer("webhooks", key),
      isUserIdentity: true,
    });
    const sharedParams = Array.isArray(item.parameters) ? item.parameters : [];
    // Webhooks route by their map key, not their id — but record every method's
    // id so a `routes.operations` override keyed by one is named as a
    // non-overridable webhook rather than reported as a typo. Runs across all
    // methods, independent of the single-page `break` below.
    if ("x-nimbus-order" in item) warnOrderPlace(ctx, pointer("webhooks", key, "x-nimbus-order"));
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op && typeof op === "object" && "x-nimbus-order" in op) {
        warnOrderPlace(ctx, pointer("webhooks", key, method, "x-nimbus-order"));
      }
      if (op && typeof op.operationId === "string" && op.operationId) {
        ctx.noteWebhookOperationId(op.operationId, key);
      }
    }
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      // A webhook is delivered to the subscriber, not called against a base
      // URL, so `sampleTarget` is omitted — no server, no `curl` — but the
      // request/response contract is assembled identically to an operation.
      const facts = assembleOperation(ctx, {
        coord,
        op,
        sourceBase: pointer("webhooks", key, method),
        protocol: { method: method.toUpperCase(), webhook: key },
        rawOp: ctx.resolver.rawWebhook(key, method),
        rawSharedParams: ctx.resolver.rawWebhookParameters(key),
        sharedParams,
      });
      ctx.node(coord, "operation", apiCoordinate(ctx.collection), facts, pointer("webhooks", key));
      ctx.page(coord, `webhooks/${key}`);
      break;
    }
  }
}
