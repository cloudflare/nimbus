/**
 * One outbound HTTP request, as a code sample shows it.
 *
 * This is the boundary between an API front-end and the sample renderers: it
 * describes an HTTP request and nothing about where it came from (no OpenAPI
 * schemas, styles or version rules), so any front-end whose calls travel over
 * HTTP can produce one. It isn't a message, receiver, RPC-call or session
 * model; other protocols bring their own.
 *
 * Every value is a list of segments: literal text, or a placeholder the reader
 * fills in (`<base-url>`, `<id>`, a credential). Renderers write each kind for
 * their language, so authored text that happens to look like `<id>` stays
 * text, and a placeholder is never URL-encoded or escaped as data.
 *
 * Pure: no dependencies, safe in the browser.
 */

/** Literal text, or a placeholder written as `<name>`. `secret` marks a credential. */
export type Segment = { text: string } | { placeholder: string; secret?: boolean };

/** A value: its segments, concatenated. */
export type SampleValue = readonly Segment[];

export interface SampleField {
  name: string;
  value: SampleValue;
}

/** A form field as it is sent: its name and its unencoded value. */
export interface SampleFormField {
  name: string;
  value: string;
}

/** One part of a `multipart/form-data` body. A `typed` part is sent with its
 *  own content type; `json` holds the value it serializes; a `file` part names
 *  the file the reader supplies. */
export type SampleMultipartPart =
  | { name: string; kind: "text"; value: string }
  | { name: string; kind: "typed"; value: string; contentType: string }
  | { name: string; kind: "json"; value: unknown; contentType: string }
  | { name: string; kind: "file"; file: string; contentType?: string };

/**
 * The request body, tagged by how it is written:
 * - `json`: a JSON value under one of the plain JSON media types;
 * - `text`: any other body, its bytes exactly as given;
 * - `form`: URL-encoded fields, encoded by the client (repeated names allowed);
 * - `encodedForm`: an already-encoded form, sent byte for byte;
 * - `multipart`: parts, sent with the client's own boundary.
 */
export type SampleBody =
  | { kind: "json"; mediaType: string; value: unknown }
  | { kind: "text"; mediaType: string; text: string }
  | { kind: "form"; fields: readonly SampleFormField[] }
  | { kind: "encodedForm"; text: string }
  | { kind: "multipart"; parts: readonly SampleMultipartPart[] };

export interface SampleRequest {
  /** Upper case. */
  method: string;
  /** The URL up to and including the path, plus any query the server URL itself carries. */
  url: SampleValue;
  /** Query parameters added to the URL, in order; names may repeat. */
  query: readonly SampleField[];
  /** Headers in order, with their original casing; `Content-Type` included when a body sets it. */
  headers: readonly SampleField[];
  cookies: readonly SampleField[];
  body?: SampleBody;
  /** The URL is complete and already encoded, query included: written as is. */
  rawUrl?: true;
}

export const text = (value: string): Segment => ({ text: value });
export const placeholder = (name: string, secret = false): Segment =>
  secret ? { placeholder: name, secret: true } : { placeholder: name };

export const isPlaceholder = (segment: Segment): segment is { placeholder: string; secret?: boolean } =>
  "placeholder" in segment;

/** A value written out, placeholders as `<name>`. */
export function plainText(value: SampleValue): string {
  return value.map((segment) => (isPlaceholder(segment) ? `<${segment.placeholder}>` : segment.text)).join("");
}
