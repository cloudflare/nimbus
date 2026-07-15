import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose class names with Tailwind conflict resolution. Vendored here so
 * the framework-surface files don't depend on a project-level `@/lib/cn`
 * alias.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
