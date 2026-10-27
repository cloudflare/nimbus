import { getReleasePlan } from "@changesets/get-release-plan";
import { spawnCommandSync } from "./child-process.mjs";

const plan = await getReleasePlan(process.cwd());
if (plan.changesets.length > 0 || plan.preState?.mode === "exit") {
  const result = spawnCommandSync("pnpm", ["exec", "changeset", "version"], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
