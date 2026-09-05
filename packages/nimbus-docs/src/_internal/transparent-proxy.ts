export function transparentProxy<T extends object>(
  source: T,
  overrides: ReadonlyMap<PropertyKey, unknown>,
): T {
  const methods = new Map<PropertyKey, { source: object; wrapped: object }>();
  const valueFor = (property: PropertyKey) => {
    if (overrides.has(property)) return overrides.get(property);
    const value = Reflect.get(source, property, source) as unknown;
    if (typeof value !== "function" || property === "constructor") return value;
    const cached = methods.get(property);
    if (cached?.source === value) return cached.wrapped;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(value, source, args);
    };
    methods.set(property, { source: value, wrapped });
    return wrapped;
  };

  const shadow = Object.create(Object.getPrototypeOf(source)) as T;
  const syncProperty = (property: PropertyKey) => {
    const descriptor: PropertyDescriptor | undefined =
      Reflect.getOwnPropertyDescriptor(source, property);
    if (!descriptor) {
      return Reflect.deleteProperty(shadow, property);
    }
    if ("value" in descriptor) descriptor.value = valueFor(property);
    return Reflect.defineProperty(shadow, property, descriptor);
  };
  const syncShape = () => {
    const sourceKeys = new Set(Reflect.ownKeys(source));
    for (const property of Reflect.ownKeys(shadow)) {
      if (!sourceKeys.has(property)) Reflect.deleteProperty(shadow, property);
    }
    for (const property of sourceKeys) syncProperty(property);
  };
  syncShape();
  if (!Reflect.isExtensible(source)) {
    Reflect.preventExtensions(shadow);
  }

  return new Proxy(shadow, {
    get(_target, property) {
      return valueFor(property);
    },
    has(_target, property) {
      return Reflect.has(source, property);
    },
    getPrototypeOf() {
      const prototype = Reflect.getPrototypeOf(source);
      if (Reflect.getPrototypeOf(shadow) !== prototype) {
        Reflect.setPrototypeOf(shadow, prototype);
      }
      return Reflect.getPrototypeOf(shadow);
    },
    set(_target, property, value) {
      if (overrides.has(property)) return false;
      const result = Reflect.set(source, property, value, source);
      if (result) syncProperty(property);
      return result;
    },
    defineProperty(_target, property, descriptor) {
      if (overrides.has(property)) {
        const current = Reflect.getOwnPropertyDescriptor(shadow, property);
        if (!current) return false;
        if ("get" in descriptor || "set" in descriptor) return false;
        if (
          "value" in descriptor &&
          descriptor.value !== overrides.get(property)
        ) {
          return false;
        }
        const sourceDescriptor: PropertyDescriptor = {};
        if ("configurable" in descriptor) {
          sourceDescriptor.configurable = descriptor.configurable;
        }
        if ("enumerable" in descriptor) {
          sourceDescriptor.enumerable = descriptor.enumerable;
        }
        if ("writable" in descriptor) {
          sourceDescriptor.writable = descriptor.writable;
        }
        const result = Reflect.defineProperty(
          source,
          property,
          sourceDescriptor,
        );
        if (result) syncProperty(property);
        return result;
      }
      const result = Reflect.defineProperty(source, property, descriptor);
      if (result) syncProperty(property);
      return result;
    },
    deleteProperty(_target, property) {
      if (overrides.has(property)) return false;
      const result = Reflect.deleteProperty(source, property);
      if (result) Reflect.deleteProperty(shadow, property);
      return result;
    },
    ownKeys() {
      syncShape();
      return Reflect.ownKeys(shadow);
    },
    getOwnPropertyDescriptor(_target, property) {
      syncProperty(property);
      return Reflect.getOwnPropertyDescriptor(shadow, property);
    },
    isExtensible() {
      if (!Reflect.isExtensible(source) && Reflect.isExtensible(shadow)) {
        syncShape();
        Reflect.preventExtensions(shadow);
      }
      return Reflect.isExtensible(shadow);
    },
    preventExtensions() {
      syncShape();
      return (
        Reflect.preventExtensions(source) && Reflect.preventExtensions(shadow)
      );
    },
    setPrototypeOf(_target, prototype) {
      const result = Reflect.setPrototypeOf(source, prototype);
      return result && Reflect.setPrototypeOf(shadow, prototype);
    },
  });
}
