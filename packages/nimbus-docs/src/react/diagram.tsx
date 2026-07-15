"use client";

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "./cn";
import { diagramRegistry } from "./registry";

// ─── Types ──────────────────────────────────────────────────

export type Depth = "intuition" | "working" | "mechanism";
export type ReducedMotionMode = "respect" | "ignore";
export type DiagramPhase = "idle" | "ready" | "playing" | "paused";

export interface DiagramContextValue {
  /** Stable per-instance id from useId. */
  id: string;
  /** Derived lifecycle state. */
  phase: DiagramPhase;
  /** True when the diagram should be advancing animation. */
  playing: boolean;
  /** Element intersects the viewport (direct IntersectionObserver). */
  visible: boolean;
  /** Browser tab is visible (Page Visibility API). */
  tabVisible: boolean;
  /** Reduced-motion is in effect (OS + reducedMotion="respect" mode). */
  reducedMotion: boolean;
  /** Reader's depth setting. Reserved; currently a fixed default. */
  depth: Depth;
  /** Theme tokens. Reserved; currently a fixed default. */
  theme: { id: string };
  /** Trigger a reset — bumps the subtree key; children's useState resets. */
  reset: () => void;
  /** Toggle play/pause from user action. */
  toggle: () => void;
}

// ─── Lifecycle reducer ──────────────────────────────────────

interface ReducerState {
  /** Margin-observer pre-warm has fired and scroll has settled. */
  ready: boolean;
  /** Direct IntersectionObserver says the diagram intersects the viewport. */
  visible: boolean;
  /** Page Visibility API says the tab is visible. */
  tabVisible: boolean;
  /** OS prefers-reduced-motion is set. */
  reducedMotion: boolean;
  /** User clicked Pause; persists across visibility changes. */
  userPaused: boolean;
}

type ReducerEvent =
  | { type: "READY" }
  | { type: "VISIBILITY"; visible: boolean }
  | { type: "TAB_VISIBILITY"; tabVisible: boolean }
  | { type: "REDUCED_MOTION"; reduced: boolean }
  | { type: "TOGGLE" }
  | { type: "SET_PAUSED"; paused: boolean };

function reducer(state: ReducerState, event: ReducerEvent): ReducerState {
  switch (event.type) {
    case "READY":
      return state.ready ? state : { ...state, ready: true };
    case "VISIBILITY":
      return state.visible === event.visible ? state : { ...state, visible: event.visible };
    case "TAB_VISIBILITY":
      return state.tabVisible === event.tabVisible
        ? state
        : { ...state, tabVisible: event.tabVisible };
    case "REDUCED_MOTION":
      return state.reducedMotion === event.reduced
        ? state
        : { ...state, reducedMotion: event.reduced };
    case "TOGGLE":
      return { ...state, userPaused: !state.userPaused };
    case "SET_PAUSED":
      return state.userPaused === event.paused
        ? state
        : { ...state, userPaused: event.paused };
  }
}

function derivePhase(
  state: ReducerState,
  reducedMotionMode: ReducedMotionMode,
  pauseWhenOffscreen: boolean,
): DiagramPhase {
  if (!state.ready) return "idle";
  if (reducedMotionMode === "respect" && state.reducedMotion) return "paused";
  if (pauseWhenOffscreen && !state.visible) return "paused";
  if (!state.tabVisible) return "paused";
  if (state.userPaused) return "paused";
  return "playing";
}

// ─── Context ──────────────────────────────────────────────

const DiagramContext = createContext<DiagramContextValue | null>(null);

export function useDiagram(): DiagramContextValue | null {
  return useContext(DiagramContext);
}

const DEFAULT_CONTEXT: DiagramContextValue = {
  id: "__no_wrapper__",
  phase: "playing",
  playing: true,
  visible: true,
  tabVisible: true,
  reducedMotion: false,
  depth: "working",
  theme: { id: "default" },
  reset: () => {},
  toggle: () => {},
};

const WARNED = new Set<string>();

/**
 * Returns the wrapper context, or a default + one-time dev warning when
 * called outside a `<Diagram>`. Used by every hook in nimbus-docs/react
 * so authors can prototype without forgetting the wrapper.
 */
export function useDiagramOrDefault(hookName: string): DiagramContextValue {
  const ctx = useContext(DiagramContext);
  if (ctx) return ctx;
  if (
    typeof process !== "undefined" &&
    process.env.NODE_ENV !== "production" &&
    !WARNED.has(hookName)
  ) {
    WARNED.add(hookName);
    // eslint-disable-next-line no-console
    console.warn(
      `[nimbus-docs/react] ${hookName} called outside a <Diagram> wrapper. ` +
        "Defaults: playing=true, visible=true, reducedMotion=false. " +
        "Wrap with <Diagram> for off-screen / reduced-motion / tab-hidden gating.",
    );
  }
  return DEFAULT_CONTEXT;
}

// ─── Diagram component ──────────────────────────────────────

const MARGIN_ROOTMARGIN_VH = 2;
/**
 * Debounce window for READY dispatch — only applied when scroll activity
 * was observed in the last `SCROLL_VELOCITY_WINDOW_MS`. On a settled page
 * (initial load, no scrolling), READY fires immediately.
 *
 * Empirically, an earlier flat 500ms gate caused a visible delay on
 * initial render. Scroll-aware gating preserves the mass-init protection
 * for fast scrolls while keeping page-load latency at zero.
 */
const SCROLL_IDLE_MS = 200;
const SCROLL_VELOCITY_WINDOW_MS = 200;

export interface DiagramProps {
  children: ReactNode;
  fallback?: string;
  pauseWhenOffscreen?: boolean;
  reducedMotion?: ReducedMotionMode;
  /** Forwarded; Astro's client:* directive dictates the actual hydration timing. */
  hydration?: "visible" | "idle" | "load";
  /** Wrap children in an error boundary that exposes a Reset button on render failure. Default: true. */
  errorBoundary?: boolean;
  /** Listen for space (toggle) / r (reset) keypresses bubbling from inside the region. Skipped when target is an interactive element. Default: true. */
  keyboard?: boolean;
  /** ARIA region label. */
  label?: string;
  className?: string;
}

// ─── Error boundary ─────────────────────────────────────────

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Called when the user clicks Reset in the fallback. Should bump the resetKey on the keyed subtree. */
  onReset: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors thrown by the diagram subtree. React 19 still
 * requires class components for error boundaries — no hook equivalent
 * yet. Falls back to a static "Diagram failed" message + a Reset button
 * that both clears local error state AND bumps the outer resetKey so
 * children remount fresh.
 */
class DiagramErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[nimbus-docs/react] Diagram render error:", error, info);
    }
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset();
  };

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <span className="font-medium">Diagram failed to render.</span>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded border border-red-400 px-2 py-0.5 text-xs font-medium hover:bg-red-100 dark:border-red-700 dark:hover:bg-red-900"
          >
            Reset
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── A11y helpers ────────────────────────────────────────────

/** Inline visually-hidden style — avoids depending on `.sr-only` Tailwind class. */
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** True when the keypress originated from a native interactive element — skip our shortcut to let the element's own behaviour fire. */
function isInteractiveTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag === "A" && t.hasAttribute("href")) return true;
  if (t.isContentEditable) return true;
  return false;
}

function DiagramRoot(props: DiagramProps) {
  const {
    children,
    pauseWhenOffscreen = true,
    reducedMotion: reducedMotionMode = "respect",
    errorBoundary = true,
    keyboard = true,
    label,
    className,
  } = props;

  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [resetKey, setResetKey] = useState(0);

  const [state, dispatch] = useReducer(reducer, {
    ready: false,
    visible: false,
    tabVisible: true,
    reducedMotion: false,
    userPaused: false,
  });

  // ─── visibilitychange (tab visibility) — env-aware globals
  useEffect(() => {
    const win = rootRef.current?.ownerDocument.defaultView ?? window;
    const doc = win.document;
    const onChange = () =>
      dispatch({ type: "TAB_VISIBILITY", tabVisible: doc.visibilityState === "visible" });
    onChange();
    doc.addEventListener("visibilitychange", onChange);
    return () => doc.removeEventListener("visibilitychange", onChange);
  }, []);

  // ─── prefers-reduced-motion — env-aware globals
  useEffect(() => {
    const win = rootRef.current?.ownerDocument.defaultView ?? window;
    const mq = win.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent | MediaQueryList) =>
      dispatch({ type: "REDUCED_MOTION", reduced: e.matches });
    onChange(mq);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // ─── Two IntersectionObservers (pre-warm + direct)
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const win = el.ownerDocument.defaultView ?? window;
    const vh = win.innerHeight || 800;

    // Scroll-velocity tracker. The margin observer debounces READY only
    // when scroll happened recently; on a settled page, READY fires
    // immediately.
    let lastScrollAt = 0;
    const onScroll = () => {
      lastScrollAt = Date.now();
    };
    win.addEventListener("scroll", onScroll, { passive: true });

    let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingReady = false;

    const marginObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const sinceScroll = Date.now() - lastScrollAt;
            if (sinceScroll > SCROLL_VELOCITY_WINDOW_MS) {
              dispatch({ type: "READY" });
              continue;
            }
            pendingReady = true;
            if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
            scrollIdleTimer = setTimeout(() => {
              if (pendingReady) {
                dispatch({ type: "READY" });
                pendingReady = false;
              }
            }, SCROLL_IDLE_MS);
          }
        }
      },
      { rootMargin: `${MARGIN_ROOTMARGIN_VH * vh}px 0px ${MARGIN_ROOTMARGIN_VH * vh}px 0px` },
    );
    marginObserver.observe(el);

    const directObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          dispatch({ type: "VISIBILITY", visible: entry.isIntersecting });
        }
      },
      { rootMargin: "0px", threshold: [0, 1.0] },
    );
    directObserver.observe(el);

    return () => {
      marginObserver.disconnect();
      directObserver.disconnect();
      win.removeEventListener("scroll", onScroll);
      if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    };
  }, []);

  // ─── Event handlers (not effects — see React design rules)
  const toggle = useCallback(() => dispatch({ type: "TOGGLE" }), []);
  // Reset also clears the user-paused flag: resetting a paused diagram
  // would otherwise remount children into a frozen frame, making the
  // Reset click appear to do nothing.
  const reset = useCallback(() => {
    setResetKey((k) => k + 1);
    dispatch({ type: "SET_PAUSED", paused: false });
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!keyboard) return;
      if (isInteractiveTarget(event.target)) return;
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        toggle();
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        reset();
      }
    },
    [keyboard, toggle, reset],
  );

  // ─── Page-scoped registry membership
  // `userPaused` is read through a ref at call time so the registry can
  // make a coherent pause-all/resume-all decision across entries without
  // re-registering on every state change.
  const userPausedRef = useRef(state.userPaused);
  userPausedRef.current = state.userPaused;
  useEffect(() => {
    return diagramRegistry.register({
      id,
      setPaused: (paused) => dispatch({ type: "SET_PAUSED", paused }),
      userPaused: () => userPausedRef.current,
    });
  }, [id]);

  // ─── Derived
  const phase = derivePhase(state, reducedMotionMode, pauseWhenOffscreen);
  const playing = phase === "playing";
  const reducedMotionEffective =
    reducedMotionMode === "respect" ? state.reducedMotion : false;
  const visibleEffective = pauseWhenOffscreen ? state.visible : true;

  // ─── Context value (useMemo for re-render perf only, not for semantics)
  const ctx: DiagramContextValue = useMemo(
    () => ({
      id,
      phase,
      playing,
      visible: visibleEffective,
      tabVisible: state.tabVisible,
      reducedMotion: reducedMotionEffective,
      depth: "working",
      theme: { id: "default" },
      reset,
      toggle,
    }),
    [id, phase, playing, visibleEffective, state.tabVisible, reducedMotionEffective, reset, toggle],
  );

  // Live-region content: only narrate the two states a reader cares about
  // ("playing", "paused"). Idle/ready render as empty string — aria-live
  // doesn't announce initial content, only changes, so silence on mount.
  const liveText =
    phase === "playing" ? "Diagram playing" :
    phase === "paused" ? "Diagram paused" :
    "";

  const renderBody = (
    <div className="diagram-render" key={resetKey}>
      {children}
    </div>
  );

  return (
    <DiagramContext.Provider value={ctx}>
      <div
        ref={rootRef}
        data-nb-diagram
        data-diagram-id={id}
        data-phase={phase}
        data-playing={String(playing)}
        data-visible={String(visibleEffective)}
        data-tab-visible={String(state.tabVisible)}
        data-reduced-motion={String(reducedMotionEffective)}
        aria-label={label}
        // ARIA regions require an accessible name — only claim the role
        // when a label was provided.
        role={label ? "region" : undefined}
        // Focusable so space/r are reachable on cards with no interactive
        // children; without a tab stop the keydown handler never fires.
        tabIndex={keyboard ? 0 : undefined}
        onKeyDown={handleKeyDown}
        className={cn("flex flex-col", className)}
      >
        <span aria-live="polite" role="status" style={SR_ONLY}>
          {liveText}
        </span>
        {errorBoundary ? (
          <DiagramErrorBoundary onReset={reset}>{renderBody}</DiagramErrorBoundary>
        ) : (
          renderBody
        )}
      </div>
    </DiagramContext.Provider>
  );
}

// ─── Public component ───────────────────────────────────────

export const Diagram = DiagramRoot;
