export type AuthoredLinkNormalizer = (
  source: string,
  options: { base: string; sourceId?: string },
) => string;

const NORMALIZER_KEY = Symbol.for(
  "@cloudflare/nimbus-docs/authored-link-normalizer/v1",
);
const normalizerGlobal = globalThis as typeof globalThis & {
  [NORMALIZER_KEY]?: AuthoredLinkNormalizer;
};

export function registerAuthoredLinkNormalizer(
  normalizer: AuthoredLinkNormalizer,
): void {
  normalizerGlobal[NORMALIZER_KEY] = normalizer;
}

export function getAuthoredLinkNormalizer(): AuthoredLinkNormalizer {
  const normalizer = normalizerGlobal[NORMALIZER_KEY];
  if (!normalizer) {
    throw new Error(
      "nimbus-docs: Markdown preparation requires the Nimbus Astro integration.",
    );
  }
  return normalizer;
}
