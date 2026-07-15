/**
 * One channel for framework warnings emitted at render time (sidebar assembly,
 * git "last updated" lookups, indexed-entry loading). These run inside Astro's
 * SSR module graph, where a hook's `AstroIntegrationLogger` isn't reachable, so
 * they use a single consistent `[nimbus]` console channel. Integration hooks
 * should still prefer their own `logger`; the lint CLI uses `process.stderr`.
 */
export function runtimeWarn(message: string): void {
  console.warn(`[nimbus] ${message}`);
}
