/**
 * Form encoding, shared by the code samples and Try it so a sample and the
 * request it describes write the same fields: OpenAPI's `encoding` rules for
 * `application/x-www-form-urlencoded`, and the text a multipart part sends.
 * No dependencies: it runs in the browser too.
 */
import type { OpenApiEncoding } from "./openapi-types.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface FormField {
  name: string;
  value: string;
  allowReserved?: boolean;
  /** The value is already percent-encoded: a joined list whose separators are structural. */
  encoded?: boolean;
}

// A value that isn't valid encoded text is sent as written.
export function decodeForm(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

// A part's content type from its `encoding` entry: the first listed type, or
// none for a wildcard, which names no type a client can send.
export function partContentType(listed: string | undefined): string | undefined {
  const first = listed?.split(",")[0]?.trim();
  return first && !first.includes("*") ? first : undefined;
}

export function serializeForm(fields: FormField[]): string {
  return fields
    .map(({ name, value, allowReserved, encoded }) =>
      `${encodeFormText(name)}=${encoded ? value : encodeFormValue(value, allowReserved)}`)
    .join("&");
}

function encodeFormText(text: string): string {
  return new URLSearchParams([["", text]]).toString().slice(1);
}

// Reserved expansion writes a space as `%20`, except inside a space-delimited
// join, where `%20` is the separator and an item's space stays `+`.
export function encodeFormValue(value: string, allowReserved = false, spaceAsPlus = false): string {
  if (!allowReserved) return encodeFormText(value);
  return value.replace(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9\-._~:/?@!$'()*,;]/gu, (token) => {
    if (token.startsWith("%") && token.length === 3) return token;
    const encoded = encodeFormText(token);
    return spaceAsPlus ? encoded : encoded.replaceAll("+", "%20");
  });
}

// A form body's fields: a string is read as an encoded form, an object
// gives one or more fields per property, and anything else sends no body.
// A property with an `encoding` entry follows OpenAPI: `style`, `explode`, or
// `allowReserved` select query-style serialization (`style` defaults to
// `form`); without them the value is sent as its content type, so an object
// is JSON. A property without an entry nests objects as `a[b]=c`, repeats its
// name for an array of scalars, and indexes an array holding objects or
// arrays (`a[0][b]=c`). Empty objects and arrays send nothing.
export function formFields(
  value: unknown,
  encoding: Record<string, OpenApiEncoding | undefined> | undefined,
): FormField[] {
  if (typeof value === "string") return [...new URLSearchParams(value)].map(([name, text]) => ({ name, value: text }));
  if (!isPlainObject(value)) return [];
  const fields: FormField[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const rule = encoding && Object.hasOwn(encoding, key) ? encoding[key] : undefined;
    const add = (name: string, entry: unknown) => fields.push({ name, value: formText(entry), ...(rule?.allowReserved ? { allowReserved: true } : {}) });
    if (!rule) {
      addNested(key, item, false, add);
    } else if (rule.style === undefined && rule.explode === undefined && rule.allowReserved === undefined) {
      const addContent = (entry: unknown) => fields.push({ name: key, value: formText(entry, rule.contentType) });
      if (Array.isArray(item)) item.forEach(addContent);
      else addContent(item);
    } else {
      const style = rule.style ?? "form";
      // Separators are written so a value can't produce one: a value's space
      // encodes as `+` and its `|` and `,` as `%7C` and `%2C`.
      const separator = style === "spaceDelimited" ? "%20" : style === "pipeDelimited" ? "|" : ",";
      const explode = rule.explode ?? style === "form";
      const addJoined = (parts: string[]) => fields.push({
        name: key,
        value: parts.map((part) => encodeFormValue(part, rule.allowReserved, style === "spaceDelimited")).join(separator),
        encoded: true,
      });
      if (style === "deepObject") {
        addNested(key, item, true, add);
      } else if (Array.isArray(item)) {
        if (explode) item.forEach((entry) => add(key, entry));
        else addJoined(item.map((entry) => formText(entry)));
      } else if (isPlainObject(item)) {
        if (explode) Object.entries(item).forEach(([name, entry]) => add(name, entry));
        else addJoined(Object.entries(item).flatMap(([name, entry]) => [name, formText(entry)]));
      } else {
        add(key, item);
      }
    }
  }
  return fields;
}

function addNested(name: string, item: unknown, indexArrays: boolean, add: (name: string, item: unknown) => void): void {
  if (Array.isArray(item)) {
    const indexed = indexArrays || item.some((entry) => entry !== null && typeof entry === "object");
    item.forEach((entry, i) => (indexed ? addNested(`${name}[${i}]`, entry, indexArrays, add) : add(name, entry)));
  } else if (isPlainObject(item)) {
    for (const [key, entry] of Object.entries(item)) {
      if (entry !== undefined) addNested(`${name}[${key}]`, entry, indexArrays, add);
    }
  } else {
    add(name, item);
  }
}

export function formText(item: unknown, contentType?: string): string {
  const mediaType = contentType?.split(";")[0]!.trim().toLowerCase();
  if (mediaType?.endsWith("/json") || mediaType?.endsWith("+json")) return JSON.stringify(item) ?? "";
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  return JSON.stringify(item);
}
