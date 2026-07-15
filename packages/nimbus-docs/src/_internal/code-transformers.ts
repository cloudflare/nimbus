/**
 * code-transformers.ts — Shiki transformer chain used both by the
 * markdown pipeline (registered into `shikiConfig.transformers` from
 * the Astro integration so fenced MDX blocks pick them up) and by the
 * user's `<Code>` component (Astro's built-in `<Code>` accepts
 * `transformers` as a prop but does *not* auto-read `shikiConfig`).
 *
 * The single source of truth lives here so both paths get the same
 * polish. The chain is:
 *
 *   - The four `@shikijs/transformers` *notation* transformers (diff,
 *     highlight, focus, error-level) plus word-highlight — these read
 *     `// [!code …]` comments inside the code body and are kept as-is.
 *   - `nimbusMetaTransformer()` — a single Nimbus-owned transformer that
 *     owns ALL fence-meta semantics (the bit after the language token in
 *     ```` ```ts title="x" {1,3} ins={2} "needle" wrap ````). It replaces
 *     the stock `transformerMetaHighlight` + `transformerMetaWordHighlight`
 *     which double-fired, hijacked the first `{}` of any meta (so `ins={}`
 *     / `del={}` / `collapse={}` were mis-read as plain highlights), failed
 *     on spaced ranges, and only understood `/word/` (never EC's `"word"`).
 *     See `parseNimbusMeta` for the full grammar and precedence rules.
 *   - `titleAndLangTransformer()` — wraps the `<pre>` in a `<figure>` with
 *     an optional `<figcaption class="nb-code-title">` and a `data-nb-lang`
 *     badge hook.
 */

// `@shikijs/types` is a dedicated types-only package — devDep here, used
// internally by `shiki` and `@shikijs/transformers`. Avoids importing from
// the `shiki` runtime package (which we don't ship as a direct dep).
import type { ShikiTransformer } from "@shikijs/types";
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationErrorLevel,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { getCodeStyleTransformer } from "./code-style-registry.js";

export interface DefaultCodeTransformersOptions {
  /** Convert repeated Shiki inline token styles to shared `nb-shiki-*` classes. */
  classTokens?: boolean;
  /** User transformers that must run before style classing and title wrapping. */
  beforeTitleTransformers?: ShikiTransformer[];
}

/**
 * Parse Shiki meta string (the bit after the language fence:
 * ```ts title="src/foo.ts" {1,3}`) for the `title="..."` key.
 * Returns `undefined` when the meta has no title.
 */
function parseTitle(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  const match = meta.match(/\btitle="([^"]+)"/) ?? meta.match(/\btitle='([^']+)'/);
  return match?.[1];
}

/**
 * Structured representation of an Expressive-Code-style fence meta string.
 *
 * Precedence is the whole point: keyed forms (`ins=`, `del=`, `collapse=`,
 * `title=`, `frame=`) and quoted search words are consumed *before* bare
 * `{…}` is interpreted as a plain line-highlight, so `ins={3}` can never be
 * mis-read as "highlight line 3". A meta either renders correctly or is left
 * as plain code — it must never highlight the wrong lines.
 */
export interface NimbusMeta {
  /** Lines from bare `{…}` ranges → `line highlighted`. */
  highlightLines: Set<number>;
  /** Lines from `ins={…}` → `line diff add`. */
  insLines: Set<number>;
  /** Lines from `del={…}` → `line diff remove`. */
  delLines: Set<number>;
  /** Tokens from `ins="…"` — any line containing one → `line diff add`. */
  insTokens: string[];
  /** Tokens from `del="…"` — any line containing one → `line diff remove`. */
  delTokens: string[];
  /** Standalone quoted strings → `highlighted-word` spans. */
  searchWords: string[];
  /** Lines from `collapse={…}` — rendered neutral (no false highlight). */
  collapseLines: Set<number>;
  /** `wrap` keyword → soft-wrap long lines (no horizontal scroll). */
  wrap: boolean;
  /** `frame="…"` value, if any (chrome hook; otherwise neutral). */
  frame?: string;
}

/**
 * Expand a (possibly space-padded) line-range spec like `5-16, 21-40` or
 * `1,3-5` into an explicit list of 1-based line numbers. Tolerates spaces
 * anywhere — `{5-16, 21-40}` expands to the same set as `{5-16,21-40}`.
 */
function expandRanges(spec: string): number[] {
  const out: number[] = [];
  for (const partRaw of spec.split(",")) {
    const part = partRaw.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = Number.parseInt(range[1]!, 10);
      const b = Number.parseInt(range[2]!, 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) out.push(i);
    } else if (/^\d+$/.test(part)) {
      out.push(Number.parseInt(part, 10));
    }
  }
  return out;
}

/**
 * Parse an EC-style fence meta string into {@link NimbusMeta}.
 *
 * Order matters — each step consumes (blanks out) what it matched so later,
 * looser patterns can't re-grab it:
 *   1. `frame="…"`            (quoted)
 *   2. `title="…"`            (quoted; value resolved separately)
 *   3. `ins="…"` / `del="…"`  (quoted tokens)
 *   4. `ins={…}` / `del={…}` / `collapse={…}`  (brace ranges)
 *   5. standalone `"…"`/`'…'` (search words — what's left of the quotes)
 *   6. `wrap`                 (bare keyword)
 *   7. bare `{…}`             (plain line-highlight — only what survives)
 */
export function parseNimbusMeta(raw: string | undefined): NimbusMeta {
  const meta: NimbusMeta = {
    highlightLines: new Set(),
    insLines: new Set(),
    delLines: new Set(),
    insTokens: [],
    delTokens: [],
    searchWords: [],
    collapseLines: new Set(),
    wrap: false,
    frame: undefined,
  };
  if (!raw) return meta;
  let s = raw;

  // 1. frame="…" — record the value, then blank it out.
  s = s.replace(/\bframe=(?:"([^"]*)"|'([^']*)')/g, (_m, d, sg) => {
    const v = d ?? sg;
    if (v) meta.frame = v;
    return " ";
  });

  // 2. title="…" — value is resolved by parseTitle(); just consume it here
  //    so any braces/quotes inside the filename can't trip later steps.
  s = s.replace(/\btitle=(?:"([^"]*)"|'([^']*)')/g, () => " ");

  // 3. ins="TOKEN" / del="TOKEN" — quoted string forms (before bare quotes).
  s = s.replace(/\bins=(?:"([^"]*)"|'([^']*)')/g, (_m, d, sg) => {
    const v = d ?? sg;
    if (v) meta.insTokens.push(v);
    return " ";
  });
  s = s.replace(/\bdel=(?:"([^"]*)"|'([^']*)')/g, (_m, d, sg) => {
    const v = d ?? sg;
    if (v) meta.delTokens.push(v);
    return " ";
  });

  // 4. ins={…} / del={…} / collapse={…} — brace ranges (before bare braces).
  s = s.replace(/\bins=\{([^}]*)\}/g, (_m, spec) => {
    for (const n of expandRanges(spec)) meta.insLines.add(n);
    return " ";
  });
  s = s.replace(/\bdel=\{([^}]*)\}/g, (_m, spec) => {
    for (const n of expandRanges(spec)) meta.delLines.add(n);
    return " ";
  });
  s = s.replace(/\bcollapse=\{([^}]*)\}/g, (_m, spec) => {
    for (const n of expandRanges(spec)) meta.collapseLines.add(n);
    return " ";
  });

  // 5. standalone quoted strings → search words. Run before `wrap` so a
  //    literal `"wrap"` search term isn't mistaken for the wrap keyword.
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const v = m[1] ?? m[2];
    if (v) meta.searchWords.push(v);
  }
  s = s.replace(/"[^"]*"|'[^']*'/g, " ");

  // 6. wrap — bare keyword.
  s = s.replace(/\bwrap\b/g, () => {
    meta.wrap = true;
    return " ";
  });

  // 7. bare {…} → plain line-highlight (only ranges that survived steps 1-6).
  s = s.replace(/\{([^}]*)\}/g, (_m, spec) => {
    for (const n of expandRanges(spec)) meta.highlightLines.add(n);
    return " ";
  });

  return meta;
}

/**
 * Minimal structural view of a hast node — enough to walk text content
 * without taking a direct dependency on the `hast`/`@types/hast` module
 * (which is only available transitively here).
 */
type HastNode =
  | { type: "text"; value: string }
  | { type: string; value?: string; children?: HastNode[] };

/** Collect the plain-text content of a hast line node (concatenates spans). */
function lineText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  let out = "";
  if ("children" in node && node.children) {
    for (const child of node.children) out += lineText(child);
  }
  return out;
}

/** Find every (non-overlapping) start index of `substr` in `str`. */
function findAllSubstringIndexes(str: string, substr: string): number[] {
  const out: number[] = [];
  if (!substr) return out;
  let cursor = 0;
  for (;;) {
    const index = str.indexOf(substr, cursor);
    if (index === -1) break;
    out.push(index);
    cursor = index + substr.length;
  }
  return out;
}

const META_SYMBOL = Symbol("nimbus-meta");

interface MetaCarrier {
  [META_SYMBOL]?: NimbusMeta;
}

/**
 * The canonical Shiki transformer chain for Nimbus. Returns a fresh
 * array each call so callers don't accidentally mutate a shared list.
 *
 * Used by:
 *   - `integration.ts` → `shikiConfig.transformers` (fenced MDX blocks)
 *   - `Code.astro` in the starter → `transformers` prop on Astro's
 *     built-in `<Code>` component (and by extension, anything that
 *     composes `<Code>` such as `<CodeGroup>`)
 */
export function defaultCodeTransformers(
  options: DefaultCodeTransformersOptions = {},
): ShikiTransformer[] {
  const beforeTitle = options.beforeTitleTransformers ?? [];
  return [
    transformerNotationDiff(),
    transformerNotationHighlight(),
    transformerNotationFocus(),
    transformerNotationErrorLevel(),
    transformerNotationWordHighlight(),
    nimbusMetaTransformer(),
    ...beforeTitle,
    ...(options.classTokens ? [getCodeStyleTransformer()] : []),
    titleAndLangTransformer(),
  ];
}

/**
 * Nimbus-owned fence-meta transformer. Owns bare-brace highlight
 * (space-tolerant), `ins=`/`del=` (brace + quoted-string forms),
 * quoted-search word highlight, `wrap`, `collapse` (neutral), and a
 * `frame=` hook. Replaces the stock meta-highlight + meta-word-highlight
 * transformers, which double-fired and hijacked braces.
 */
export function nimbusMetaTransformer(): ShikiTransformer {
  function getMeta(ctx: { meta?: unknown; options: { meta?: { __raw?: string } } }): NimbusMeta {
    const carrier = (ctx.meta ?? {}) as MetaCarrier;
    if (!carrier[META_SYMBOL]) {
      carrier[META_SYMBOL] = parseNimbusMeta(ctx.options.meta?.__raw);
    }
    return carrier[META_SYMBOL]!;
  }

  return {
    name: "nimbus:meta",

    // Quoted search words are applied as decorations over the raw source —
    // same mechanism the stock word-highlight uses for `/word/`, but reading
    // EC's `"word"` form. Decorations split tokens cleanly on the hast.
    preprocess(code, options) {
      if (!this.options.meta?.__raw) return;
      const meta = getMeta(this);
      if (meta.searchWords.length === 0) return;
      options.decorations ||= [];
      for (const word of meta.searchWords) {
        for (const index of findAllSubstringIndexes(code, word)) {
          options.decorations.push({
            start: index,
            end: index + word.length,
            properties: { class: "highlighted-word" },
          });
        }
      }
    },

    // Per-line: apply highlight + diff-add/remove classes. `collapse` lines
    // are intentionally left neutral (no class) — the key fix is that they
    // are NEVER highlighted.
    line(node, lineNumber) {
      if (!this.options.meta?.__raw) return;
      const meta = getMeta(this);

      if (meta.highlightLines.has(lineNumber)) {
        this.addClassToHast(node, "highlighted");
      }
      if (meta.insLines.has(lineNumber)) {
        this.addClassToHast(node, "diff add");
      }
      if (meta.delLines.has(lineNumber)) {
        this.addClassToHast(node, "diff remove");
      }

      if (meta.insTokens.length || meta.delTokens.length) {
        const text = lineText(node as unknown as HastNode);
        if (meta.insTokens.some((t) => text.includes(t))) {
          this.addClassToHast(node, "diff add");
        }
        if (meta.delTokens.some((t) => text.includes(t))) {
          this.addClassToHast(node, "diff remove");
        }
      }
    },

    // Block-level hooks for `wrap` (soft-wrap) and `frame=` (chrome). Set on
    // the <pre>; `titleAndLangTransformer` later wraps this same node in a
    // <figure>, so the attributes persist and can drive CSS from either.
    pre(preNode) {
      if (!this.options.meta?.__raw) return;
      const meta = getMeta(this);
      preNode.properties = preNode.properties ?? {};
      if (meta.wrap) preNode.properties["data-nb-wrap"] = "";
      if (meta.frame) preNode.properties["data-nb-frame"] = meta.frame;
    },
  };
}

export function titleAndLangTransformer(): ShikiTransformer {
  return {
    name: "nimbus:title-and-lang",
    pre(preNode) {
      const lang = this.options.lang || "text";
      const meta: string | undefined = (this.options.meta as { __raw?: string } | undefined)?.__raw;
      const title = parseTitle(meta);

      // Always tag the pre with its language for CSS.
      preNode.properties = preNode.properties ?? {};
      preNode.properties["data-nb-lang"] = lang;

      // Carry the wrap/frame hooks up onto the figure too, so CSS can target
      // either the <pre> or the framing <figure>.
      const wrap = preNode.properties["data-nb-wrap"] !== undefined;
      const frame = preNode.properties["data-nb-frame"];

      // Always wrap in a <figure>. With title → figcaption + pre. Without
      // title → just the pre, but the figure still provides a non-scrolling
      // positioning context so the language badge (rendered via CSS on the
      // figure) stays pinned at top-right even when the pre overflows
      // horizontally on mobile.
      const children: (typeof preNode)[] = [];
      if (title) {
        children.push({
          type: "element",
          tagName: "figcaption",
          properties: { class: "nb-code-title" },
          children: [
            {
              type: "element",
              tagName: "span",
              properties: { class: "nb-code-title-name" },
              children: [{ type: "text", value: title }],
            },
            {
              type: "element",
              tagName: "span",
              properties: { class: "nb-code-title-lang" },
              children: [{ type: "text", value: lang }],
            },
          ],
        });
      }
      children.push(preNode);

      const figureProps: Record<string, string> = {
        class: title ? "nb-code-figure nb-code-figure-titled" : "nb-code-figure",
        "data-nb-lang": lang,
      };
      if (wrap) figureProps["data-nb-wrap"] = "";
      if (typeof frame === "string") figureProps["data-nb-frame"] = frame;

      return {
        type: "element",
        tagName: "figure",
        properties: figureProps,
        children,
      };
    },
  };
}
