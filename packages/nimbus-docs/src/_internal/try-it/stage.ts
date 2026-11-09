/** Try it's staged plan files: `.astro/nimbus/try-it/`, served as `/_nimbus/try-it/`. Build-only. */
import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../page-assets-build.js";
import type { RequestPlan } from "./plan.js";
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

/** Write (or, with `null`, remove) one API entry's proxy policy. */
export async function stageTryItPolicy(root: string, key: string, policy: ProxyPolicy | null): Promise<void> {
  const file = path.join(root, STAGED_POLICIES, `${encodeURIComponent(key)}.json`);
  if (policy) await writeAtomic(file, JSON.stringify({ key, ...policy }));
  else await rm(file, { force: true });
}

/** The origins a plan's servers can resolve to: authority variables over their
 *  declared values (or their default), relative servers as `"self"`. */
export function planOrigins(plan: RequestPlan): string[] {
  const out = new Set<string>();
  for (const server of plan.servers) {
    let urls = [server.url];
    for (const variable of server.variables) {
      const values = variable.authority ? (variable.enum?.length ? variable.enum : [variable.default]) : [variable.default];
      urls = urls.flatMap((url) => values.map((value) => url.split(`{${variable.name}}`).join(value))).slice(0, 256);
    }
    for (const url of urls) {
      try {
        const resolved = new URL(url, "https://self.nimbus.invalid");
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
        out.add(resolved.host === "self.nimbus.invalid" ? "self" : resolved.origin);
      } catch {
        // A server that isn't a URL contributes nothing.
      }
    }
  }
  return [...out].sort();
}
