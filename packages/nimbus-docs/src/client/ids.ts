/**
 * Generate a unique ID with a prefix, scoped to the page.
 *
 * Used to build ARIA relationships (`aria-controls` / `aria-labelledby`)
 * between elements that don't have a stable author-provided id.
 */

let counter = 0;

export function generateId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
