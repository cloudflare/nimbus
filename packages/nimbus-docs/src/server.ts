/** Framework-owned request audience contract for content projection. */

import { PUBLIC_AUDIENCE, resolveAudience } from "./_internal/projection.js";
import type { Audience, ProjectionContext } from "./_internal/projection.js";

export type { Audience, ProjectionContext };
export { PUBLIC_AUDIENCE, resolveAudience };

export interface NimbusLocals {
  audience: Audience;
}

interface AudienceCarrier {
  nimbus?: { audience?: Audience };
}

/**
 * The framework-guaranteed audience for a request. Reads
 * `Astro.locals.nimbus.audience` and falls back to the public floor, so
 * projection is safe whether or not the starter middleware ran.
 */
export function getAudience(locals?: AudienceCarrier): Audience {
  return locals?.nimbus?.audience ?? PUBLIC_AUDIENCE;
}

declare global {
  namespace App {
    interface Locals {
      nimbus?: NimbusLocals;
    }
  }
}
