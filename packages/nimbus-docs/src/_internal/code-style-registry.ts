import { transformerStyleToClass } from "@shikijs/transformers";
import type { ShikiTransformer } from "shiki";

export const NIMBUS_DEFAULT_SHIKI_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

// Astro bundles this package into the code that renders pages, so API code
// highlighted there runs through a different copy of this module than the
// integration that writes `_nimbus/shiki.css`. One registry per process gives
// every copy the same token classes, so the stylesheet defines all of them.
const REGISTRY = Symbol.for("@cloudflare/nimbus-docs/code-style-registry");
type StyleToClass = ReturnType<typeof transformerStyleToClass>;
const registryHost = globalThis as typeof globalThis & { [REGISTRY]?: StyleToClass };
const styleToClass = (registryHost[REGISTRY] ??= transformerStyleToClass({
  classPrefix: "nb-shiki-",
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDefaultThemes(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
  return value.light === NIMBUS_DEFAULT_SHIKI_THEMES.light &&
    value.dark === NIMBUS_DEFAULT_SHIKI_THEMES.dark &&
    keys.every((key) => key === "light" || key === "dark");
}

export function hasCustomShikiTheme(shikiConfig: unknown): boolean {
  if (!isRecord(shikiConfig)) return false;
  if (
    "theme" in shikiConfig &&
    shikiConfig.theme !== undefined &&
    shikiConfig.theme !== NIMBUS_DEFAULT_SHIKI_THEMES.dark
  ) {
    return true;
  }
  return "themes" in shikiConfig && !isDefaultThemes(shikiConfig.themes);
}

export function hasCustomShikiDefaultColor(shikiConfig: unknown): boolean {
  return isRecord(shikiConfig) &&
    "defaultColor" in shikiConfig &&
    shikiConfig.defaultColor !== false;
}

/**
 * Classed token CSS is safe for Nimbus' default dual-theme contract. Custom
 * themes stay inline until they have an explicit CSS contract with the starter.
 */
export function shouldClassShikiTokens(shikiConfig: unknown): boolean {
  return !hasCustomShikiTheme(shikiConfig) && !hasCustomShikiDefaultColor(shikiConfig);
}

export function getCodeStyleTransformer() {
  return styleToClass;
}

const RESTORED_STYLES = Symbol.for(
  "@cloudflare/nimbus-docs/restored-code-styles",
);
const restoredHost = globalThis as typeof globalThis & {
  [RESTORED_STYLES]?: Set<string>;
};
const restoredStyles = (restoredHost[RESTORED_STYLES] ??= new Set<string>());

/** Replay CSS emitted alongside persisted highlighted HTML on a clean runner. */
export function restoreCodeStyleCSS(css: string): void {
  const rules = css.match(/\.nb-shiki-[^\s{}]+\s*\{[^{}]*\}/g) ?? [];
  const remainder = css.replace(/\.nb-shiki-[^\s{}]+\s*\{[^{}]*\}/g, "").trim();
  if (remainder) throw new Error("Invalid cached syntax highlighting CSS.");
  for (const rule of rules) restoredStyles.add(rule);
}

export function getCodeStyleCSS(): string {
  const rules = new Set([
    ...restoredStyles,
    ...(styleToClass.getCSS().match(/\.nb-shiki-[^\s{}]+\s*\{[^{}]*\}/g) ?? []),
  ]);
  return [...rules].sort().join("\n");
}

/** The CSS for just these token classes, from what's registered or restored. */
export function getCodeStyleCSSFor(classes: Iterable<string>): string {
  const wanted = new Set(classes);
  return getCodeStyleCSS()
    .split("\n")
    .filter((rule) => wanted.has(rule.slice(1, rule.search(/[\s{]/))))
    .join("\n");
}

/** Collects the token classes Shiki put on elements, never text that spells one. */
export function tokenClassCollector(into: Set<string>): ShikiTransformer {
  type HastNode = { type: string; properties?: { class?: unknown }; children?: HastNode[] };
  const visit = (node: HastNode): void => {
    if (node.type === "element") {
      const value = node.properties?.class;
      const names = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(/\s+/)
          : [];
      for (const name of names)
        if (typeof name === "string" && name.startsWith("nb-shiki-")) into.add(name);
    }
    for (const child of node.children ?? []) visit(child);
  };
  return {
    name: "nimbus:token-classes",
    root(root) {
      visit(root as unknown as HastNode);
    },
  };
}

// Build-time preparation installs this to learn which token classes each
// highlight used, so a version's cache saves only its own styles.
const TOKEN_CLASS_SINK = Symbol.for("@cloudflare/nimbus-docs/token-class-sink");
type TokenClassSink = (classes: readonly string[]) => void;
const sinkHost = globalThis as typeof globalThis & {
  [TOKEN_CLASS_SINK]?: TokenClassSink;
};
export function setTokenClassSink(sink: TokenClassSink): void {
  sinkHost[TOKEN_CLASS_SINK] = sink;
}

// Highlighted HTML carries token classes whose CSS lives in the registry
// above, so a memo of it is only valid while the registry is: clearing one
// clears the other. Shared across bundled copies of this module like the
// registry itself.
const HIGHLIGHTS = Symbol.for("@cloudflare/nimbus-docs/highlighted-code");
type Highlighted = { html: string; classes: string[] };
type HighlightEntry = {
  result: Promise<Highlighted>;
  settled?: Highlighted;
  bytes: number;
  /** CSS for a highlight saved by an earlier build, restored on first use. */
  rules?: string;
};
type HighlightMemo = {
  entries: Map<string, HighlightEntry>;
  bytes: number;
  /** Saved highlight files already read since the registry was cleared. */
  loaded: Set<string>;
  /** Highlights computed in this process, so a save can tell if anything is new.
   * Never reset, so a count from before a registry clear never matches. */
  computed: number;
};
const highlightHost = globalThis as typeof globalThis & {
  [HIGHLIGHTS]?: HighlightMemo;
};
const highlights = (highlightHost[HIGHLIGHTS] ??= {
  entries: new Map(),
  bytes: 0,
  loaded: new Set(),
  computed: 0,
});
const HIGHLIGHT_MEMO_BYTES = 64 * 1024 * 1024;

function remember(key: string, entry: HighlightEntry, html: string): void {
  entry.bytes = key.length + html.length;
  highlights.bytes += entry.bytes;
  for (const [oldest, { bytes }] of highlights.entries) {
    if (highlights.bytes <= HIGHLIGHT_MEMO_BYTES) break;
    highlights.entries.delete(oldest);
    highlights.bytes -= bytes;
  }
}

/** Highlight each distinct `key` once while the registry holds its styles. */
export function highlightOnce(
  key: string,
  highlight: () => Promise<Highlighted>,
): Promise<string> {
  let entry = highlights.entries.get(key);
  if (!entry) {
    const created: HighlightEntry = { result: highlight(), bytes: 0 };
    entry = created;
    highlights.entries.set(key, created);
    created.result.then(
      (value) => {
        if (highlights.entries.get(key) !== created) return;
        created.settled = value;
        highlights.computed++;
        remember(key, created, value.html);
      },
      () => {
        if (highlights.entries.get(key) === created) highlights.entries.delete(key);
      },
    );
  } else if (entry.rules !== undefined) {
    restoreCodeStyleCSS(entry.rules);
    entry.rules = undefined;
  }
  // Reported in each caller's own continuation: concurrent versions can
  // share one in-flight highlight, and each needs the classes.
  return entry.result.then(({ html, classes }: Highlighted) => {
    sinkHost[TOKEN_CLASS_SINK]?.(classes);
    return html;
  });
}

export type SavedHighlight = [key: string, html: string, classes: string[], rules: string];

/** How many highlights this process has computed, never reset. */
export function highlightsComputed(): number {
  return highlights.computed;
}

export function highlightsLoaded(source: string): boolean {
  return highlights.loaded.has(source);
}

/** Add highlights an earlier build saved; ones already in memory are kept. */
export function loadHighlights(
  source: string,
  saved: Iterable<SavedHighlight>,
): void {
  highlights.loaded.add(source);
  for (const [key, html, classes, rules] of saved) {
    if (highlights.entries.has(key)) continue;
    const settled = { html, classes };
    const entry: HighlightEntry = { result: Promise.resolve(settled), settled, bytes: 0, rules };
    highlights.entries.set(key, entry);
    remember(key, entry, html);
  }
}

/** Every finished highlight, oldest first, with the CSS its classes need. */
export function savedHighlights(): { computed: number; entries: SavedHighlight[] } {
  const rules = new Map<string, string>();
  for (const rule of getCodeStyleCSS().split("\n"))
    if (rule) rules.set(rule.slice(1, rule.search(/[\s{]/)), rule);
  const entries: SavedHighlight[] = [];
  for (const [key, entry] of highlights.entries) {
    if (!entry.settled) continue;
    const { html, classes } = entry.settled;
    const css =
      entry.rules ?? classes.map((name: string) => rules.get(name) ?? "").filter(Boolean).join("\n");
    entries.push([key, html, classes, css]);
  }
  return { computed: highlights.computed, entries };
}

export function clearCodeStyleRegistry(): void {
  styleToClass.clearRegistry();
  restoredStyles.clear();
  highlights.entries.clear();
  highlights.bytes = 0;
  highlights.loaded.clear();
}
