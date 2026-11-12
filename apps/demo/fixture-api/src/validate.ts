/**
 * Checks a request's query values and JSON body fields against what the spec
 * declares for the operation (carried into routes.json by build-routes.mjs):
 * type, format, enum and range. A failure names the parameter, for the 400
 * envelope.
 */

export interface Field {
  name: string;
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  format?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  required: boolean;
  items?: { type?: string; enum?: string[] };
  minItems?: number;
  maxItems?: number;
}

export type Scalar = string | number | boolean;

export type Validation<T> = { ok: true; values: T } | { ok: false; param: string; message: string };

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A real calendar date: `Date` would roll 2026-02-30 into March. */
function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function checkFormat(field: Field, value: string): string | null {
  if (field.format === "date") {
    if (!isCalendarDate(value)) return `${field.name} must be a date, YYYY-MM-DD.`;
  } else if (field.format === "date-time") {
    const match = DATE_TIME.exec(value);
    if (!match || !isCalendarDate(match[1] as string) || Number.isNaN(Date.parse(value))) return `${field.name} must be an RFC 3339 date-time with seconds.`;
  }
  return null;
}

function checkScalar(field: Field, raw: string): { value: Scalar } | { message: string } {
  const type = field.type ?? "string";
  if (type === "boolean") {
    if (raw === "true") return { value: true };
    if (raw === "false") return { value: false };
    return { message: `${field.name} must be true or false.` };
  }
  if (type === "number" || type === "integer") {
    if (raw.trim() === "" || Number.isNaN(Number(raw))) return { message: `${field.name} must be a number.` };
    const value = Number(raw);
    if (type === "integer" && !Number.isInteger(value)) return { message: `${field.name} must be an integer.` };
    return rangeCheck(field, value);
  }
  const format = checkFormat(field, raw);
  if (format) return { message: format };
  if (field.enum && !field.enum.includes(raw)) return { message: `${field.name} must be one of ${field.enum.join(", ")}.` };
  return { value: raw };
}

function rangeCheck(field: Field, value: number): { value: Scalar } | { message: string } {
  if (field.minimum !== undefined && value < field.minimum) return { message: `${field.name} must be at least ${field.minimum}.` };
  if (field.maximum !== undefined && value > field.maximum) return { message: `${field.name} must be at most ${field.maximum}.` };
  return { value };
}

/** Every declared query parameter that was sent, parsed; undeclared ones are ignored. */
export function validateQuery(fields: Field[], search: URLSearchParams): Validation<Record<string, Scalar>> {
  const values: Record<string, Scalar> = {};
  for (const field of fields) {
    const raw = search.get(field.name);
    if (raw === null) {
      if (field.required) return { ok: false, param: field.name, message: `Missing required query parameter: ${field.name}.` };
      continue;
    }
    const result = checkScalar(field, raw);
    if ("message" in result) return { ok: false, param: field.name, message: result.message };
    values[field.name] = result.value;
  }
  return { ok: true, values };
}

/** A JSON body's declared fields, type- and enum-checked; unlisted fields are ignored. */
export function validateBody(fields: Field[], body: unknown): Validation<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, param: "body", message: "The request body must be a JSON object." };
  }
  const input = body as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined) {
      if (field.required) return { ok: false, param: field.name, message: `Missing required field: ${field.name}.` };
      continue;
    }
    const message = checkJson(field, value);
    if (message) return { ok: false, param: field.name, message };
    values[field.name] = value;
  }
  return { ok: true, values };
}

function checkJson(field: Field, value: unknown): string | null {
  const type = field.type ?? "string";
  switch (type) {
    case "string": {
      if (typeof value !== "string") return `${field.name} must be a string.`;
      const format = checkFormat(field, value);
      if (format) return format;
      if (field.enum && !field.enum.includes(value)) return `${field.name} must be one of ${field.enum.join(", ")}.`;
      return null;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${field.name} must be a number.`;
      if (type === "integer" && !Number.isInteger(value)) return `${field.name} must be an integer.`;
      const range = rangeCheck(field, value);
      return "message" in range ? range.message : null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${field.name} must be true or false.`;
    case "array": {
      if (!Array.isArray(value)) return `${field.name} must be an array.`;
      if (field.minItems !== undefined && value.length < field.minItems) return `${field.name} must have at least ${field.minItems} item${field.minItems === 1 ? "" : "s"}.`;
      if (field.maxItems !== undefined && value.length > field.maxItems) return `${field.name} must have at most ${field.maxItems} items.`;
      const items = field.items;
      if (items) {
        for (const item of value) {
          if (items.type === "string" && typeof item !== "string") return `${field.name} must contain strings.`;
          if (items.type === "number" && typeof item !== "number") return `${field.name} must contain numbers.`;
          if (items.type === "object" && (typeof item !== "object" || item === null)) return `${field.name} must contain objects.`;
          if (items.enum && !items.enum.includes(item as string)) return `${field.name} must contain only ${items.enum.join(", ")}.`;
        }
      }
      return null;
    }
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value) ? null : `${field.name} must be an object.`;
    default:
      return null;
  }
}
