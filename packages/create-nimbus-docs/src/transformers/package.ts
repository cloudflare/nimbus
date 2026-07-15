import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface UpdateOptions {
  name: string;
  deploy: "cloudflare" | "other";
}

export async function updatePackageJson(
  targetDir: string,
  options: UpdateOptions,
): Promise<void> {
  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;

  pkg.name = sanitizePackageName(options.name);
  pkg.version = "0.0.1";
  // A scaffolded docs site is an application, not a publishable package.
  // Keep `private: true` so an accidental `npm publish` is refused.
  pkg.private = true;

  if (options.deploy === "cloudflare") {
    pkg.devDependencies ??= {};
    pkg.scripts ??= {};

    // Wrangler ships Workers Static Assets — no Astro adapter needed. A
    // docs site is a pure static build; the adapter would only be paid-for
    // weight (and currently breaks vite resolution for satteri's WASI
    // entry under the cloudflare adapter context).
    pkg.devDependencies.wrangler = "^4.95.0";

    // Keep preview/deploy self-contained: Cloudflare projects always build first.
    // No linter chain — a fresh docs starter is mostly MDX, and `astro check`
    // already covers type safety. If users want biome/eslint later, they wire it in.
    pkg.scripts["prepreview:cf"] = "astro build";
    pkg.scripts["preview:cf"] = "wrangler dev";
    pkg.scripts.predeploy = "astro check && astro build";
    pkg.scripts.deploy = "wrangler deploy";
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function sanitizePackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[._]/, "")
    .slice(0, 214);
}
