// Atomic write: temp sibling → fsync → rename, so a crash never truncates the
// user's source file the CLI is editing in place.

import fs from "node:fs";
import { randomUUID } from "node:crypto";

export function writeFileAtomic(
  file: string,
  content: string,
  options: { overwrite?: boolean; expectedContent?: string } = {},
): void {
  const tmp = `${file}.nimbus-tmp-${process.pid}-${randomUUID()}`;
  try {
    let mode = 0o666 & ~process.umask();
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
    }
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (options.expectedContent !== undefined) {
      let current: string;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        throw new Error(`Refusing to replace ${file} because it changed or became unreadable during the write.`);
      }
      if (current !== options.expectedContent) {
        throw new Error(`Refusing to replace ${file} because it changed during the write.`);
      }
    }
    if (options.overwrite === false) {
      fs.linkSync(tmp, file);
      try {
        fs.unlinkSync(tmp);
      } catch {
      }
    } else {
      fs.renameSync(tmp, file);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
