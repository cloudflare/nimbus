import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Loader, LoaderContext } from "astro/loaders";
import { collectionUrlsKey, getMountContext } from "./collection-mount.js";
import { runInPageLoadScope } from "./page-load-scope.js";
import {
  type PreparedMarkdownCollision,
  type PreparedMarkdownFiles,
  abortPreparedMarkdownLoad,
  beginPreparedMarkdownLoad,
  commitPreparedMarkdownCollection,
  isPreparedMarkdownLoadActive,
  preparedMarkdownCollectionCapability,
  preparedMarkdownRootKey,
  isPreparedMarkdownLazyHeadings,
  runPreparedMarkdownTransaction,
  setPreparedHeadingsRenderer,
} from "./prepared-markdown-registry.js";
import type { PreparedHeadingsRenderer } from "./prepared-markdown-registry.js";
import { renderPreparedMarkdown } from "./markdown-processor-decorator.js";
import { transparentProxy } from "./transparent-proxy.js";

export const NIMBUS_MARKDOWN_META_KEY = "nimbus-markdown-capability";

export interface NimbusMarkdownCapability {
  generation: number;
  base: string;
  /**
   * Where each collection is served (`collectionUrlsKey`). Links between
   * pages are rewritten with it, so a moved route re-prepares the bodies.
   */
  urls?: string;
}

export interface PrepareMarkdownLoaderOptions extends NimbusMarkdownCapability {
  transform: (source: string, sourceId?: string) => string;
  transformRenderMarkdown?: boolean;
  /**
   * What the prepared collection is to Nimbus. `page` collections become
   * pages; `partials` stay component content. Default `page`.
   */
  role?: "page" | "partials";
  /**
   * Entry `data` fields the bake writes into each page's `.md` and `.mdx`
   * frontmatter (`docsCollection({ markdownFields })`).
   */
  markdownFields?: readonly string[];
  /**
   * Commit the collection empty without running the loader: a partial build
   * (`NIMBUS_BUILD_ONLY`) leaves collections outside its slice this way. The
   * store is cleared unconditionally, because Astro persists it between
   * builds and the previous build's entries must not survive into the slice.
   */
  empty?: boolean;
  /**
   * The folder and pattern of a glob Nimbus constructed: recorded so the
   * duplicate-slug pass walks the files instead of reading the store.
   */
  files?: PreparedMarkdownFiles;
}

type StoreEntry = Parameters<LoaderContext["store"]["set"]>[0];
type WatcherHandler = (...args: unknown[]) => unknown;

interface StoreMutationState {
  count: number;
  baseline: Map<string, StoreEntry> | null;
  overlay: Map<string, StoreEntry> | null;
  /**
   * Same-id writes from a different file that still exists, noted during a
   * load or watcher transaction and decided when it commits. `null` when
   * the collection's files are walked instead.
   */
  candidates: PreparedMarkdownCollision[] | null;
}

function discardStoreMutations(
  state: StoreMutationState,
  previousCount: number,
): void {
  state.overlay = null;
  state.baseline = null;
  state.count = previousCount;
}

/**
 * The candidates that stand once the load's final entries are known: a
 * file that moved to another id isn't a collision, whatever the write order.
 */
function standingCollisions(
  candidates: readonly PreparedMarkdownCollision[] | null,
  entries: readonly StoreEntry[],
  rootDir: string,
): PreparedMarkdownCollision[] {
  if (!candidates?.length) return [];
  const idsByFile = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.filePath) continue;
    const ids = idsByFile.get(entry.filePath) ?? new Set<string>();
    ids.add(entry.id);
    idsByFile.set(entry.filePath, ids);
  }
  const seen = new Set<string>();
  const out: PreparedMarkdownCollision[] = [];
  for (const candidate of candidates) {
    const [earlier, later] = candidate.files;
    const movedAway = [...(idsByFile.get(earlier) ?? [])].some(
      (id) => id !== candidate.id,
    );
    if (movedAway || !existsSync(path.resolve(rootDir, earlier))) continue;
    const key = JSON.stringify([candidate.id, [earlier, later].sort()]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function proxyStore(
  store: LoaderContext["store"],
  transform: (source: string, sourceId?: string) => string,
  mutationState: StoreMutationState,
  rootDir: string,
): LoaderContext["store"] {
  const set = Reflect.get(store, "set", store) as LoaderContext["store"]["set"];
  const deleteEntry = Reflect.get(
    store,
    "delete",
    store,
  ) as LoaderContext["store"]["delete"];
  const clear = Reflect.get(
    store,
    "clear",
    store,
  ) as LoaderContext["store"]["clear"];
  const recordMutation = () => {
    mutationState.count += 1;
  };
  const currentEntries = () => mutationState.overlay;
  const noteCandidate = (
    prepared: StoreEntry,
    current: StoreEntry | undefined,
  ) => {
    const candidates = mutationState.candidates;
    if (!candidates || !current?.filePath || !prepared.filePath) return;
    if (current.filePath === prepared.filePath) return;
    if (!existsSync(path.resolve(rootDir, current.filePath))) return;
    candidates.push({
      id: prepared.id,
      files: [current.filePath, prepared.filePath],
    });
  };
  const preparedSet = (entry: StoreEntry) => {
    const prepared =
      typeof entry.body === "string"
        ? {
            ...entry,
            body: transform(entry.body, entry.filePath ?? entry.id),
            data: { ...entry.data },
          }
        : entry;
    const overlay = currentEntries();
    if (!overlay) {
      const current = store.get(prepared.id);
      noteCandidate(prepared, current);
      if (
        prepared.digest &&
        current?.digest === prepared.digest &&
        current.filePath !== prepared.filePath
      ) {
        Reflect.apply(deleteEntry, store, [prepared.id]);
      }
      return Reflect.apply(set, store, [prepared]);
    }
    noteCandidate(prepared, overlay.get(prepared.id));
    if (
      prepared.digest &&
      overlay.get(prepared.id)?.digest === prepared.digest &&
      overlay.get(prepared.id)?.filePath === prepared.filePath
    ) {
      return false;
    }
    overlay.set(prepared.id, prepared);
    recordMutation();
    const changed = true;
    return changed;
  };
  const preparedDelete: LoaderContext["store"]["delete"] = (id) => {
    const overlay = currentEntries();
    if (!overlay) return Reflect.apply(deleteEntry, store, [id]);
    const result = overlay.delete(id);
    if (result) recordMutation();
    return result;
  };
  const preparedClear: LoaderContext["store"]["clear"] = () => {
    const overlay = currentEntries();
    if (!overlay) return Reflect.apply(clear, store, []);
    if (overlay.size > 0) recordMutation();
    overlay.clear();
  };
  const preparedGet = (id: string) => {
    const overlay = currentEntries();
    return overlay ? overlay.get(id) : store.get(id);
  };
  const preparedHas = (id: string) =>
    currentEntries()?.has(id) ?? store.has(id);
  const preparedEntries = () => {
    const overlay = currentEntries();
    return overlay ? [...overlay.entries()] : store.entries();
  };
  const preparedKeys = () => {
    const overlay = currentEntries();
    return overlay ? [...overlay.keys()] : store.keys();
  };
  const preparedValues = () => {
    const overlay = currentEntries();
    return overlay ? [...overlay.values()] : store.values();
  };

  return transparentProxy(
    store,
    new Map<PropertyKey, unknown>([
      ["set", preparedSet],
      ["delete", preparedDelete],
      ["clear", preparedClear],
      ["get", preparedGet],
      ["has", preparedHas],
      ["entries", preparedEntries],
      ["keys", preparedKeys],
      ["values", preparedValues],
    ]),
  );
}

function proxyWatcher(
  context: LoaderContext,
  isActive: () => boolean,
  runTransaction: <T>(operation: () => T | Promise<T>) => Promise<T>,
  onSettled: (
    entries: Iterable<StoreEntry>,
    publish: () => () => void,
  ) => Promise<boolean>,
  mutationState: StoreMutationState,
): LoaderContext["watcher"] {
  const watcher = context.watcher;
  if (!watcher) return undefined;
  const handlers = new Map<unknown, Map<WatcherHandler, WatcherHandler>>();
  const wrappedHandler = (event: unknown, handler: WatcherHandler) => {
    let eventHandlers = handlers.get(event);
    if (!eventHandlers) {
      eventHandlers = new Map();
      handlers.set(event, eventHandlers);
    }
    const existing = eventHandlers.get(handler);
    if (existing) return existing;
    const preparedHandler = function (
      this: unknown,
      ...args: unknown[]
    ): Promise<unknown> {
      return runTransaction(async () => {
        if (!isActive()) return undefined;
        const mutationCount = mutationState.count;
        if (mutationState.candidates) mutationState.candidates = [];
        mutationState.baseline = new Map(
          [...context.store.values()].map((entry) => [
            entry.id,
            structuredClone(entry),
          ]),
        );
        mutationState.overlay = new Map(
          [...mutationState.baseline].map(([id, entry]) => [
            id,
            structuredClone(entry),
          ]),
        );
        try {
          const result = await runInPageLoadScope(context.collection, () =>
            Reflect.apply(handler, this, args),
          );
          if (!isActive()) {
            discardStoreMutations(mutationState, mutationCount);
            return result;
          }
          if (mutationState.count !== mutationCount) {
            const overlay = mutationState.overlay!;
            const baseline = mutationState.baseline!;
            const publish = () => {
              mutationState.overlay = null;
              mutationState.baseline = null;
              const apply = (entries: ReadonlyMap<string, StoreEntry>) => {
                for (const id of context.store.keys()) {
                  if (!entries.has(id)) context.store.delete(id);
                }
                for (const entry of entries.values()) context.store.set(entry);
              };
              try {
                apply(overlay);
              } catch (error) {
                apply(baseline);
                throw error;
              }
              return () => apply(baseline);
            };
            if (!(await onSettled(overlay.values(), publish))) {
              discardStoreMutations(mutationState, mutationCount);
              return result;
            }
          }
          mutationState.overlay = null;
          mutationState.baseline = null;
          return result;
        } catch (error) {
          discardStoreMutations(mutationState, mutationCount);
          throw error;
        }
      }).catch((error: unknown) => {
        context.logger.error(
          `Nimbus Markdown watcher failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
    };
    eventHandlers.set(handler, preparedHandler);
    return preparedHandler;
  };
  const overrides = new Map<PropertyKey, unknown>();
  for (const method of [
    "on",
    "addListener",
    "once",
    "prependListener",
    "prependOnceListener",
  ]) {
    const register = Reflect.get(watcher, method, watcher) as unknown;
    if (typeof register !== "function") continue;
    overrides.set(method, (event: unknown, handler: unknown) => {
      const result = Reflect.apply(register, watcher, [
        event,
        typeof handler === "function"
          ? wrappedHandler(event, handler as WatcherHandler)
          : handler,
      ]);
      return result === watcher ? preparedWatcher : result;
    });
  }
  for (const method of ["off", "removeListener"]) {
    const remove = Reflect.get(watcher, method, watcher) as unknown;
    if (typeof remove !== "function") continue;
    overrides.set(method, (event: unknown, handler: unknown) => {
      const wrapped =
        typeof handler === "function"
          ? (handlers.get(event)?.get(handler as WatcherHandler) ?? handler)
          : handler;
      const result = Reflect.apply(remove, watcher, [event, wrapped]);
      return result === watcher ? preparedWatcher : result;
    });
  }
  const preparedWatcher = transparentProxy(watcher, overrides);
  return preparedWatcher;
}

function proxyContext(
  context: LoaderContext,
  options: PrepareMarkdownLoaderOptions,
  isActive: () => boolean,
  runWatcherTransaction: <T>(operation: () => T | Promise<T>) => Promise<T>,
  onWatcherSettled: (
    entries: Iterable<StoreEntry>,
    publish: () => () => void,
  ) => Promise<boolean>,
  mutationState: StoreMutationState,
): LoaderContext {
  const store = proxyStore(
    context.store,
    options.transform,
    mutationState,
    fileURLToPath(context.config.root),
  );
  const watcher = proxyWatcher(
    context,
    isActive,
    runWatcherTransaction,
    onWatcherSettled,
    mutationState,
  );
  const renderMarkdown = Reflect.get(
    context,
    "renderMarkdown",
    context,
  ) as LoaderContext["renderMarkdown"];
  const preparedRenderMarkdown: LoaderContext["renderMarkdown"] = (
    source,
    renderOptions,
  ) =>
    Reflect.apply(renderMarkdown, context, [
      renderOptions?.fileURL
        ? options.transform(source, renderOptions.fileURL.pathname)
        : options.transform(source),
      renderOptions,
    ]);

  const overrides = new Map<PropertyKey, unknown>([["store", store]]);
  if (watcher) overrides.set("watcher", watcher);
  if (options.transformRenderMarkdown !== false) {
    overrides.set("renderMarkdown", preparedRenderMarkdown);
  }

  return transparentProxy(context, overrides);
}

export function prepareMarkdownLoader<T extends Loader>(
  loader: T,
  options: PrepareMarkdownLoaderOptions,
): T {
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new TypeError(
      "Nimbus Markdown generation must be a positive safe integer",
    );
  }
  if (!options.base.startsWith("/")) {
    throw new TypeError("Nimbus Markdown base must be an absolute pathname");
  }
  const preparedCapability = {
    generation: options.generation,
    base: options.base,
  };
  const load = Reflect.get(loader, "load", loader) as Loader["load"];
  const preparedLoad: Loader["load"] = async (context) => {
    const root = preparedMarkdownRootKey(context.config.root);
    const urls = collectionUrlsKey(getMountContext(context.config.root));
    const capability = Object.freeze({
      ...preparedCapability,
      ...(urls === undefined ? {} : { urls }),
    } satisfies NimbusMarkdownCapability);
    if (options.empty) {
      await runPreparedMarkdownTransaction(root, context.collection, async () => {
        const epoch = beginPreparedMarkdownLoad(root, context.collection, true);
        context.store.clear();
        context.meta.delete(NIMBUS_MARKDOWN_META_KEY);
        const committed = commitPreparedMarkdownCollection(
          root,
          context.collection,
          epoch,
          capability,
          [],
          new Map(),
          options.role ?? "page",
          { files: options.files, markdownFields: options.markdownFields },
        );
        if (!committed) {
          throw new Error(
            `Nimbus Markdown preparation became obsolete for collection ${context.collection}`,
          );
        }
      });
      return;
    }
    await runPreparedMarkdownTransaction(root, context.collection, async () => {
      const currentCapability = preparedMarkdownCollectionCapability(
        context.collection,
        context.store.values(),
        capability,
      );
      const reusable =
        context.meta.get(NIMBUS_MARKDOWN_META_KEY) ===
        JSON.stringify({ version: 3, ...currentCapability });
      const epoch = beginPreparedMarkdownLoad(
        root,
        context.collection,
        !reusable,
      );
      const commit = async (
        entries: Iterable<StoreEntry> = context.store.values(),
        publish?: () => () => void,
      ) => {
        // Astro drops an empty body (frontmatter-only file); it is still a page.
        const sourceEntries = [...entries].map((entry) =>
          typeof entry.body === "string" ? entry : { ...entry, body: "" },
        );
        const headings = new Map<
          string,
          Array<{ depth: number; text: string; slug: string }>
        >();
        const renderMarkdown = Reflect.get(
          context,
          "renderMarkdown",
          context,
        ) as LoaderContext["renderMarkdown"];
        const renderHeadings: PreparedHeadingsRenderer = async (entry) => {
          const fileURL = entry.filePath
            ? new URL(entry.filePath, context.config.root)
            : undefined;
          const rendered = await renderPreparedMarkdown(
            () =>
              Reflect.apply(renderMarkdown, context, [
                entry.body,
                fileURL ? { fileURL } : undefined,
              ]) as ReturnType<LoaderContext["renderMarkdown"]>,
          );
          return rendered.metadata?.headings ?? [];
        };
        if (isPreparedMarkdownLazyHeadings(root)) {
          // Rendering every body only for its headings scales startup and
          // every save with the doc count; a page's headings are rendered
          // when it is first requested instead.
          setPreparedHeadingsRenderer(root, context.collection, renderHeadings);
        } else {
          for (const entry of sourceEntries) {
            if (typeof entry.body !== "string") continue;
            headings.set(
              entry.id,
              await renderHeadings({
                body: entry.body,
                filePath: entry.filePath,
              }),
            );
          }
        }
        const rollback = publish?.();
        let committed: boolean;
        try {
          committed = commitPreparedMarkdownCollection(
            root,
            context.collection,
            epoch,
            capability,
            sourceEntries,
            headings,
            options.role ?? "page",
            {
              files: options.files,
              markdownFields: options.markdownFields,
              collisions: standingCollisions(
                mutationState.candidates,
                sourceEntries,
                fileURLToPath(context.config.root),
              ),
            },
          );
        } catch (error) {
          rollback?.();
          throw error;
        }
        if (!committed) rollback?.();
        if (committed) {
          const sealed = preparedMarkdownCollectionCapability(
            context.collection,
            sourceEntries,
            capability,
          );
          context.meta.set(
            NIMBUS_MARKDOWN_META_KEY,
            JSON.stringify({ version: 3, ...sealed }),
          );
        }
        return committed;
      };
      const mutationState: StoreMutationState = {
        count: 0,
        baseline: null,
        overlay: null,
        candidates: options.files ? null : [],
      };
      const runWatcherTransaction = <T>(operation: () => T | Promise<T>) =>
        runPreparedMarkdownTransaction(root, context.collection, operation);

      if (!reusable) context.store.clear();
      context.meta.delete(NIMBUS_MARKDOWN_META_KEY);
      try {
        const prepared = proxyContext(
          context,
          options,
          () => isPreparedMarkdownLoadActive(root, context.collection, epoch),
          runWatcherTransaction,
          commit,
          mutationState,
        );
        await runInPageLoadScope(context.collection, () =>
          Reflect.apply(load, loader, [prepared]),
        );
        if (!(await commit())) {
          throw new Error(
            `Nimbus Markdown preparation became obsolete for collection ${context.collection}`,
          );
        }
      } catch (error) {
        abortPreparedMarkdownLoad(root, context.collection, epoch);
        context.store.clear();
        throw error;
      }
    });
  };

  return transparentProxy(loader, new Map([["load", preparedLoad]]));
}
