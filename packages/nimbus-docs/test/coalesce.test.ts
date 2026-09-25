// Guards the dev spec-refresh queue: one refresh at a time, and an edit made
// during a refresh always gets a run that starts after it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { coalesce } from "../src/_internal/coalesce.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test("requests during a run queue exactly one more run, started after them", async () => {
  const gates: Array<ReturnType<typeof deferred>> = [];
  const events: string[] = [];
  let running = 0;
  const schedule = coalesce(
    async () => {
      running++;
      assert.equal(running, 1, "runs never overlap");
      const run = gates.length + 1;
      events.push(`start ${run}`);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      events.push(`end ${run}`);
      running--;
    },
    (error) => assert.fail(String(error)),
  );

  const first = schedule();
  await Promise.resolve();
  events.push("edit a");
  const second = schedule();
  events.push("edit b");
  schedule();
  assert.equal(first, second, "requests share the drain in flight");

  gates[0]!.resolve();
  while (gates.length < 2) await new Promise((resolve) => setImmediate(resolve));
  gates[1]!.resolve();
  await first;

  assert.deepEqual(events, ["start 1", "edit a", "edit b", "end 1", "start 2", "end 2"]);
  assert.equal(gates.length, 2, "a burst of edits costs one extra run");
});

test("a failed run is reported and later requests still run", async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const schedule = coalesce(
    async () => {
      runs++;
      if (runs === 1) throw new Error("boom");
    },
    (error) => errors.push(error),
  );
  await schedule();
  await schedule();
  assert.equal(runs, 2);
  assert.deepEqual(errors.map((error) => (error as Error).message), ["boom"]);
});
