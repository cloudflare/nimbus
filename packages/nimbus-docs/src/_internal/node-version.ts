import { satisfies } from "semver";
import pkg from "../../package.json" with { type: "json" };

export const NODE_VERSION_RANGE = pkg.engines.node;

export function supportsNodeVersion(version: string): boolean {
  return satisfies(version, NODE_VERSION_RANGE, { includePrerelease: true });
}
