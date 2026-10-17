import type { ClassValue } from "clsx";
import { cn } from "./cn";

type VariantMap = Record<string, Record<string, string>>;
type Selection<V extends VariantMap> = { [K in keyof V]?: keyof V[K] };

interface Config<V extends VariantMap> {
  base?: string;
  variants: V;
  defaults: { [K in keyof V]: keyof V[K] };
  /** Extra classes when every listed variant matches. */
  compound?: Array<Selection<V> & { class: string }>;
}

/**
 * Turn a component's variant tables into one class function, so every
 * component picks its look the same way.
 *
 *   const badge = variants({
 *     base: "inline-flex rounded-full",
 *     variants: { tone: { default: "bg-accent", danger: "bg-danger-muted" } },
 *     defaults: { tone: "default" },
 *   });
 *   badge({ tone: "danger" });
 */
export function variants<V extends VariantMap>(config: Config<V>) {
  return (selection: Selection<V> = {}, className?: ClassValue): string => {
    const picked = { ...config.defaults, ...stripUndefined(selection) } as Record<keyof V, string>;
    const classes = Object.keys(config.variants).map((key) => {
      const table = config.variants[key];
      return table[picked[key]] ?? table[config.defaults[key] as string];
    });
    const compound = (config.compound ?? [])
      .filter(({ class: _, ...when }) =>
        Object.entries(when).every(([key, value]) => picked[key as keyof V] === value),
      )
      .map((entry) => entry.class);
    return cn(config.base, classes, compound, className);
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
