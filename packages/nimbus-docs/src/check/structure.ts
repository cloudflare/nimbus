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

import { cloudflareTrailingSlashWarning } from "../_internal/cloudflare-trailing-slash.js";
import { serverAdapterFeature, serverAdapterMessage, type ServerFeature } from "../_internal/server-adapter.js";
import { parseAstroConfigFields, type ConfigParseResult } from "../_internal/parse-nimbus-config.js";
import {
  parseCollectionBases,
  parsePageCollectionFolders,
  placeStaticCollections,
  parseContentCollections,
} from "../_internal/parse-content-collections.js";
import { readPageCollectionsFile } from "../_internal/page-collections.js";
import { planRouteFiles } from "../_internal/route-files.js";
import { DEFAULT_RENDERING_NOTE } from "../_internal/route-modes.js";
import { invocation } from "../cli/pm.js";
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
import { resolveMigrationSrcDir } from "../_internal/migrations.js";
import { validateMdxContent } from "../_internal/validate-mdx-content.js";
import { validateNimbusConfig } from "../_internal/validate.js";
import { isRequiredCanonicalRouteComponent } from "../_internal/route-ownership.js";
import {
  contentEntryUrl,
  enumerateEntriesByBase,
  enumerateGlobEntries,
  enumerateStaticPageRoutes,
  findDuplicateRoutes,
  type RouteOwner,
} from "../lint/site-model.js";
import type { CheckFinding, CollectionUrl, Note, ScopeReport } from "./finding.js";
import { probeSources, sourceFindings } from "./sources.js";
import { parseContentSourcePath } from "../_internal/source-paths.js";
import { lineOf, relFile } from "./loc.js";
import type { NimbusConfig } from "../types.js";
import { collectionMountPrefix, COLLECTION_URLS_DOCS, NO_ROUTES, type MountContext } from "../_internal/collection-mount.js";
import {
  collectionOwnershipErrors,
  decideCollectionMounts,
  findCollectionRoutes,
  unreadRouteWarnings,
} from "../_internal/collection-routes.js";

export async function checkStructure(
  cwd: string,
  parsed: ConfigParseResult,
  snapshots: ReadonlyMap<string, { contentDir: string }> = new Map(),
  srcDirOverride?: string,
): Promise<ScopeReport> {
  const findings: CheckFinding[] = [];
  const notes: Note[] = [];

  const config = checkConfigZod(findings, notes, parsed);
  const { context: mountContext, collections, srcDir, built } = await checkCollectionUrls(
    cwd,
    findings,
    notes,
    parsed,
    srcDirOverride,
  );
  await checkApiCollections(cwd, findings, notes, parsed, config);
  checkSourceReferences(cwd, findings, parsed, config);
  const requestRendering = await checkRequestRendering(cwd, findings, notes, parsed, config, mountContext, srcDir, built);
  if (parsed.ok && config) {
    const feature = serverAdapterFeature({
      unbundledApi: !parsed.unresolved.includes("api") && !!config.api?.some((entry) => entry.bundle === false),
      requestRendering,
      mcp: !parsed.unresolved.includes("agents") && !!config.agents?.mcp,
    });
    if (feature) checkServerAdapter(cwd, findings, notes, feature);
  }
  checkRouteFiles(cwd, findings, notes, parsed, srcDirOverride);
  await checkDuplicateRoutes(cwd, findings, snapshots, mountContext, parsed, srcDir, built);
  await checkMdxComponents(cwd, findings, notes, parsed);
  checkCloudflareTrailingSlash(cwd, findings);

  return { scope: "structure", findings, notes, evaluated: true, collections };
}

function checkServerAdapter(cwd: string, findings: CheckFinding[], notes: Note[], feature: ServerFeature): void {
  const fields = parseAstroConfigFields(cwd);
  if (!fields || fields.unresolved.includes("...spread") || fields.unresolved.includes("adapter")) {
    notes.push(skippedNote(
      "nimbus/server-adapter-unconfirmed",
      "The exported Astro config is computed, so its adapter can't be confirmed statically.",
    ));
    return;
  }
  if (fields.adapter) return;
  findings.push({
    scope: "structure",
    code: "nimbus/server-adapter-missing",
    severity: "error",
    message: serverAdapterMessage(feature, cwd),
    fixable: false,
  });
}

/** The build warns about this too; `check` says it before a deploy. */
function checkCloudflareTrailingSlash(cwd: string, findings: CheckFinding[]): void {
  const fields = parseAstroConfigFields(cwd);
  if (!fields || fields.unresolved.length > 0) return;
  const message = cloudflareTrailingSlashWarning(cwd, {
    // Astro's defaults.
    output: fields.output ?? "static",
    trailingSlash: fields.trailingSlash ?? "ignore",
    format: fields.buildFormat ?? "directory",
  });
  if (!message) return;
  findings.push({
    scope: "structure",
    code: "nimbus/cloudflare-trailing-slash",
    severity: "warn",
    message,
    fixable: false,
  });
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
  notes: Note[],
  parsed: ConfigParseResult,
  config: NimbusConfig | null,
): Promise<void> {
  if (!parsed.ok || config === null) return;
  if (parsed.unresolved.includes("api") || parsed.unresolved.includes("...spread")) {
    notes.push(apiCollectionsSkipped("the `api` config isn't a plain literal"));
    return;
  }
  const contentConfigPath = path.join(cwd, "src", "content.config.ts");
  const [collections, api] = await Promise.all([
    parseContentCollections(contentConfigPath),
    parseApiCollections(contentConfigPath),
  ]);
  if (collections === null || api === null) {
    if ((config.api ?? []).length > 0) {
      notes.push(apiCollectionsSkipped(
        existsSync(contentConfigPath)
          ? "src/content.config.ts can't be read statically"
          : "src/content.config.ts doesn't exist",
      ));
    }
    return;
  }

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

/**
 * A declared source that nothing reads is a warning: a collection reads it
 * with `docsCollection({ source })`, an `api` entry with `spec: { source }`.
 * Skipped, silently, when either side can't be read statically: a computed
 * `sources` or `api` field, a spread, or a registration the parser can't see.
 */
function checkSourceReferences(
  cwd: string,
  findings: CheckFinding[],
  parsed: ConfigParseResult,
  config: NimbusConfig | null,
): void {
  if (!parsed.ok || config === null) return;
  const names = Object.keys(config.sources ?? {});
  if (names.length === 0) return;
  if (["api", "...spread"].some((field) => parsed.unresolved.includes(field))) return;
  const contentConfigPath = path.join(cwd, "src", "content.config.ts");
  const places = parsePageCollectionFolders(cwd, contentConfigPath);
  if (places === null || [...places.values()].some((place) => place.kind === "unplaced")) return;

  const referenced = new Set<string>();
  for (const place of places.values()) if (place.kind === "source") referenced.add(place.source);
  for (const entry of config.api ?? []) {
    for (const holder of entry.versions ?? [entry]) {
      const spec = holder.spec as { source?: unknown } | string | undefined;
      if (typeof spec === "object" && spec !== null && typeof spec.source === "string") referenced.add(spec.source);
    }
  }
  const sourcesField = parsed.location.fields.get("sources");
  for (const name of names) {
    if (referenced.has(name)) continue;
    findings.push({
      scope: "structure",
      code: "nimbus/source-unreferenced",
      severity: "warn",
      file: relFile(parsed.location.file),
      line: lineOf(parsed.location.source, sourcesField?.keyStart ?? parsed.location.objectStart),
      message:
        `sources.${name} is declared but nothing reads it. ` +
        `Add docsCollection({ source: "${name}" }) to src/content.config.ts, point an api entry at it with spec: { source: "${name}", path }, or remove it.`,
      fixable: false,
    });
  }
}

/** With a computed `api`, a zero-argument `apiCollection()` is the one registration
 * the build must pair with an `api` entry, so it is the one `check` may assume. */
async function assumedApiCollections(srcDir: string, notes: Note[]): Promise<string[]> {
  const api = await parseApiCollections(path.join(srcDir, "content.config.ts"));
  const assumed = (api?.registrations ?? [])
    .filter((registration) => registration.kind === "config")
    .map((registration) => registration.key);
  if (assumed.length > 0)
    notes.push(skippedNote(
      "nimbus/api-collections-assumed",
      "`api` isn't a plain literal, so zero-argument apiCollection() registrations are taken as " +
        `API collections: ${assumed.map((key) => `"${key}"`).join(", ")}.`,
    ));
  return assumed;
}

function apiCollectionsSkipped(cause: string): Note {
  return skippedNote(
    "nimbus/api-collections-skipped",
    `API collection checks skipped: ${cause}, so \`api\` entries weren't matched against apiCollection() registrations.`,
  );
}

function skippedNote(code: string, reason: string): Note {
  return { code, reason: `${reason} A build enforces them.`, requiresBuild: true };
}

/**
 * The setup errors the build reports for collection routes, the mount context
 * they leave, and the last build's page collections that still exist.
 */
async function checkCollectionUrls(
  cwd: string,
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
  srcDirOverride: string | undefined,
): Promise<{ context: MountContext; collections: CollectionUrl[]; srcDir: string; built: string[] | null }> {
  const versions =
    parsed.ok && isVersionsObject(parsed.config.versions)
      ? { others: asStringArray(parsed.config.versions.others) }
      : null;
  // The build reads routes under Astro's `srcDir`; when the config is
  // computed, Astro's default, as the rest of `check` assumes.
  const srcDir = resolveMigrationSrcDir(cwd, srcDirOverride).srcDir ?? path.join(cwd, "src");
  const apiCollections =
    parsed.ok && Array.isArray(parsed.config.api)
      ? parsed.config.api.flatMap((entry) =>
          entry && typeof entry === "object" && typeof (entry as { collection?: unknown }).collection === "string"
            ? [(entry as { collection: string }).collection]
            : [],
        )
      : [];
  const { found, unread } = findCollectionRoutes(srcDir, cwd);
  const { mounts, errors, warnings } = decideCollectionMounts(found, versions);
  for (const error of errors)
    findings.push({
      scope: "structure",
      code: error.code,
      severity: "error",
      message: `${error.message} See ${COLLECTION_URLS_DOCS}.`,
      fixable: false,
    });
  for (const warning of [...warnings, ...unreadRouteWarnings(unread)])
    findings.push({
      scope: "structure",
      code: warning.code,
      severity: "warn",
      message: `${warning.message} See ${COLLECTION_URLS_DOCS}.`,
      fixable: false,
    });
  const context = { versions, routes: mounts };
  const recorded = readPageCollectionsFile(cwd)?.collections;
  const built = recorded
    ? await liveCollections(recorded, srcDir, notes, [
        ...(versions?.others ?? []).map((version) => `docs-${version}`),
        ...apiCollections,
        ...mounts.keys(),
      ])
    : null;
  const hasDocs = built ? built.includes("docs") : mounts.has("docs") || existsSync(path.join(srcDir, "content", "docs"));
  const names = [
    ...new Set([
      ...(hasDocs ? ["docs"] : []),
      ...(versions?.others ?? []).map((version) => `docs-${version}`),
      ...apiCollections,
      ...(built ?? []),
      ...mounts.keys(),
    ]),
  ];
  const collections = names.map((name): CollectionUrl => {
    const url = collectionMountPrefix(name, context);
    const fallback = collectionMountPrefix(name, { versions, routes: NO_ROUTES });
    const file = mounts.get(name)?.file;
    return {
      name,
      url: url || "/",
      source:
        name === "docs" ? "root collection"
        : name.startsWith("docs-") && versions?.others.includes(name.slice("docs-".length)) ? "docs version"
        : file ?? "default (no route found)",
      moved: url !== fallback,
    };
  });
  return { context, collections, srcDir, built };
}

/**
 * Drop the recorded names that are no longer declared, served by a route, or
 * a version or API collection. When `content.config.ts` can't be fully read,
 * every name stays.
 */
async function liveCollections(
  recorded: string[],
  srcDir: string,
  notes: Note[],
  known: string[],
): Promise<string[]> {
  const declared = await parseContentCollections(path.join(srcDir, "content.config.ts"));
  if (declared === null || !declared.complete) return recorded;
  const live = new Set([...known, ...declared.names]);
  for (const name of recorded.filter((name) => !live.has(name)))
    notes.push({
      code: "nimbus/page-collections-stale",
      reason: `\`${name}\` is in the last build's collection list but no longer declared; run a build to refresh.`,
    });
  return recorded.filter((name) => live.has(name));
}

async function checkRequestRendering(
  cwd: string,
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
  config: NimbusConfig | null,
  mountContext: MountContext,
  srcDir: string,
  pageCollections: string[] | null,
): Promise<boolean> {
  if (!parsed.ok || config === null) return false;
  if (parsed.unresolved.includes("rendering") || parsed.unresolved.includes("...spread")) {
    notes.push(skippedNote(
      "nimbus/rendering-policy-skipped",
      "Rendering policy checks skipped: the `rendering` config isn't a plain literal, so request-rendered collections and their routes weren't verified.",
    ));
    return false;
  }
  if (!config.rendering) return false;

  // The same before-sync candidate set the build uses: `docs`, version
  // collections, API collections, and every key in `rendering.collections`.
  const apiCollections = parsed.unresolved.includes("api")
    ? await assumedApiCollections(srcDir, notes)
    : (config.api ?? []).map((entry) => entry.collection);
  const candidates = [
    ...new Set([
      "docs",
      ...(config.versions?.others ?? []).map((version) => `docs-${version}`),
      ...apiCollections,
      ...Object.keys(config.rendering.collections ?? {}),
    ]),
  ];
  const canonicalCollections = candidates.filter((collection) => {
    const component = canonicalCollectionRouteComponent(
      srcDir,
      collection,
      mountContext,
      cwd,
    );
    return (
      isRequiredCanonicalRouteComponent(cwd, srcDir, component) ||
      existsSync(component)
    );
  });
  // The build's page-collection list, when the last build wrote one. With
  // it, `check` reports the same post-sync rendering errors the build does;
  // without it, collections it can't confirm stay unchecked.
  if (pageCollections !== null) {
    const pageSet = new Set(pageCollections);
    const unlisted = Object.keys(config.rendering.collections ?? {}).filter(
      (collection) => !pageSet.has(collection),
    );
    // One with a route is likely added since the last build, which checks it.
    const unknown = unlisted.filter((collection) => !canonicalCollections.includes(collection));
    const unbuilt = unlisted.filter((collection) => canonicalCollections.includes(collection));
    if (unbuilt.length > 0)
      notes.push(skippedNote(
        "nimbus/page-collections-unconfirmed",
        `${unbuilt.map((collection) => `"${collection}"`).join(", ")} ${unbuilt.length === 1 ? "isn't" : "aren't"} in the last build's page collections yet; the next build checks ${unbuilt.length === 1 ? "it" : "them"}.`,
      ));
    for (const collection of unknown) {
      findings.push({
        scope: "structure",
        code: "nimbus/rendering-policy-invalid",
        severity: "error",
        file: relFile(parsed.location.file),
        line: lineOf(parsed.location.source, parsed.location.objectStart),
        message:
          `nimbus-docs: rendering.collections names "${collection}", which is not a Nimbus page collection. ` +
          "Page collections are made with docsCollection(), componentsCollection(), or withNimbusMarkdown(), " +
          "plus version and API collections. A plain Astro data collection has no rendering mode.",
        fixable: false,
      });
    }
    const uncovered = pageCollections.filter((collection) => {
      if (candidates.includes(collection)) return false;
      return existsSync(
        canonicalCollectionRouteComponent(srcDir, collection, mountContext, cwd),
      );
    });
    for (const collection of uncovered) {
      findings.push({
        scope: "structure",
        code: "nimbus/rendering-policy-invalid",
        severity: "error",
        file: relFile(parsed.location.file),
        line: lineOf(parsed.location.source, parsed.location.objectStart),
        message:
          `nimbus-docs: \`rendering\` is set, but it doesn't cover page collection "${collection}", ` +
          `which has a catch-all route at its mount. Add "${collection}" to rendering.collections ` +
          "(\`rendering.default\` covers only docs, version, and API collections).",
        fixable: false,
      });
    }
  } else {
    notes.push(skippedNote(
      "nimbus/page-collections-unconfirmed",
      "Page-collection rendering checks skipped: no `.nimbus/page-collections.json` from a completed build, so only docs, version, and API collections were verified.",
    ));
  }

  let hasRequestRoute: boolean;
  let policy: ReturnType<typeof compileRenderingPolicy>;
  try {
    policy = compileRenderingPolicy(
      config.rendering,
      canonicalCollections,
    );
    hasRequestRoute = Object.values(policy.collections).includes("request");
  } catch (err) {
    // A collection route error already says why a collection has no route.
    if (findings.some((f) => f.severity === "error" && f.code.startsWith("nimbus/collection-"))) return false;
    findings.push({
      scope: "structure",
      code: "nimbus/rendering-policy-invalid",
      severity: "error",
      file: relFile(parsed.location.file),
      line: lineOf(parsed.location.source, parsed.location.objectStart),
      message: err instanceof Error ? err.message : String(err),
      fixable: false,
    });
    return false;
  }
  if (!hasRequestRoute) return false;

  // Not `requiresBuild`: check never reads server output, so a build can't
  // clear this note. It stays, and the build is the gate.
  notes.push({
    code: "nimbus/request-rendering-build-required",
    reason:
      "`nimbus-docs check` doesn't verify request-rendered pages, even after a build; a passing production build is the gate for them",
  });
  return true;
}

/** Each managed route file that doesn't say what `rendering` gives it; `--fix` rewrites it. */
function checkRouteFiles(
  cwd: string,
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
  srcDirOverride: string | undefined,
): void {
  if (!parsed.ok) return;
  const plan = planRouteFiles(cwd, srcDirOverride);
  if (!plan.ok) {
    notes.push(skippedNote("nimbus/route-files-skipped", `Route file modes weren't checked: ${plan.reason}.`));
    return;
  }
  if (!plan.configured && plan.files.length > 0)
    findings.push({ scope: "structure", code: "nimbus/rendering-default", severity: "info", message: DEFAULT_RENDERING_NOTE, fixable: false });
  for (const { file, mismatch, problem, edit, writes } of plan.files) {
    const manual = edit.status === "manual";
    findings.push({
      scope: "structure",
      code: "nimbus/route-file-mode",
      severity: mismatch.kind === "missing-paths" ? "error" : "warn",
      file,
      message: `${file}: ${problem}.`,
      fixable: writes,
      fix: manual
        ? { kind: writes ? "route-file" : "suggestion", path: file, suggestion: edit.todo }
        : { kind: "route-file", path: file, suggestion: `run \`${invocation("check --fix", cwd)}\` to update it` },
    });
  }
}

function checkConfigZod(
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
): NimbusConfig | null {
  if (!parsed.ok) return null;

  const file = relFile(parsed.location.file);
  const line = lineOf(parsed.location.source, parsed.location.objectStart);

  const probe: Record<string, unknown> = { ...parsed.config };
  // A `sources` map whose only computed values are templated refs
  // (`process.env.SDK_DOCS_REF ?? "<commit>"`) is read with each ref's
  // fallback, so a preview-ready config keeps its readiness.
  let templatedRefs = new Set<string>();
  let unresolved = parsed.unresolved;
  if (probe.sources === undefined && unresolved.includes("sources")) {
    const raw = parsed.location.fields.get("sources")?.raw;
    const sources = raw === undefined ? null : probeSources(raw);
    if (sources) {
      probe.sources = sources.probe;
      templatedRefs = sources.templated;
      unresolved = unresolved.filter((field) => field !== "sources");
    }
  }

  const hasSpread = unresolved.includes("...spread");
  if (unresolved.length > 0) {
    const fields = unresolved
      .map((u) => (u === "...spread" ? "a spread (`...`)" : `\`${u}\``))
      .join(", ");
    notes.push({
      code: "nimbus/config-unresolved",
      reason: `computed config field(s) can't be evaluated statically: ${fields}. A build validates their real values.`,
      requiresBuild: true,
    });
  }

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
  // An unreadable policy may render request; don't assume the build default.
  if (probe.rendering === undefined && (hasSpread || parsed.unresolved.includes("rendering"))) {
    probe.rendering = { default: "request" };
  }

  try {
    // A computed `sources` defers only the checks that need the map.
    const config = validateNimbusConfig(probe, {
      deferSources: probe.sources === undefined && (hasSpread || unresolved.includes("sources")),
    });
    if (config.sources) {
      const sourcesField = parsed.location.fields.get("sources");
      findings.push(
        ...sourceFindings(config.sources, templatedRefs, {
          file,
          line: lineOf(parsed.location.source, sourcesField?.keyStart ?? parsed.location.objectStart),
        }),
      );
    }
    return config;
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
  snapshots: ReadonlyMap<string, { contentDir: string }>,
  mountContext: MountContext,
  parsed: ConfigParseResult,
  srcDir: string,
  built: string[] | null,
): Promise<void> {
  const contentRoot = path.join(srcDir, "content");

  const contentConfigPath = path.join(srcDir, "content.config.ts");
  const collectionBases = await parseCollectionBases(contentConfigPath);
  // Where each page collection's files are, wherever the folder: the same
  // static reading `lint` uses. Collections it can't place are skipped.
  const placed = placeStaticCollections(parsePageCollectionFolders(cwd, contentConfigPath), snapshots);

  const versions =
    parsed.ok && isVersionsObject(parsed.config.versions)
      ? { others: asStringArray(parsed.config.versions.others) }
      : null;

  // The build's page-collection list when it exists; otherwise only the
  // collections confirmable from config alone (docs, version, and API
  // collections) are walked, and `check` stays silent about the rest.
  const apiCollections =
    parsed.ok && Array.isArray(parsed.config.api)
      ? parsed.config.api
          .map((entry) =>
            entry && typeof entry === "object" && "collection" in entry
              ? (entry as { collection?: unknown }).collection
              : undefined,
          )
          .filter((name): name is string => typeof name === "string")
      : [];
  // The build's list, plus the page collections the config shows statically
  // (a Nimbus factory or `withNimbusMarkdown()` over a folder), so one added
  // since that build is checked too.
  const pageCollections = [
    ...new Set([
      ...(built ?? ["docs"]),
      ...(versions?.others ?? []).map((version) => `docs-${version}`),
      ...apiCollections,
      ...[...(placed ?? [])]
        .filter(([, place]) => place.kind === "folder" && place.role === "page")
        .map(([key]) => key),
    ]),
  ];

  const indexedBases = new Map<string, string>();
  const contentOwners: RouteOwner[] = [];
  const owned: Array<{ collection: string; url: string; source: string }> = [];
  for (const key of pageCollections) {
    const place = placed?.get(key);
    if (place?.kind === "unplaced") continue;
    if (place?.kind === "folder") {
      for (const entry of enumerateGlobEntries(key, place.dir, place.pattern, cwd)) {
        const owner = {
          url: contentEntryUrl(entry, mountContext),
          source: place.source
            ? `${place.source}: ${(parseContentSourcePath(entry.relPath)?.path ?? entry.relPath)}`
            : entry.relPath,
          kind: "content" as const,
        };
        contentOwners.push(owner);
        owned.push({ collection: entry.collection, url: owner.url, source: owner.source });
      }
      continue;
    }
    indexedBases.set(key, collectionBases?.get(key) ?? key);
  }
  if (existsSync(contentRoot)) {
    for (const entry of enumerateEntriesByBase(contentRoot, indexedBases)) {
      const owner = {
        url: contentEntryUrl(entry, mountContext),
        source: path.relative(cwd, path.join(contentRoot, entry.relPath)).split(path.sep).join("/"),
        kind: "content" as const,
      };
      contentOwners.push(owner);
      owned.push({ collection: entry.collection, url: owner.url, source: owner.source });
    }
  }
  // The build's post-sync errors: a page under another collection's URL. A
  // collection a route helper serves is a page collection; `docs` is one
  // only when something confirms it (a site can serve another at the root).
  const docsConfirmed = built
    ? built.includes("docs")
    : placed?.has("docs") === true || existsSync(path.join(contentRoot, "docs"));
  const routedCollections = [...new Set([...pageCollections, ...mountContext.routes.keys()])].filter(
    (name) => name !== "docs" || docsConfirmed,
  );
  for (const error of collectionOwnershipErrors(owned, routedCollections, mountContext))
    findings.push({
      scope: "structure",
      code: error.code,
      severity: "error",
      message: `${error.message} See ${COLLECTION_URLS_DOCS}.`,
      fixable: false,
    });

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
  parsed: ConfigParseResult,
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

  // The same scope the build validates. The build records the exact `.mdx`
  // file list its MDX pass checked (page and partials collections, from the
  // registry) in `.nimbus/page-collections.json`; with it, check validates
  // the identical set. Without it, only the folders confirmable from config
  // alone (docs, version, and API collections) are walked, and check stays
  // silent about the rest — nothing here classifies collections by parsing
  // content.config.ts.
  const recorded = readPageCollectionsFile(cwd);
  let failures: Awaited<ReturnType<typeof validateMdxContent>>;
  if (recorded !== null) {
    failures = await validateMdxContent({
      globals,
      contentDirs: [],
      files: recorded.mdxFiles.map((file) => path.join(cwd, file)),
      projectRoot: cwd,
    });
  } else {
    const bases = await parseCollectionBases(
      path.join(srcDir, "content.config.ts"),
    );
    const versionsConfig =
      parsed.ok && isVersionsObject(parsed.config.versions)
        ? asStringArray(parsed.config.versions.others)
        : [];
    const apiNames =
      parsed.ok && Array.isArray(parsed.config.api)
        ? parsed.config.api
            .map((entry) =>
              entry && typeof entry === "object" && "collection" in entry
                ? (entry as { collection?: unknown }).collection
                : undefined,
            )
            .filter((name): name is string => typeof name === "string")
        : [];
    const confirmable = new Set([
      "docs",
      ...versionsConfig.map((version) => `docs-${version}`),
      ...apiNames,
    ]);
    const contentDirs = [...confirmable]
      .map((key) => path.join(contentRoot, bases?.get(key) ?? key))
      .filter((dir) => existsSync(dir));
    notes.push(skippedNote(
      "nimbus/page-collections-unconfirmed",
      "MDX component checks covered only the docs, version, and API collections: no `.nimbus/page-collections.json` from a completed build, so other page and partials collections weren't verified.",
    ));
    failures = await validateMdxContent({
      globals,
      contentDirs,
      projectRoot: cwd,
    });
  }
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
