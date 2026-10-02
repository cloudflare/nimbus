import { codeToHtml } from "shiki";

import { defaultCodeTransformers } from "./code-transformers.js";
import type {
  ApiModel,
  ApiNav,
  ApiCodeSampleView,
  ApiExampleView,
  ApiPageProps,
} from "./api/api-view-types.js";
import {
  buildApiModel,
  getApiNav,
  getApiPageProps,
} from "../api/index.js";
import {
  activatePreparedApiNav,
  prepareApiNav,
  type PreparedApiNav,
} from "./api/prepared.js";
import { registerConfiguredApiProjector } from "./api-projector.js";
import { applyApiSidebarMode } from "./api/nav-bounds.js";
import { resolveSpecSource } from "./api/resolve-spec.js";
import { resolveApiFamily, resolveApiVersion } from "./api/resolve-versions.js";
import type { ApiSidebarMode, ApiSpec } from "../types.js";

export {
  clearApiModelCache,
  getApiNav,
  getApiPageIndex,
  getApiPageProps,
  getApiRouteProvenance,
} from "../api/index.js";
export { buildApiModel, resolveSpecSource };
export { apiPageRoute, resolveApiFamily } from "./api/resolve-versions.js";
export { prepareApiNav, preparedApiVersion } from "./api/prepared.js";

/** Where a projected page's navigation is bounded. Omitted = the full tree. */
interface ApiNavBounds {
  sidebar: ApiSidebarMode;
  mountPath: string;
}

const preparedNavCache = new WeakMap<ApiModel, PreparedApiNav>();
const configuredModels = new Map<string, Promise<ApiModel>>();
const configuredBounds = new Map<string, ApiNavBounds>();
let configuredApi: ApiSpec[] = [];
let configuredRoot = "";

function configuredModelKey(collection: string, version: string | null): string {
  return `${collection}\0${version ?? ""}`;
}

export function registerConfiguredApiModel(
  collection: string,
  version: string | null,
  model: ApiModel,
  bounds?: ApiNavBounds,
): void {
  const key = configuredModelKey(collection, version);
  configuredModels.set(key, Promise.resolve(model));
  if (bounds) configuredBounds.set(key, bounds);
  else configuredBounds.delete(key);
}

export function configureApiProjector(
  api: ApiSpec[],
  root: string,
): void {
  configuredApi = api;
  configuredRoot = root;
  configuredModels.clear();
  configuredBounds.clear();
}

function preparedNavOf(model: ApiModel): PreparedApiNav {
  let prepared = preparedNavCache.get(model);
  if (!prepared) {
    prepared = prepareApiNav(getApiNav(model));
    preparedNavCache.set(model, prepared);
  }
  return prepared;
}

function projectedNav(
  model: ApiModel,
  coordinate: string,
  overview: boolean,
  bounds?: ApiNavBounds,
): ApiNav {
  const nav = activatePreparedApiNav(preparedNavOf(model), coordinate);
  return bounds
    ? applyApiSidebarMode(nav, { mode: bounds.sidebar, mountPath: bounds.mountPath, overview })
    : nav;
}

const HIGHLIGHTABLE = new Set([
  "bash",
  "go",
  "java",
  "javascript",
  "json",
  "php",
  "python",
  "ruby",
  "shell",
  "typescript",
  "xml",
  "yaml",
]);

function sampleLanguage(lang: string): string {
  if (lang === "curl") return "bash";
  return HIGHLIGHTABLE.has(lang) ? lang : "text";
}

function exampleSource(example: ApiExampleView): string {
  return typeof example.value === "string" && !example.mediaType.includes("json")
    ? example.value
    : JSON.stringify(example.value, null, 2);
}

async function highlight(code: string, lang: string): Promise<string> {
  return codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    transformers: defaultCodeTransformers({ classTokens: true }),
  });
}

async function prepareExample<T extends ApiExampleView>(example: T): Promise<T> {
  return {
    ...example,
    highlightedHtml: await highlight(
      exampleSource(example),
      example.mediaType.includes("json") ? "json" : "text",
    ),
  };
}

async function prepareSample(
  sample: ApiCodeSampleView,
): Promise<ApiCodeSampleView> {
  return {
    ...sample,
    highlightedHtml: await highlight(sample.source, sampleLanguage(sample.lang)),
  };
}

export async function prepareApiPageCode(
  page: ApiPageProps,
): Promise<ApiPageProps> {
  if (page.kind !== "operation") return page;
  return {
    ...page,
    ...(page.example ? { example: await prepareExample(page.example) } : {}),
    ...(page.requestExamples
      ? {
          requestExamples: await Promise.all(
            page.requestExamples.map(prepareExample),
          ),
        }
      : {}),
    samples: await Promise.all(page.samples.map(prepareSample)),
    ...(page.additionalBodies
      ? {
          additionalBodies: await Promise.all(
            page.additionalBodies.map(async (body) => ({
              ...body,
              ...(body.example
                ? { example: await prepareExample(body.example) }
                : {}),
            })),
          ),
        }
      : {}),
    responses: await Promise.all(
      page.responses.map(async (response) => ({
        ...response,
        ...(response.example
          ? { example: await prepareExample(response.example) }
          : {}),
        ...(response.additionalMedia
          ? {
              additionalMedia: await Promise.all(
                response.additionalMedia.map(async (media) => ({
                  ...media,
                  ...(media.example
                    ? { example: await prepareExample(media.example) }
                    : {}),
                })),
              ),
            }
          : {}),
      })),
    ),
  };
}

export async function projectApiModelPage(
  model: ApiModel,
  coordinate: string,
  bounds?: ApiNavBounds,
): Promise<{ page: ApiPageProps; nav: ApiNav }> {
  const page = getApiPageProps(model, coordinate);
  return {
    page: await prepareApiPageCode(page),
    nav: projectedNav(model, coordinate, page.kind === "api", bounds),
  };
}

function configuredTarget(collection: string, version: string | null) {
  const target = resolveApiVersion(configuredApi, collection, version);
  if (!target || !configuredRoot) {
    throw new Error(
      `nimbus-docs: API model for collection "${collection}"${version ? ` version "${version}"` : ""} was not configured by the Nimbus integration.`,
    );
  }
  return target;
}

function configuredApiModel(
  collection: string,
  version: string | null,
): Promise<ApiModel> {
  const key = configuredModelKey(collection, version);
  let model = configuredModels.get(key);
  if (!model) {
    const target = configuredTarget(collection, version);
    configuredBounds.set(key, {
      sidebar: target.sidebar,
      mountPath: target.mountPath,
    });
    model = resolveSpecSource(
      {
        collection: target.namespace,
        spec: target.spec,
        label: target.label,
        mountPath: target.mountPath,
        requireOperationId: target.requireOperationId,
        schemaPages: target.schemaPages,
        routes: target.routes,
      },
      configuredRoot,
    ).then(buildApiModel);
    configuredModels.set(key, model);
    model.catch(() => {
      if (configuredModels.get(key) === model) configuredModels.delete(key);
    });
  }
  return model;
}

export async function projectConfiguredApiPage(
  collection: string,
  version: string | null,
  coordinate: string,
): Promise<{ page: ApiPageProps; nav: ApiNav }> {
  const model = await configuredApiModel(collection, version);
  return projectApiModelPage(
    model,
    coordinate,
    configuredBounds.get(configuredModelKey(collection, version)),
  );
}

/**
 * Every configured API version's full navigation and sidebar bounds: what
 * sidebar rows are made from. Reuses the models the content loader built.
 */
export async function configuredApiNavs(): Promise<
  Array<{ nav: ApiNav } & ApiNavBounds>
> {
  const navs: Array<{ nav: ApiNav } & ApiNavBounds> = [];
  for (const entry of configuredApi) {
    for (const target of resolveApiFamily(entry)) {
      const model = await configuredApiModel(entry.collection, target.version);
      navs.push({ nav: getApiNav(model), sidebar: target.sidebar, mountPath: target.mountPath });
    }
  }
  return navs;
}

/** Page props without highlighted code or navigation, for Markdown output. */
export async function projectConfiguredApiPageProps(
  collection: string,
  version: string | null,
  coordinate: string,
): Promise<ApiPageProps> {
  return getApiPageProps(
    await configuredApiModel(collection, version),
    coordinate,
  );
}

registerConfiguredApiProjector({
  page: projectConfiguredApiPage,
  pageProps: projectConfiguredApiPageProps,
});
