import { bundledLanguagesInfo } from "shiki";

// Shiki throws on a language name outside this set.
export const SHIKI_KNOWN: ReadonlySet<string> = new Set(
  bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])]),
);
