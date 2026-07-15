"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDiagramOrDefault } from "../diagram";

export interface UsePhaseStepBase {
  /** Stable step id; appears as `current`. */
  id: string;
  /** Milliseconds to hold this step before advancing. */
  hold: number;
}

export interface UsePhaseStep<
  C extends Record<string, unknown> = Record<string, never>,
  D = unknown,
> extends UsePhaseStepBase {
  /**
   * Predicate gate. When false, this step is skipped for the current cycle.
   * Receives `{ cycle, current, ...context }` where `current` is the id of
   * the previous step that survived the predicate pass (empty string at
   * cycle start).
   */
  when?: (ctx: { cycle: number; current: string } & C) => boolean;
  /**
   * Arbitrary payload surfaced as `data` while this step holds — e.g.
   * which node/edge lights up. Replaces per-card `ACTIVE_MAP` lookup
   * tables; `data` is `null` when idle or when an autoplaying walker is
   * frozen by reduced motion.
   */
  data?: D;
}

export interface UsePhaseOptions<
  C extends Record<string, unknown> = Record<string, never>,
  D = unknown,
> {
  steps: UsePhaseStep<C, D>[];
  /** Values made available to each step's `when` predicate. */
  context?: C;
  /** When true (default), the sequence restarts after the last step. */
  loop?: boolean;
  /**
   * When true (default) the walker runs as soon as the diagram plays.
   * When false it starts idle (`current === ""`) and runs once per
   * `start()` call — the shape for click-triggered one-shot sequences.
   */
  autoplay?: boolean;
}

export interface UsePhaseReturn<D = unknown> {
  /** Id of the currently-active step. Empty string when idle or `steps` is empty. */
  current: string;
  /** Index into the *filtered* sequence for the current cycle. */
  index: number;
  /** Completed passes through the sequence. Starts at 0. */
  cycle: number;
  /** The active step's `data` payload. `null` when idle or motion-frozen. */
  data: D | null;
  /** True while the walker is active. Always true when `autoplay`. */
  running: boolean;
  /** Begin a run from the first step. No-op while already running. */
  start: () => void;
  /** Advance one step (or wrap to next cycle if at the end). */
  advance: () => void;
  /** Jump to a named step in the current cycle's sequence. Wakes an idle walker. */
  goto: (id: string) => void;
  /** Reset cycle and index to 0 (and return to idle when `autoplay: false`). */
  reset: () => void;
}

/**
 * Predicate-gated phase walker. Reads `playing` / `visible` / `tabVisible`
 * / `reducedMotion` from the surrounding `<Diagram>` and pauses
 * automatically when any gate fails.
 *
 * Steps may carry a `when(ctx)` predicate that filters them out for a
 * given cycle, and a `data` payload surfaced while the step holds. Mode
 * toggles, branches, alternating loops — anything cycle-dependent —
 * composes via the predicate plus user-supplied `context`.
 *
 * Two run modes:
 * - `autoplay: true` (default) — ambient looping animation. Freezes under
 *   reduced motion (`data` reads `null`).
 * - `autoplay: false` — idle until `start()`. Started runs are
 *   user-initiated *function*, not decoration: they keep advancing under
 *   reduced motion (gate your CSS transition durations card-side), and a
 *   `start()` while the page is paused arms as soon as play resumes.
 *
 * The scheduler depends on the current step's *values* (id, hold), not
 * on `steps` / `context` identity — inline literals are safe and won't
 * re-arm the hold timer under frequent re-renders.
 */
export function usePhase<
  C extends Record<string, unknown> = Record<string, never>,
  D = unknown,
>({
  steps,
  context,
  loop = true,
  autoplay = true,
}: UsePhaseOptions<C, D>): UsePhaseReturn<D> {
  const ctx = useDiagramOrDefault("usePhase");

  const [cycle, setCycle] = useState(0);
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(autoplay);

  // Build the filtered sequence for the current cycle. The `current` field
  // in each predicate's ctx is the id of the previous step that survived
  // (empty string at cycle start).
  const sequence = useMemo(() => {
    const seq: UsePhaseStep<C, D>[] = [];
    let prev = "";
    const userContext = context ?? ({} as C);
    for (const step of steps) {
      const when = step.when;
      if (!when || when({ cycle, current: prev, ...userContext })) {
        seq.push(step);
        prev = step.id;
      }
    }
    return seq;
  }, [cycle, context, steps]);

  const currentStep = sequence[index] ?? sequence[sequence.length - 1] ?? null;
  const currentId = running ? (currentStep?.id ?? "") : "";
  const currentHold = currentStep?.hold ?? null;

  // Pin advancement logic to a ref so the scheduler effect can depend on
  // primitive values only — `steps`/`context` identity churn (inline
  // literals, motion-driven re-renders) must not re-arm the hold timer.
  const advanceRef = useRef<() => void>(() => {});
  const sequenceRef = useRef(sequence);
  const runningRef = useRef(running);
  useEffect(() => {
    advanceRef.current = () => {
      if (index + 1 >= sequence.length) {
        if (loop) {
          setCycle((c) => c + 1);
          setIndex(0);
        } else if (!autoplay) {
          // One-shot run complete: count the pass and return to idle.
          setCycle((c) => c + 1);
          setIndex(0);
          setRunning(false);
        }
      } else {
        setIndex((i) => i + 1);
      }
    };
    sequenceRef.current = sequence;
    runningRef.current = running;
  });

  // External-system sync: setTimeout-based scheduler. Pauses when any gate
  // fails. Reduced motion freezes ambient (autoplay) walkers only —
  // started one-shots are user-initiated function and must complete.
  const hasSteps = steps.length > 0;
  useEffect(() => {
    if (!running) return;
    if (!ctx.playing) return;
    if (ctx.reducedMotion && autoplay) return;
    if (currentHold === null) {
      // Every step's `when` rejected this cycle (empty filtered sequence).
      // Skip ahead instead of stalling permanently — `advance` wraps to the
      // next cycle (or ends a one-shot run). No-op when `steps` itself is
      // empty, so a placeholder walker doesn't spin cycles.
      if (!hasSteps) return;
      const t = setTimeout(() => advanceRef.current(), 0);
      return () => clearTimeout(t);
    }

    const t = setTimeout(() => advanceRef.current(), currentHold);
    return () => clearTimeout(t);
  }, [index, cycle, running, autoplay, ctx.playing, ctx.reducedMotion, currentId, currentHold, hasSteps]);

  // Event handlers (not effects).
  const start = useCallback(() => {
    if (runningRef.current) return;
    setIndex(0);
    setRunning(true);
  }, []);

  const advance = useCallback(() => advanceRef.current(), []);

  const goto = useCallback((id: string) => {
    const i = sequenceRef.current.findIndex((s) => s.id === id);
    if (i < 0) return;
    setIndex(i);
    // Jumping into an idle (autoplay: false) walker implies intent to show
    // that step — wake it rather than silently no-oping.
    setRunning(true);
  }, []);

  const reset = useCallback(() => {
    setCycle(0);
    setIndex(0);
    setRunning(autoplay);
  }, [autoplay]);

  const data =
    running && currentStep && !(ctx.reducedMotion && autoplay)
      ? (currentStep.data ?? null)
      : null;

  return {
    current: currentId,
    index,
    cycle,
    data,
    running,
    start,
    advance,
    goto,
    reset,
  };
}
