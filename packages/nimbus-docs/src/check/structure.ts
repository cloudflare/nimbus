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
import { parseAstroConfigFields, type ConfigParseResult } from "../_internal/parse-nimbus-config.js";
import {
  parseCollectionBases,
  parseContentCollections,
} from "../_internal/parse-content-collections.js";
import { readPageCollectionsFile } from "../_internal/page-collections.js";
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
import { probeSources, sourceFindings } from "./sources.js";
import type { NimbusConfig } from "../types.js";

export async function checkStructure(
  cwd: string,
  parsed: ConfigParseResult,
): Promise<ScopeReport> {
  const findings: CheckFinding[] = [];
  const notes: Note[] = [];

  const config = checkConfigZod(findings, notes, parsed);
  await checkApiCollections(cwd, findings, notes, parsed, config);
  await checkRequestRendering(cwd, findings, notes, parsed, config);
  await checkDuplicateRoutes(cwd, findings, parsed);
  await checkMdxComponents(cwd, findings, notes, parsed);
  checkCloudflareTrailingSlash(cwd, findings);

  return { scope: "structure", findings, notes, evaluated: true };
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

function apiCollectionsSkipped(cause: string): Note {
  return skippedNote(
    "nimbus/api-collections-skipped",
    `API collection checks skipped: ${cause}, so \`api\` entries weren't matched against apiCollection() registrations.`,
  );
}

function skippedNote(code: string, reason: string): Note {
  return { code, reason: `${reason} A build enforces them.`, requiresBuild: true };
}

async function checkRequestRendering(
  cwd: string,
  findings: CheckFinding[],
  notes: Note[],
  parsed: ConfigParseResult,
  config: NimbusConfig | null,
): Promise<void> {
  if (!parsed.ok || config === null) return;
  if (parsed.unresolved.includes("rendering") || parsed.unresolved.includes("...spread")) {
    notes.push(skippedNote(
      "nimbus/rendering-policy-skipped",
      "Rendering policy checks skipped: the `rendering` config isn't a plain literal, so request-rendered collections and their routes weren't verified.",
    ));
    return;
  }
  if (!config.rendering) return;

  const srcDir = path.join(cwd, "src");
  // The same before-sync candidate set the build uses: `docs`, version
  // collections, API collections, and every key in `rendering.collections`.
  // Which collections are pages is never parsed from content.config.ts.
  const apiCollections = (config.api ?? []).map((entry) => entry.collection);
  const candidates = [
    ...new Set([
      "docs",
      ...(config.versions?.others ?? []).map((version) => `docs-${version}`),
      ...apiCollections,
      ...Object.keys(config.rendering.collections ?? {}),
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
  // The build's page-collection list, when the last build wrote one. With
  // it, `check` reports the same post-sync rendering errors the build does;
  // without it, collections it can't confirm stay unchecked.
  const pageCollections = readPageCollectionsFile(cwd)?.collections ?? null;
  if (pageCollections !== null) {
    const pageSet = new Set(pageCollections);
    const unknown = Object.keys(config.rendering.collections ?? {}).filter(
      (collection) => !pageSet.has(collection),
    );
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
        canonicalCollectionRouteComponent(srcDir, collection, versions),
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

  // Not `requiresBuild`: check never reads server output, so a build can't
  // clear this note. It stays, and the build is the gate.
  notes.push({
    code: "nimbus/request-rendering-build-required",
    reason:
      "`nimbus-docs check` doesn't verify request-rendered pages, even after a build; a passing production build is the gate for them",
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

  try {
    const config = validateNimbusConfig(probe);
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
  parsed: ConfigParseResult,
): Promise<void> {
  const srcDir = path.join(cwd, "src");
  const contentRoot = path.join(srcDir, "content");
  if (!existsSync(contentRoot)) return;

  const contentConfigPath = path.join(srcDir, "content.config.ts");
  const collectionBases = await parseCollectionBases(contentConfigPath);

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
  const pageCollections =
    readPageCollectionsFile(cwd)?.collections ?? [
      ...new Set([
        "docs",
        ...(versions?.others ?? []).map((version) => `docs-${version}`),
        ...apiCollections,
      ]),
    ];

  const indexedBases = new Map<string, string>();
  for (const key of pageCollections) {
    indexedBases.set(key, collectionBases?.get(key) ?? key);
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
