import type { ApiNav, ApiPageProps } from "./api/api-view-types.js";

type ConfiguredApiPageProjector = (
  collection: string,
  version: string | null,
  coordinate: string,
) => Promise<{ page: ApiPageProps; nav: ApiNav }>;

type ConfiguredApiPagePropsProjector = (
  collection: string,
  version: string | null,
  coordinate: string,
) => Promise<ApiPageProps>;

type ConfiguredApiNavProjector = (
  collection: string,
  version: string | null,
  coordinate: string,
) => Promise<ApiNav>;

export interface ConfiguredApiProjectors {
  /** Complete HTML page: highlighted code plus active navigation. */
  page: ConfiguredApiPageProjector;
  /** Page props without code highlighting or navigation, for Markdown. */
  pageProps: ConfiguredApiPagePropsProjector;
  /** A page's navigation alone, without projecting the page. */
  nav: ConfiguredApiNavProjector;
}

interface ApiProjectorState {
  version: 1;
  projectors?: ConfiguredApiProjectors;
}

const STATE_KEY = Symbol.for("@cloudflare/nimbus-docs/api-projector/v1");
const stateGlobal = globalThis as typeof globalThis & {
  [STATE_KEY]?: ApiProjectorState;
};
const state = (stateGlobal[STATE_KEY] ??= { version: 1 });

export function registerConfiguredApiProjector(
  projectors: ConfiguredApiProjectors,
): void {
  state.projectors = projectors;
}

function configuredProjectors(): ConfiguredApiProjectors {
  if (!state.projectors) {
    throw new Error(
      "nimbus-docs: API projection is available only during a configured Astro build or dev server.",
    );
  }
  return state.projectors;
}

export function projectConfiguredApiPage(
  collection: string,
  version: string | null,
  coordinate: string,
): Promise<{ page: ApiPageProps; nav: ApiNav }> {
  return configuredProjectors().page(collection, version, coordinate);
}

/**
 * Project page props for Markdown consumers. Markdown renders code from its
 * source, so skipping highlighting and navigation keeps the `.md` route and
 * `llms-full.txt` from repeating the HTML route's most expensive work.
 */
export function projectConfiguredApiPageProps(
  collection: string,
  version: string | null,
  coordinate: string,
): Promise<ApiPageProps> {
  return configuredProjectors().pageProps(collection, version, coordinate);
}

/** A page's navigation, as `projectConfiguredApiPage` gives it, without the page. */
export function projectConfiguredApiNav(
  collection: string,
  version: string | null,
  coordinate: string,
): Promise<ApiNav> {
  return configuredProjectors().nav(collection, version, coordinate);
}
