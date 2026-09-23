import type { ApiNav, ApiPageProps } from "./api/api-view-types.js";

type ConfiguredApiProjector = (
  collection: string,
  version: string | null,
  coordinate: string,
) => Promise<{ page: ApiPageProps; nav: ApiNav }>;

interface ApiProjectorState {
  version: 1;
  projectConfiguredApiPage?: ConfiguredApiProjector;
}

const STATE_KEY = Symbol.for("@cloudflare/nimbus-docs/api-projector/v1");
const stateGlobal = globalThis as typeof globalThis & {
  [STATE_KEY]?: ApiProjectorState;
};
const state = (stateGlobal[STATE_KEY] ??= { version: 1 });

export function registerConfiguredApiProjector(
  projector: ConfiguredApiProjector,
): void {
  state.projectConfiguredApiPage = projector;
}

export function projectConfiguredApiPage(
  collection: string,
  version: string | null,
  coordinate: string,
): Promise<{ page: ApiPageProps; nav: ApiNav }> {
  if (!state.projectConfiguredApiPage) {
    throw new Error(
      "nimbus-docs: API projection is available only during a configured Astro build or dev server.",
    );
  }
  return state.projectConfiguredApiPage(collection, version, coordinate);
}
