/** Try it's staged plan files: `.astro/nimbus/try-it/`, served as `/_nimbus/try-it/`. Build-only. */
import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../page-assets-build.js";
import type { RequestPlan } from "./plan.js";
import { isLocalHost, originMatches } from "./config.js";
import type { ProxyPolicy } from "./proxy.js";

export const STAGED_PLANS = path.join(".astro", "nimbus", "try-it");

export async function stageTryItPlan(root: string, file: string, body: string): Promise<void> {
  const target = path.join(root, STAGED_PLANS, file);
  try {
    await access(target);
  } catch {
    await writeAtomic(target, body);
  }
}

/** Copy every staged plan into the built client output. */
export async function deployTryItPlans(root: string, clientDirectory: string): Promise<number> {
  const source = path.join(root, STAGED_PLANS);
  let files: string[];
  try {
    files = (await readdir(source)).filter((file) => file.endsWith(".json"));
  } catch {
    return 0;
  }
  if (files.length === 0) return 0;
  const target = path.join(clientDirectory, "_nimbus", "try-it");
  await mkdir(target, { recursive: true });
  await Promise.all(files.map((file) => cp(path.join(source, file), path.join(target, file))));
  return files.length;
}

/** Where each API entry's proxy policy is staged, for the route's virtual module. */
export const STAGED_POLICIES = path.join(".astro", "nimbus", "try-it-policy");

/** Write (or, with `null`, remove) one API entry's proxy policy. A local or
 *  private origin is left out, with a warning, unless `extraOrigins` lists it. */
export async function stageTryItPolicy(root: string, key: string, policy: ProxyPolicy | null, warn: (message: string) => void = () => {}): Promise<void> {
  const file = path.join(root, STAGED_POLICIES, `${encodeURIComponent(key)}.json`);
  if (policy) await writeAtomic(file, JSON.stringify({ key, ...policy, origins: relayOrigins(policy, warn) }));
  else await rm(file, { force: true });
}

/** The spec's origins the relay carries: public ones. The owner lists a local one in `extraOrigins` to relay it. */
export function relayOrigins(policy: Pick<ProxyPolicy, "origins" | "extraOrigins">, warn: (message: string) => void = () => {}): string[] {
  return policy.origins.filter((origin) => {
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      return false; // `"self"` from an older build's cache: relative servers aren't relayed
    }
    if (!isLocalHost(host)) return true;
    if (!policy.extraOrigins.some((pattern) => originMatches(origin, pattern))) {
      warn(`Try it's relay won't carry ${origin}: it's a local or private address. To relay it anyway, add "${origin}" to the API's tryIt.proxy.extraOrigins.`);
    }
    return false;
  });
}

/** How many origins one server's authority variables may spell; past it the
 *  relay lists none of that server's, and `tooMany` names it. */
export const MAX_SERVER_ORIGINS = 4096;

/** The origins a plan's servers can resolve to: authority variables over their
 *  declared values (or their default); relative servers aren't relayed. A path
 *  variable never changes the origin, so only its default is used. */
export function planOrigins(plan: RequestPlan, tooMany: (server: string, count: number) => void = () => {}): string[] {
  const out = new Set<string>();
  for (const server of plan.servers) {
    const choices = server.variables.map((variable) =>
      variable.authority && variable.enum?.length ? variable.enum : [variable.default]);
    const count = choices.reduce((total, values) => total * values.length, 1);
    if (count > MAX_SERVER_ORIGINS) {
      tooMany(server.url, count);
      continue;
    }
    let urls = [server.url];
    server.variables.forEach((variable, i) => {
      urls = urls.flatMap((url) => choices[i]!.map((value) => url.split(`{${variable.name}}`).join(value)));
    });
    for (const url of urls) {
      // A protocol-relative server takes the page's (or spec's) scheme: either.
      for (const candidate of url.startsWith("//") ? [`https:${url}`, `http:${url}`] : [url]) {
        try {
          // A relative server is the docs site's own origin: the browser sends there directly.
          const resolved = new URL(candidate, "https://self.nimbus.invalid");
          if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
          if (resolved.host !== "self.nimbus.invalid") out.add(resolved.origin);
        } catch {
          // A server that isn't a URL contributes nothing.
        }
      }
    }
  }
  return [...out].sort();
}
