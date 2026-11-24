import * as p from "@clack/prompts";

export interface Progress {
  start: (message: string) => void;
  stop: (message: string) => void;
  /** Ends with the error mark in a terminal, or prints an error line without one. */
  error: (message: string) => void;
}

/**
 * clack's spinner redraws its line with cursor escapes, which land in CI logs
 * and agent transcripts as frames and junk. Without a terminal, print the
 * start and the outcome as plain log lines instead.
 */
export function progress(isTTY = process.stdout.isTTY === true): Progress {
  if (isTTY) return p.spinner();
  return {
    start: (message) => p.log.step(message),
    stop: (message) => p.log.step(message),
    error: (message) => p.log.error(message),
  };
}
