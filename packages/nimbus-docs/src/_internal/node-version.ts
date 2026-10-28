import { lt, minVersion } from "semver";
import pkg from "../../package.json" with { type: "json" };

export const MIN_NODE_VERSION = minVersion(pkg.engines.node)!.version;

export function supportsNodeVersion(version: string): boolean {
  return !lt(version, MIN_NODE_VERSION);
}
