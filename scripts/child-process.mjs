import crossSpawn from "cross-spawn";

export function spawnCommand(bin, args, options = {}) {
  return crossSpawn(bin, args, options);
}

export function spawnCommandSync(bin, args, options = {}) {
  return crossSpawn.sync(bin, args, options);
}
