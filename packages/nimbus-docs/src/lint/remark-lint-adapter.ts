/**
 * Adapter: run a remark-lint rule against the Sätteri mdast tree, return
 * `RuleReport[]`. Mirrors the `zod-adapter` shape — a tiny translation
 * layer that keeps the diagnostic envelope intact while letting us inherit
 * remark-lint's battle-tested detector logic.
 *
 * Why this is safe under the Sätteri constraint: the "remark plugins
 * no-op" behaviour applies to render-time transforms attached to
 * `markdown.processor`. Lint rules are read-only `(tree, file) => void`
 * functions that walk an mdast and push messages onto a VFile — no
 * mutation, no render-path involvement. Sätteri already gives us a JS
 * mdast tree; we're calling these rules directly on it.
 *
 * Locked to `runSync` so the lint engine stays synchronous (no Promise
 * propagation through `lintFile`).
 */

import { unified } from "unified";
import { VFile } from "vfile";

import type { MdRoot } from "./parse.js";
import type { RuleReport } from "./rule.js";

/**
 * Wide plugin shape: each `remark-lint-*` package exports a `Plugin` with
 * different options/tree generics, which TypeScript treats as mutually
 * unassignable to the bare `Plugin` type. The runtime contract is the
 * same — accept settings, walk the tree, push messages on a VFile — so
 * we widen here and forward through the `as never` casts already
 * present in the runtime call.
 */
type AnyPlugin = (...args: never[]) => unknown;

export interface RemarkLintRunOptions {
  /** Source path for the VFile. Used by some rules for context, never
   * displayed by our envelope. */
  path: string;
  /** Full source text. Some remark-lint rules read this for span context. */
  source: string;
  /**
   * Plugin options forwarded to `.use(rule, ...settings)`. Mirrors
   * unified's variadic surface — a single primitive is passed through as
   * one argument; an array is spread (matching how unified parses
   * `[plugin, ...settings]` tuples). Omit when the rule takes no options.
   */
  settings?: unknown[];
}

/**
 * Run one remark-lint rule (a unified plugin) against an mdast tree and
 * collect its messages as `RuleReport[]`.
 *
 * Each VFileMessage carries `line`/`column`; we use them verbatim and
 * preserve any end-position the rule emits.
 */
export function runRemarkLintRule(
  rule: AnyPlugin,
  tree: MdRoot,
  opts: RemarkLintRunOptions,
): RuleReport[] {
  const file = new VFile({ path: opts.path, value: opts.source });

  // `runSync` is safe for any rule that's synchronous (every shipped
  // remark-lint rule we adopt should be). If a future rule is async,
  // adopting it would require routing through an async path — flag
  // explicitly rather than silently hide the latency.
  const settings = opts.settings ?? [];
  unified()
    // The `as never` cast lets us forward variadic settings without
    // unified's overload-narrowing fighting us; the runtime call
    // matches unified's documented `use(plugin, ...settings)` shape.
    .use(rule as never, ...settings)
    .runSync(tree as never, file);

  return file.messages.map((msg): RuleReport => {
    // `reason` is the canonical message field on VFileMessage; older
    // `message` is the alias. Prefer reason when both are present.
    const message = msg.reason || msg.message || "";

    // Position: rules attach `place` (newer) or `position` (legacy) for
    // span information. Fall back to the flat `line`/`column` fields.
    const place = (msg as { place?: unknown }).place;
    const span = positionFromPlace(place) ?? positionFromMessage(msg);

    return {
      message,
      line: span.line,
      column: span.column,
      endLine: span.endLine,
      endColumn: span.endColumn,
    };
  });
}

interface SpanFields {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

function positionFromPlace(place: unknown): SpanFields | null {
  if (!place || typeof place !== "object") return null;
  const p = place as {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
    line?: number;
    column?: number;
  };
  // `place` can be either a Point or a Position.
  if (p.start && typeof p.start.line === "number" && typeof p.start.column === "number") {
    const span: SpanFields = { line: p.start.line, column: p.start.column };
    if (p.end && typeof p.end.line === "number" && typeof p.end.column === "number") {
      span.endLine = p.end.line;
      span.endColumn = p.end.column;
    }
    return span;
  }
  if (typeof p.line === "number" && typeof p.column === "number") {
    return { line: p.line, column: p.column };
  }
  return null;
}

function positionFromMessage(msg: {
  line?: number | null;
  column?: number | null;
}): SpanFields {
  return {
    line: typeof msg.line === "number" ? msg.line : 1,
    column: typeof msg.column === "number" ? msg.column : 1,
  };
}
