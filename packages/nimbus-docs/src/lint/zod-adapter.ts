/**
 * Adapter: a Zod error → `RuleReport[]`, with each issue mapped onto the
 * line of the offending frontmatter key. Consumed by
 * `nimbus/frontmatter-shape`; kept separate so any future rule that
 * validates structured data through Zod can route through the same shape.
 *
 * Typed structurally against the ZodError surface we use (just `issues`)
 * so it doesn't pin a specific `astro/zod` version.
 */

import type { RuleReport } from "./rule.js";

interface ZodIssueLike {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

interface ZodErrorLike {
  issues: ReadonlyArray<ZodIssueLike>;
}

/**
 * Convert each Zod issue into a report. The position is resolved by
 * locating the top-level frontmatter key in the raw YAML; falls back to
 * the first frontmatter line when the key can't be found (e.g. a missing
 * required field, or a nested path whose root key was omitted).
 */
export function zodErrorToReports(
  error: ZodErrorLike,
  opts: { frontmatterRaw: string; frontmatterStartLine: number },
): RuleReport[] {
  return error.issues.map((issue) => {
    const dottedPath = issue.path
      .filter((p): p is string | number => typeof p !== "symbol")
      .join(".");
    const rootKey = issue.path.find((p): p is string => typeof p === "string");
    const { line, column } = locateKey(
      opts.frontmatterRaw,
      rootKey,
      opts.frontmatterStartLine,
    );
    const label = dottedPath.length > 0 ? dottedPath : "(frontmatter)";
    return { message: `${label}: ${issue.message}`, line, column };
  });
}

/**
 * Find the 1-based source line/column of a top-level YAML key. The column
 * points at the start of the key. Returns the frontmatter's first line at
 * column 1 when the key isn't present.
 */
function locateKey(
  frontmatterRaw: string,
  key: string | undefined,
  startLine: number,
): { line: number; column: number } {
  if (key) {
    const rawLines = frontmatterRaw.split("\n");
    const pattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*:`);
    for (let i = 0; i < rawLines.length; i++) {
      const match = rawLines[i]!.match(pattern);
      if (match) {
        return { line: startLine + i, column: match[1]!.length + 1 };
      }
    }
  }
  return { line: startLine, column: 1 };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
