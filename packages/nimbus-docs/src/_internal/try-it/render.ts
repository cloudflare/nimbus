/**
 * `renderSample(request, lang, { mask })`: a sendable request as cURL,
 * TypeScript (fetch) or Python (requests), through the same renderers as the
 * page's generated samples. With `mask`, every credential becomes a
 * placeholder, wherever it appears.
 */
import { HTTP_SAMPLE_TARGETS } from "../api/http-sample-render.js";
import type { Segment, SampleBody, SampleField, SampleMultipartPart, SampleRequest } from "../api/http-sample.js";
import type { HttpRequest } from "./plan.js";
import { encodeCookie, encodeQuery } from "./serialize.js";

export type SampleLang = "curl" | "typescript" | "python";

export function renderSample(request: HttpRequest, lang: SampleLang, options: { mask?: boolean } = {}): string {
  const target = HTTP_SAMPLE_TARGETS.find((t) => t.lang === lang);
  if (!target) throw new Error(`No sample renderer for ${lang}.`);
  return target.render(toSampleRequest(request, options.mask ?? true)) ?? "";
}

/** A text with each secret (and its URL- and cookie-encoded forms) as a placeholder. */
export function maskedSegments(text: string, secrets: HttpRequest["secrets"], mask: boolean): Segment[] {
  if (!mask || secrets.length === 0) return [{ text }];
  const forms = secrets
    .filter((s) => s.value !== "")
    .flatMap((s) => [...new Set([s.value, encodeQuery(s.value), encodeCookie(s.value), encodeURIComponent(s.value)])].map((form) => ({ form, label: s.label })))
    // Longest first, so a password inside a Basic token's source text can't split the token.
    .sort((a, b) => b.form.length - a.form.length);
  let out: Segment[] = [{ text }];
  for (const { form, label } of forms) {
    out = out.flatMap((segment) => {
      if (!("text" in segment) || !segment.text.includes(form)) return [segment];
      return segment.text.split(form).flatMap((piece, i) => (i === 0 ? [{ text: piece }] : [{ placeholder: label, secret: true }, { text: piece }]));
    });
  }
  return out.filter((segment) => !("text" in segment) || segment.text !== "");
}

/** Text with the secrets masked as `<label>`: for URL displays. */
export function maskText(text: string, secrets: HttpRequest["secrets"]): string {
  return maskedSegments(text, secrets, true).map((s) => ("text" in s ? s.text : `<${s.placeholder}>`)).join("");
}

function toSampleRequest(request: HttpRequest, mask: boolean): SampleRequest {
  const seg = (text: string) => maskedSegments(text, request.secrets, mask);
  const headers: SampleField[] = request.headers.map(([name, value]) => ({ name, value: seg(value) }));
  const sample: SampleRequest = { method: request.method, url: seg(request.url), query: [], headers, cookies: [], rawUrl: true };
  const body = request.body;
  if (!body) return sample;
  let out: SampleBody;
  switch (body.kind) {
    case "json": {
      // Pretty JSON renders as a JSON body; anything else is sent, and shown, byte for byte.
      let value: unknown;
      try {
        value = JSON.parse(body.text);
      } catch {
        value = undefined;
      }
      out = value !== undefined && JSON.stringify(value, null, 2) === body.text && /^application\/json$/i.test(body.mediaType)
        ? { kind: "json", mediaType: body.mediaType, value }
        : { kind: "text", mediaType: body.mediaType, text: body.text };
      break;
    }
    case "text":
      out = { kind: "text", mediaType: body.mediaType, text: body.text };
      break;
    case "bytes":
      out = { kind: "text", mediaType: body.mediaType, text: `<${fileName(body.file) ?? "file"}>` };
      break;
    case "form":
      out = { kind: "form", fields: body.fields };
      break;
    case "multipart":
      out = {
        kind: "multipart",
        parts: body.parts.map((part): SampleMultipartPart => {
          if (typeof part.value !== "string") {
            const file = part.filename ?? fileName(part.value) ?? "file";
            return part.contentType ? { name: part.name, kind: "file", file, contentType: part.contentType } : { name: part.name, kind: "file", file };
          }
          return part.contentType
            ? { name: part.name, kind: "typed", value: part.value, contentType: part.contentType }
            : { name: part.name, kind: "text", value: part.value };
        }),
      };
      break;
  }
  sample.body = out;
  return sample;
}

function fileName(file: Blob): string | undefined {
  const name = (file as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : undefined;
}
