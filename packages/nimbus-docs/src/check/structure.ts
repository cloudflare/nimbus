/**
 * The **structure** category: would the site build, and would every route and
 * MDX tag resolve? Runs the *same* validators the build gates on — early and
 * build-free, so `check` and `astro build` never disagree:
 *   - config Zod       → `validateNimbusConfig`
 *   - duplicate routes → `findDuplicateRoutes`
 *   - MDX components   → `validateMdxContent`
 *   - API collections  → the `api` entry ↔ `apiCollection()` key pairing the
 *                        build and loader enforce
 * Sub-checks it can't run statically (a computed config field, a missing
 * `components.ts`) are `notes`, not warnings. Internal-link resolution is left
 * to the authoring `nimbus/internal-link` rule (one implementation), not here.
 */

import path from "node:path";
import { existsSync } from "node:fs";

import type { ConfigParseResult } from "../_internal/parse-nimbus-config.js";
import {
  parseCollectionBases,
  parseContentCollections,
  filterIndexableCollections,
} from "../_internal/parse-content-collections.js";
import {
  missingApiCollectionMessage,
  nonApiCollectionMessage,
  unconfiguredApiCollectionMessage,
} from "../_internal/api-collection-registry.js";
import { parseApiCollections } from "./parse-api-collections.js";
import { parseComponentsRegistry } from "../_internal/parse-components-registry.js";
import {
  canonicalCollectionRouteComponent,
  compileRenderingPolicy,
} from "../_internal/rendering-policy.js";
import { validateMdxContent } from "../_internal/validate-mdx-content.js";
import { validateNimbusConfig } from "../_internal/validate.js";
import { isRequiredCanonicalRouteComponent } from "../_internal/route-ownership.js";
import {
  contentEntryUrl,
  enumerateEntriesByBase,
  enumerateStaticPageRoutes,
  findDuplicateRoutes,
  type RouteOwner,
} from "../lint/site-model.js";
import type { CheckFinding, Note, ScopeReport } from "./finding.js";
import { lineOf, relFile } from "./loc.js";
import type { NimbusConfig } from "../types.js";

export async function checkStructure(
  cwd: string,
  parsed: ConfigParseResult,
): Promise<ScopeReport> {
  const findings: CheckFinding[] = [];
  const notes: Note[] = [];

  const config = checkConfigZod(findings, notes, parsed);
  await checkApiCollections(cwd, findings, parsed, config);
  await checkRequestRendering(cwd, findings, notes, parsed, config);
  await checkDuplicateRoutes(cwd, findings, parsed);
  await checkMdxComponents(cwd, findings, notes);

  return { scope: "structure", findings, notes, evaluated: true };
}

/**
 * Every `api` entry needs an `apiCollection()` registered under its key in
 * `src/content.config.ts`, and every zero-argument `apiCollection()` needs an
 * `api` entry for its key. Explicit `apiCollection({ … })` calls carry their
 * own entry and aren't paired. Anything either side can't read statically is
 * skipped; the build enforces the same pairing.
 */
async function checkApiCollections(
  cwd: string,
  findings: CheckFinding[],
  parsed: ConfigParseResult,
  config: NimbusConfig | null,
): Promise<void> {
  if (
    !parsed.ok ||
    config === null ||
    parsed.unresolved.includes("api") ||
    parsed.unresolved.includes("...spread")
  ) {
    return;
  }
  const contentConfigPath = path.join(cwd, "src", "content.config.ts");
  const [collections, api] = await Promise.all([
    parseContentCollections(contentConfigPath),
    parseApiCollections(contentConfigPath),
  ]);
  if (collections === null || api === null) return;

  const configured = (config.api ?? []).map((entry) => entry.collection);
  const kinds = new Map(
    api.registrations.map((registration) => [registration.key, registration.kind]),
  );
  const apiField = parsed.location.fields.get("api");
  const configFinding = (message: string): CheckFinding => ({
    scope: "structure",
    code: "nimbus/api-collection-missing",
    severity: "error",
    file: relFile(parsed.location.file),
    line: lineOf(
      parsed.location.source,
      apiField?.keyStart ?? parsed.location.objectStart,
    ),
    message,
    fixable: false,
  });

  for (const collection of configured) {
    const kind = kinds.get(collection);
    if (kind === "other") {
      findings.push(configFinding(nonApiCollectionMessage(collection)));
    } else if (
      kind === undefined &&
      collections.complete &&
      !collections.names.includes(collection)
    ) {
      findings.push(configFinding(missingApiCollectionMessage(collection)));
    }
  }

  for (const registration of api.registrations) {
    if (registration.kind !== "config" || configured.includes(registration.key)) {
      continue;
    }
    findings.push({
      scope: "structure",
      code: "nimbus/api-collection-unconfigured",
      severity: "error",
      file: relFile(contentConfigPath),
      line: lineOf(api.source, registration.offset),
      message: unconfiguredApiCollectionMessage(registration.key, configured),
      fixable: false,
    });
  }
}

async function checkRequestRendering(
  cwd: string,
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
  config: NimbusConfig | null,
): Promise<void> {
  if (
    !parsed.ok ||
    !config?.rendering ||
    parsed.unresolved.includes("rendering") ||
    parsed.unresolved.includes("...spread")
  ) {
    return;
  }

  const srcDir = path.join(cwd, "src");
  const parsedCollections = await parseContentCollections(
    path.join(srcDir, "content.config.ts"),
  );
  const rawCollections = parsedCollections?.names ?? null;
  const parsedIndexedCollections =
    rawCollections === null ||
    (parsedCollections?.complete === false && rawCollections.length === 0)
      ? ["docs"]
      : filterIndexableCollections(rawCollections);
  const apiCollections = (config.api ?? []).map((entry) => entry.collection);
  const candidates = [
    ...new Set([
      ...parsedIndexedCollections,
      ...(config.versions?.others ?? []).map((version) => `docs-${version}`),
      ...apiCollections,
    ]),
  ];
  const versions = config.versions
    ? { others: config.versions.others ?? [] }
    : null;
  const canonicalCollections = candidates.filter((collection) => {
    const component = canonicalCollectionRouteComponent(
      srcDir,
      collection,
      versions,
    );
    return (
      isRequiredCanonicalRouteComponent(cwd, srcDir, component) ||
      existsSync(component)
    );
  });
  const overrides = config.rendering.collections ?? {};
  const unresolvedOverrides = Object.keys(overrides).filter(
    (collection) => !candidates.includes(collection),
  );
  if (
    parsedCollections?.complete === false &&
    (config.rendering.default === "request" || unresolvedOverrides.length > 0)
  ) {
    findings.push({
      scope: "structure",
      code: "nimbus/rendering-policy-invalid",
      severity: "error",
      file: relFile(parsed.location.file),
      line: lineOf(parsed.location.source, parsed.location.objectStart),
      message:
        "nimbus-docs: rendering policy cannot safely enumerate collections because `src/content.config.ts` contains registrations Nimbus cannot identify statically. Use explicit top-level collection keys before applying a request default or overriding a collection Nimbus cannot statically identify.",
      fixable: false,
    });
    return;
  }

  let hasRequestRoute: boolean;
  try {
    const policy = compileRenderingPolicy(
      config.rendering,
      canonicalCollections,
    );
    hasRequestRoute = Object.values(policy.collections).includes("request");
  } catch (err) {
    findings.push({
      scope: "structure",
      code: "nimbus/rendering-policy-invalid",
      severity: "error",
      file: relFile(parsed.location.file),
      line: lineOf(parsed.location.source, parsed.location.objectStart),
      message: err instanceof Error ? err.message : String(err),
      fixable: false,
    });
    return;
  }
  if (!hasRequestRoute) return;

  notes.push({
    code: "nimbus/request-rendering-build-required",
    reason:
      "`nimbus-docs check` cannot verify request-rendered output or adapter compatibility; use a production build as the authoritative gate",
    requiresBuild: true,
  });
}

function checkConfigZod(
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
): NimbusConfig | null {
  if (!parsed.ok) return null;

  const file = relFile(parsed.location.file);
  const line = lineOf(parsed.location.source, parsed.location.objectStart);

  const hasSpread = parsed.unresolved.includes("...spread");
  if (parsed.unresolved.length > 0) {
    const fields = parsed.unresolved
      .map((u) => (u === "...spread" ? "a spread (`...`)" : `\`${u}\``))
      .join(", ");
    notes.push({
      code: "nimbus/config-unresolved",
      reason: `computed config field(s) can't be evaluated statically: ${fields}. A build validates their real values.`,
      requiresBuild: true,
    });
  }

  const probe: Record<string, unknown> = { ...parsed.config };
  if (
    probe.site === undefined &&
    (hasSpread || parsed.unresolved.includes("site"))
  ) {
    probe.site = "https://nimbus.placeholder.invalid";
  }
  if (
    probe.title === undefined &&
    (hasSpread || parsed.unresolved.includes("title"))
  ) {
    probe.title = "placeholder";
  }

  try {
    return validateNimbusConfig(probe);
  } catch (err) {
    findings.push({
      scope: "structure",
      code: "nimbus/config-invalid",
      severity: "error",
      file,
      line,
      message: err instanceof Error ? err.message : String(err),
      fixable: false,
    });
    return null;
  }
}

async function checkDuplicateRoutes(
  cwd: string,
  findings: CheckFinding[],
  parsed: ConfigParseResult,
): Promise<void> {
  const srcDir = path.join(cwd, "src");
  const contentRoot = path.join(srcDir, "content");
  if (!existsSync(contentRoot)) return;

  const contentConfigPath = path.join(srcDir, "content.config.ts");
  const parsedCollections = await parseContentCollections(contentConfigPath);
  const rawCollections = parsedCollections?.names ?? null;
  const collectionBases = await parseCollectionBases(contentConfigPath);
  const indexedCollections =
    rawCollections === null ||
    (parsedCollections?.complete === false && rawCollections.length === 0)
      ? ["docs"]
      : filterIndexableCollections(rawCollections);
  const indexedSet = new Set(indexedCollections);

  const versions =
    parsed.ok && isVersionsObject(parsed.config.versions)
      ? { others: asStringArray(parsed.config.versions.others) }
      : null;

  const indexedBases = new Map<string, string>();
  if (collectionBases !== null) {
    for (const [key, base] of collectionBases) {
      if (indexedSet.has(key)) indexedBases.set(key, base);
    }
  } else {
    for (const key of indexedCollections) indexedBases.set(key, key);
  }

  const contentOwners: RouteOwner[] = enumerateEntriesByBase(
    contentRoot,
    indexedBases,
  ).map((entry) => ({
    url: contentEntryUrl(entry, versions),
    source: `src/content/${entry.relPath}`,
    kind: "content" as const,
  }));

  const pagesRoot = path.join(srcDir, "pages");
  const pageOwners: RouteOwner[] = existsSync(pagesRoot)
    ? enumerateStaticPageRoutes(pagesRoot, cwd).map((r) => ({
        ...r,
        kind: "page" as const,
      }))
    : [];

  const dups = findDuplicateRoutes([...contentOwners, ...pageOwners]);
  for (const d of dups) {
    if (d.shadowedByPage) {
      findings.push({
        scope: "structure",
        code: "nimbus/duplicate-slug",
        severity: "warn",
        message: `${d.url} is served by a src/pages file that shadows a content entry (${d.sources.join(", ")}). Verify the shadow is intentional.`,
        fixable: false,
      });
    } else {
      findings.push({
        scope: "structure",
        code: "nimbus/duplicate-slug",
        severity: "error",
        message: `${d.url} is claimed by more than one source (${d.sources.join(", ")}) — one would shadow the other. Rename or move one.`,
        fixable: false,
      });
    }
  }
}

async function checkMdxComponents(
  cwd: string,
  findings: CheckFinding[],
  notes: Note[],
): Promise<void> {
  const srcDir = path.join(cwd, "src");
  const contentRoot = path.join(srcDir, "content");
  if (!existsSync(contentRoot)) return;

  const componentsPath = path.join(srcDir, "components.ts");
  const globals = await parseComponentsRegistry(componentsPath);
  if (globals === null) {
    notes.push({
      code: "nimbus/components-registry-missing",
      reason:
        "src/components.ts is missing or doesn't export a parseable `components` object — MDX component resolution can't be checked. Create it with `export const components = { … };`.",
    });
    return;
  }

  const failures = await validateMdxContent({
    globals,
    contentDirs: [contentRoot],
    projectRoot: cwd,
  });
  for (const f of failures) {
    findings.push({
      scope: "structure",
      code: "nimbus/component-pascalcase",
      severity: "error",
      file: f.filePath.replace(/\\/g, "/"),
      line: f.line,
      column: f.column,
      message: `<${f.tag} /> is not a registered global or imported in this file — MDX renders it as literal text.`,
      fixable: false,
      ...(f.hint
        ? {
            fix: {
              kind: "suggestion",
              suggestion: `did you mean <${f.hint} />?`,
            },
          }
        : {}),
    });
  }
}

function isVersionsObject(v: unknown): v is { others?: unknown } {
  return typeof v === "object" && v !== null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}
