import { transformerStyleToClass } from "@shikijs/transformers";

export const NIMBUS_DEFAULT_SHIKI_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

const styleToClass = transformerStyleToClass({ classPrefix: "nb-shiki-" });

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

export function getCodeStyleCSS(): string {
  return styleToClass.getCSS();
}

export function clearCodeStyleRegistry(): void {
  styleToClass.clearRegistry();
}
