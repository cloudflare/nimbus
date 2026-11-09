/** Try it's staged plan files: `.astro/nimbus/try-it/`, served as `/_nimbus/try-it/`. Build-only. */
import { access, cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../page-assets-build.js";

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
