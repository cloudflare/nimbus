/**
 * The form's checks, by the support table's Validation row. Blocking ones stop
 * Send; advisory ones only show. Values are read as entered, never trimmed or
 * normalised.
 */
import type { FormValues, PlanParam, PlanSchema, RequestPlan, RequestValues } from "./plan.js";
import { paramKey } from "./plan.js";

export interface Issue {
  /** The parameter's key (`query:limit`), `body`, or `auth:<scheme>`. */
  key: string;
  message: string;
  blocking: boolean;
}

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateValues(plan: RequestPlan, values: RequestValues): Issue[] {
  const issues: Issue[] = [];
  for (const param of plan.params) {
    if (param.ignored) continue;
    const key = paramKey(param);
    const value = values.params[key];
    if (value === undefined) {
      if (param.required) issues.push({ key, message: "Required.", blocking: true });
      continue;
    }
    issues.push(...checkParam(param, value).map((issue) => ({ key, ...issue })));
  }
  const body = values.body;
  if (body) {
    const media = plan.body?.media.find((m) => m.mediaType === body.mediaType);
    if (media?.kind === "json" && typeof body.value === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.value);
      } catch (error) {
        issues.push({ key: "body", message: `Not valid JSON: ${(error as Error).message}`, blocking: true });
      }
      // An object body's required properties, as a form's required fields: one missing stops Send.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const field of media.fields ?? []) {
          if (field.required && !Object.hasOwn(parsed, field.name)) issues.push({ key: `body:${field.name}`, message: "Required.", blocking: true });
        }
      }
    }
    // A form's required fields, a file part included: one that's missing stops Send. Present
    // and empty (a sample's `""`) is sent, as a required parameter's is.
    if ((media?.kind === "form" || media?.kind === "multipart") && body.value && typeof body.value === "object") {
      const given = (body.value as FormValues).fields ?? [];
      for (const field of media.fields ?? []) {
        if (!field.required) continue;
        if (!given.some((f) => f.name === field.name)) issues.push({ key: `body:${field.name}`, message: field.file ? "Choose a file." : "Required.", blocking: true });
      }
    }
  } else if (plan.body?.required) {
    issues.push({ key: "body", message: "This request needs a body.", blocking: true });
  }
  return issues;
}

/** One value's checks: a scalar, a list's items, or JSON for a value a control can't hold. */
export function checkParam(param: PlanParam, value: unknown): Omit<Issue, "key">[] {
  const out: Omit<Issue, "key">[] = [];
  if (param.in === "header") {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (/[\r\n\0]/.test(text)) out.push({ message: "A header can't hold a line break or NUL.", blocking: true });
  }
  if (param.content) return out;
  if (param.schema.type === "array") {
    const items = Array.isArray(value) ? value : [];
    items.forEach((item, i) => {
      for (const issue of checkScalar(param.schema.items ?? {}, item)) out.push({ ...issue, message: `Item ${i + 1}: ${issue.message}` });
    });
    return out;
  }
  if (param.schema.type === "object") return out;
  out.push(...checkScalar(param.schema, value));
  return out;
}

export function checkScalar(schema: PlanSchema, value: unknown): Omit<Issue, "key">[] {
  if (value === null) return schema.nullable ? [] : [{ message: "Can't be null.", blocking: true }];
  const text = typeof value === "string" ? value : String(value);
  const out: Omit<Issue, "key">[] = [];
  if (schema.enum && !schema.enum.some((option) => String(option) === text)) {
    out.push({ message: `One of ${schema.enum.map(String).join(", ")}.`, blocking: true });
    return out;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (!NUMBER.test(text)) return [{ message: schema.type === "integer" ? "Not a whole number." : "Not a number.", blocking: true }];
    const n = Number(text);
    if (schema.type === "integer" && !Number.isInteger(n)) return [{ message: "Not a whole number.", blocking: true }];
    if (schema.minimum !== undefined && n < schema.minimum) out.push({ message: `At least ${schema.minimum}.`, blocking: false });
    if (schema.maximum !== undefined && n > schema.maximum) out.push({ message: `At most ${schema.maximum}.`, blocking: false });
    return out;
  }
  if (schema.type === "boolean") {
    return text === "true" || text === "false" ? [] : [{ message: "true or false.", blocking: true }];
  }
  // Own entries only: a format named `constructor` is just one we don't check.
  const format = schema.format && Object.hasOwn(FORMATS, schema.format) ? FORMATS[schema.format] : undefined;
  if (format && !format.test(text)) out.push({ message: format.message, blocking: false });
  return out;
}

interface FormatCheck {
  test(text: string): boolean;
  message: string;
}

// The HTML Standard's valid e-mail address.
const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// RFC 3986's `URI`: a scheme, then URI characters or percent-encoded bytes.
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;
// RFC 9562's text form, any version, either case.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function validDate(text: string): boolean {
  const m = FULL_DATE.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

function validDateTime(text: string): boolean {
  const m = DATE_TIME.exec(text);
  if (!m || !validDate(m[1]!)) return false;
  const [hour, minute, second] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const [offsetHour, offsetMinute] = m[5] ? [Number(m[6]), Number(m[7])] : [0, 0];
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return false;
  if (second === 60) {
    // A leap second falls at 23:59:60 UTC.
    const sign = m[5] === "-" ? 1 : -1;
    const utc = (((hour * 60 + minute + sign * (offsetHour * 60 + offsetMinute)) % 1440) + 1440) % 1440;
    return utc === 23 * 60 + 59;
  }
  return true;
}

const FORMATS: Record<string, FormatCheck> = {
  email: { test: (t) => EMAIL.test(t), message: "Doesn't look like an email address." },
  uri: { test: (t) => URI.test(t), message: "Doesn't look like a URI." },
  uuid: { test: (t) => UUID.test(t), message: "Doesn't look like a UUID." },
  date: { test: validDate, message: "Doesn't look like a date (YYYY-MM-DD)." },
  "date-time": { test: validDateTime, message: "Doesn't look like a date-time (RFC 3339)." },
};
