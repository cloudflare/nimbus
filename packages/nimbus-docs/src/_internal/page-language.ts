import { loadNimbusConfig } from "./runtime-config.js";

/** A page's language and its writing direction, for `<html lang dir>`. */
export interface PageLanguage {
  lang: string;
  /** `"rtl"` for a right-to-left language; unset otherwise, the HTML default. */
  dir?: "rtl";
}

/**
 * The language a page is in, `locale` or else the site's `config.locale`
 * (`"en"` by default), and `dir: "rtl"` when that language is written right to
 * left. Direction comes from the platform's Unicode data (`Intl.Locale` text
 * info), so every right-to-left script counts and an explicit script wins:
 * `ar` is right to left, `ar-Latn` isn't. An invalid tag, or a runtime without
 * text info, gives no `dir`.
 */
export async function getPageLanguage(locale?: string): Promise<PageLanguage> {
  const lang = locale ?? (await loadNimbusConfig()).locale ?? "en";
  return textDirection(lang) === "rtl" ? { lang, dir: "rtl" } : { lang };
}

type TextInfo = { direction?: string };

function textDirection(tag: string): string | undefined {
  try {
    const locale = new Intl.Locale(tag) as Intl.Locale & { getTextInfo?: () => TextInfo; textInfo?: TextInfo };
    return (locale.getTextInfo?.() ?? locale.textInfo)?.direction;
  } catch {
    return undefined;
  }
}
