import { transformerStyleToClass } from "@shikijs/transformers";

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

// Highlighted HTML carries token classes whose CSS lives in the registry
// above, so a memo of it is only valid while the registry is: clearing one
// clears the other. Shared across bundled copies of this module like the
// registry itself.
const HIGHLIGHTS = Symbol.for("@cloudflare/nimbus-docs/highlighted-code");
type HighlightMemo = {
  entries: Map<string, { html: Promise<string>; bytes: number }>;
  bytes: number;
};
const highlightHost = globalThis as typeof globalThis & {
  [HIGHLIGHTS]?: HighlightMemo;
};
const highlights = (highlightHost[HIGHLIGHTS] ??= { entries: new Map(), bytes: 0 });
const HIGHLIGHT_MEMO_BYTES = 64 * 1024 * 1024;

/** Highlight each distinct `key` once while the registry holds its styles. */
export function highlightOnce(
  key: string,
  highlight: () => Promise<string>,
): Promise<string> {
  const hit = highlights.entries.get(key);
  if (hit) return hit.html;
  const entry = { html: highlight(), bytes: 0 };
  highlights.entries.set(key, entry);
  entry.html.then(
    (html) => {
      if (highlights.entries.get(key) !== entry) return;
      entry.bytes = key.length + html.length;
      highlights.bytes += entry.bytes;
      for (const [oldest, { bytes }] of highlights.entries) {
        if (highlights.bytes <= HIGHLIGHT_MEMO_BYTES) break;
        highlights.entries.delete(oldest);
        highlights.bytes -= bytes;
      }
    },
    () => {
      if (highlights.entries.get(key) === entry) highlights.entries.delete(key);
    },
  );
  return entry.html;
}

export function clearCodeStyleRegistry(): void {
  styleToClass.clearRegistry();
  restoredStyles.clear();
  highlights.entries.clear();
  highlights.bytes = 0;
}
