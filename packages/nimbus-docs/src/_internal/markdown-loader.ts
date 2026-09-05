import type { Loader, LoaderContext } from "astro/loaders";
import {
  abortPreparedMarkdownLoad,
  beginPreparedMarkdownLoad,
  cancelPreparedMarkdownLoad,
  commitPreparedMarkdownCollection,
  isPreparedMarkdownLoadActive,
  preparedMarkdownCollectionCapability,
  preparedMarkdownRootKey,
  runPreparedMarkdownTransaction,
} from "./prepared-markdown-registry.js";
import { transparentProxy } from "./transparent-proxy.js";

export const NIMBUS_MARKDOWN_META_KEY = "nimbus-markdown-capability";

export interface NimbusMarkdownCapability {
  generation: number;
  base: string;
}

export interface PrepareMarkdownLoaderOptions extends NimbusMarkdownCapability {
  transform: (source: string, sourceId?: string) => string;
  transformRenderMarkdown?: boolean;
}

type StoreEntry = Parameters<LoaderContext["store"]["set"]>[0];
type WatcherHandler = (...args: unknown[]) => unknown;

interface StoreMutationState {
  count: number;
  baseline: Map<string, StoreEntry> | null;
  overlay: Map<string, StoreEntry> | null;
}

function discardStoreMutations(
  state: StoreMutationState,
  previousCount: number,
): void {
  state.overlay = null;
  state.baseline = null;
  state.count = previousCount;
}

function proxyStore(
  store: LoaderContext["store"],
  transform: (source: string, sourceId?: string) => string,
  mutationState: StoreMutationState,
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
    if (!overlay) return Reflect.apply(set, store, [prepared]);
    if (
      prepared.digest &&
      overlay.get(prepared.id)?.digest === prepared.digest
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

function proxyLogger(
  logger: LoaderContext["logger"],
  onError: () => void,
): LoaderContext["logger"] {
  const error = Reflect.get(logger, "error", logger) as (
    ...args: unknown[]
  ) => unknown;
  const fork = Reflect.get(logger, "fork", logger) as (
    ...args: unknown[]
  ) => unknown;
  const preparedError = (...args: unknown[]) => {
    onError();
    return Reflect.apply(error, logger, args);
  };
  const preparedFork = (...args: unknown[]) => {
    const child = Reflect.apply(fork, logger, args) as LoaderContext["logger"];
    return proxyLogger(child, onError);
  };
  return transparentProxy(
    logger,
    new Map<PropertyKey, unknown>([
      ["error", preparedError],
      ["fork", preparedFork],
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
  getErrorCount: () => number,
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
        const errorCount = getErrorCount();
        const mutationCount = mutationState.count;
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
          const result = await Reflect.apply(handler, this, args);
          if (getErrorCount() !== errorCount || !isActive()) {
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
  errorState: { count: number },
  mutationState: StoreMutationState,
): LoaderContext {
  const store = proxyStore(context.store, options.transform, mutationState);
  const logger = proxyLogger(context.logger, () => {
    errorState.count += 1;
  });
  const watcher = proxyWatcher(
    context,
    isActive,
    runWatcherTransaction,
    onWatcherSettled,
    () => errorState.count,
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

  const overrides = new Map<PropertyKey, unknown>([
    ["store", store],
    ["logger", logger],
  ]);
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
  const capability = Object.freeze({
    generation: options.generation,
    base: options.base,
  } satisfies NimbusMarkdownCapability);
  const load = Reflect.get(loader, "load", loader) as Loader["load"];
  const preparedLoad: Loader["load"] = async (context) => {
    const root = preparedMarkdownRootKey(context.config.root);
    await runPreparedMarkdownTransaction(root, context.collection, async () => {
      const currentCapability = preparedMarkdownCollectionCapability(
        context.collection,
        context.store.values(),
        capability,
      );
      const reusable =
        context.meta.get(NIMBUS_MARKDOWN_META_KEY) ===
        JSON.stringify({ version: 2, ...currentCapability });
      const epoch = beginPreparedMarkdownLoad(
        root,
        context.collection,
        !reusable,
      );
      const commit = async (
        entries: Iterable<StoreEntry> = context.store.values(),
        publish?: () => () => void,
      ) => {
        const sourceEntries = [...entries];
        const headings = new Map<
          string,
          Array<{ depth: number; text: string; slug: string }>
        >();
        const renderMarkdown = Reflect.get(
          context,
          "renderMarkdown",
          context,
        ) as LoaderContext["renderMarkdown"];
        for (const entry of sourceEntries) {
          if (typeof entry.body !== "string") continue;
          const fileURL = entry.filePath
            ? new URL(entry.filePath, context.config.root)
            : undefined;
          const rendered = await Reflect.apply(renderMarkdown, context, [
            entry.body,
            fileURL ? { fileURL } : undefined,
          ]);
          headings.set(entry.id, rendered.metadata?.headings ?? []);
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
            JSON.stringify({ version: 2, ...sealed }),
          );
        }
        return committed;
      };
      const errorState = { count: 0 };
      const mutationState: StoreMutationState = {
        count: 0,
        baseline: null,
        overlay: null,
      };
      const runWatcherTransaction = <T>(operation: () => T | Promise<T>) =>
        runPreparedMarkdownTransaction(root, context.collection, operation);

      if (!reusable) context.store.clear();
      context.meta.delete(NIMBUS_MARKDOWN_META_KEY);
      try {
        await Reflect.apply(load, loader, [
          proxyContext(
            context,
            options,
            () => isPreparedMarkdownLoadActive(root, context.collection, epoch),
            runWatcherTransaction,
            commit,
            errorState,
            mutationState,
          ),
        ]);
        if (errorState.count > 0) {
          cancelPreparedMarkdownLoad(root, context.collection, epoch);
          context.store.clear();
          throw new Error(
            `Nimbus Markdown preparation failed for collection ${context.collection}`,
          );
        }
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
