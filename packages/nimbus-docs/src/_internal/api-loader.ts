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
  getApiModel,
  getApiNav,
  getApiPageProps,
} from "../api/index.js";
import {
  activatePreparedApiNav,
  prepareApiNav,
  type PreparedApiNav,
} from "./api/prepared.js";

export {
  buildApiModel,
  clearApiModelCache,
  getApiNav,
  getApiPageIndex,
  getApiPageProps,
  getApiRouteProvenance,
} from "../api/index.js";
export { resolveSpecSource } from "./api/resolve-spec.js";
export { apiPageRoute, resolveApiFamily } from "./api/resolve-versions.js";
export { prepareApiNav, preparedApiVersion } from "./api/prepared.js";

const preparedNavCache = new WeakMap<ApiModel, PreparedApiNav>();

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

export async function projectConfiguredApiPage(
  collection: string,
  version: string | null,
  coordinate: string,
): Promise<{ page: ApiPageProps; nav: ApiNav }> {
  return projectApiModelPage(
    await getApiModel(collection, version ?? undefined),
    coordinate,
  );
}
