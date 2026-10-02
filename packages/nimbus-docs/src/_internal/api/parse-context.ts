import type { FieldSink } from "./field-walk.js";
import type { OpenApiDocument } from "./openapi-types.js";
import type { SampleTools } from "./samples.js";
import type { Coordinate, RouteProvenance } from "./model.js";
import type { RoutePolicy } from "./route-policy.js";

// The shared write-surface the parse passes (operations/schemas/webhooks) drive,
// implemented by Walker. Read-context plus the node/page/nav verbs — never the
// accumulation stores. Lives on its own as a contract shared by all three passes.
export interface ParseContext extends FieldSink {
  readonly collection: string;
  readonly doc: OpenApiDocument;
  readonly firstServer?: string;
  readonly sampleTools: SampleTools | null;
  readonly requireOperationId: boolean;
  /** The active route convention, or `undefined` for legacy operationId URLs. */
  readonly routePolicy?: RoutePolicy;
  /** Publish a page per schema. When false, schemas are still parsed and their
   *  identities still claim their slugs, but no page is emitted. */
  readonly schemaPages: boolean;
  page(coord: Coordinate, slug: string, provenance?: RouteProvenance): void;
  attachToNav(tag: string | undefined, coord: Coordinate, label: string): void;
  ensureSection(tag: string, description?: string, page?: boolean): void;
  /** Record how an operation's slug was resolved (`resource-action-v1` provenance). */
  recordRouteProvenance(coord: Coordinate, provenance: RouteProvenance): void;
  /** Mark an `operations` override key as consumed, so an unused key is caught. */
  noteOverrideConsumed(operationId: string): void;
  /** Record a webhook operation's `operationId` alongside its map key, so an
   *  override keyed by it is named as a non-overridable webhook, not a typo. */
  noteWebhookOperationId(operationId: string, webhookKey: string): void;
}
