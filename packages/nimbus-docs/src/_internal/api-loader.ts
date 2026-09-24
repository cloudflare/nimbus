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
import { resolveSpecSource } from "./api/resolve-spec.js";
import { resolveApiVersion } from "./api/resolve-versions.js";
import type { ApiSpec } from "../types.js";

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

const preparedNavCache = new WeakMap<ApiModel, PreparedApiNav>();
const configuredModels = new Map<string, Promise<ApiModel>>();
let configuredApi: ApiSpec[] = [];
let configuredRoot = "";

function configuredModelKey(collection: string, version: string | null): string {
  return `${collection}\0${version ?? ""}`;
}

export function registerConfiguredApiModel(
  collection: string,
  version: string | null,
  model: ApiModel,
): void {
  configuredModels.set(
    configuredModelKey(collection, version),
    Promise.resolve(model),
  );
}

export function configureApiProjector(
  api: ApiSpec[],
  root: string,
): void {
  configuredApi = api;
  configuredRoot = root;
  configuredModels.clear();
}

function projectedNav(model: ApiModel, coordinate: string): ApiNav {
  let prepared = preparedNavCache.get(model);
  if (!prepared) {
    prepared = prepareApiNav(getApiNav(model));
    preparedNavCache.set(model, prepared);
  }
  return activatePreparedApiNav(prepared, coordinate);
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
      })),
    ),
  };
}

export async function projectApiModelPage(
  model: ApiModel,
  coordinate: string,
): Promise<{ page: ApiPageProps; nav: ApiNav }> {
  return {
    page: await prepareApiPageCode(getApiPageProps(model, coordinate)),
    nav: projectedNav(model, coordinate),
  };
}

function configuredApiModel(
  collection: string,
  version: string | null,
): Promise<ApiModel> {
  const key = configuredModelKey(collection, version);
  let model = configuredModels.get(key);
  if (!model) {
    const target = resolveApiVersion(
      configuredApi,
      collection,
      version,
    );
    if (!target || !configuredRoot) {
      throw new Error(
        `nimbus-docs: API model for collection "${collection}"${version ? ` version "${version}"` : ""} was not configured by the Nimbus integration.`,
      );
    }
    model = resolveSpecSource(
      {
        collection: target.namespace,
        spec: target.spec,
        label: target.label,
        mountPath: target.mountPath,
        requireOperationId: target.requireOperationId,
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
  return projectApiModelPage(
    await configuredApiModel(collection, version),
    coordinate,
  );
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
