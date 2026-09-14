// Helpers shared by the code generators: body shaping, header filtering and string literal escaping.
import type { ResolvedRequest } from '../model';

export type Header = { key: string; value: string };

/** Parse JSON only if it is safe to re-emit (no precision loss on big numbers). */
export function parseJsonSafely(content: string): { ok: true; value: unknown } | { ok: false } {
  const t = content.trim();
  if (!/^[[{]/.test(t)) return { ok: false };
  try {
    const value = JSON.parse(t);
    if (/(?<![\w."])-?\d{16,}/.test(t.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

export function headerValue(req: ResolvedRequest, name: string): string | undefined {
  return req.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;
}

/** The request's Content-Type: explicit header first, then the body's inferred type. */
export function contentType(req: ResolvedRequest): string | undefined {
  return headerValue(req, 'content-type') ?? (req.body.type === 'text' ? req.body.contentType : undefined);
}

/** Parsed JSON value when the text body is JSON (by content type, or untyped but parseable). */
export function jsonBody(req: ResolvedRequest): { ok: true; value: unknown } | { ok: false } {
  if (req.body.type !== 'text') return { ok: false };
  const ct = contentType(req);
  if (ct && !/json/i.test(ct)) return { ok: false };
  return parseJsonSafely(req.body.content);
}

/** Text body content, pretty-printed (2 spaces) when it is JSON. */
export function textBody(req: ResolvedRequest): string {
  if (req.body.type !== 'text') return '';
  const parsed = jsonBody(req);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : req.body.content;
}

/** Headers to emit. Drops a boundary-less multipart Content-Type so the client library can set its own. */
export function requestHeaders(req: ResolvedRequest, opts: { dropContentType?: boolean } = {}): Header[] {
  return req.headers.filter((h) => {
    const isCt = h.key.toLowerCase() === 'content-type';
    if (isCt && opts.dropContentType) return false;
    return !(isCt && req.body.type === 'form' && /^\s*multipart\/form-data\s*$/i.test(h.value));
  });
}

/** Headers with duplicate names merged, for languages that model headers as a map. */
export function mergedHeaders(req: ResolvedRequest, opts: { dropContentType?: boolean } = {}): Header[] {
  const out: Header[] = [];
  for (const h of requestHeaders(req, opts)) {
    const existing = out.find((x) => x.key.toLowerCase() === h.key.toLowerCase());
    if (existing) existing.value += (h.key.toLowerCase() === 'cookie' ? '; ' : ', ') + h.value;
    else out.push({ ...h });
  }
  return out;
}

export function urlEncodeFields(fields: Header[]): string {
  return fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&');
}

export function hasUniqueKeys(fields: Header[]): boolean {
  return new Set(fields.map((f) => f.key)).size === fields.length;
}

export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** Split a URL without requiring it to be valid (unresolved {{variables}} are allowed). */
export function splitUrl(url: string): { scheme: string; host: string; path: string } {
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)(.*)$/i.exec(url.trim())!;
  const path = m[3].replace(/#.*$/, '');
  return { scheme: (m[1] ?? 'https').toLowerCase(), host: m[2], path: path.startsWith('/') ? path : `/${path}` };
}

/**
 * Newline placeholder for multi-line string literals whose content must not be re-indented (Go backticks,
 * Rust raw strings, Dart triple quotes). `indent` turns it back into a real newline.
 */
export const LITERAL_NL = '';

export function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => (l ? prefix + l : l))
    .join('\n')
    .replaceAll(LITERAL_NL, '\n');
}

export interface DqOptions {
  /** Also escape `$` (Kotlin, Dart, PHP double quotes). */
  dollar?: boolean;
  /** How to write other control characters; default `\uXXXX`. */
  unicode?: 'u4' | 'braces' | 'x2';
}

/** C-family double-quoted string literal. */
export function dq(s: string, opts: DqOptions = {}): string {
  let out = '"';
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (c === '\\') out += '\\\\';
    else if (c === '"') out += '\\"';
    else if (c === '$' && opts.dollar) out += '\\$';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      const hex = code.toString(16);
      if (opts.unicode === 'braces') out += `\\u{${hex}}`;
      else if (opts.unicode === 'x2' && code < 0x100) out += `\\x${hex.padStart(2, '0')}`;
      else out += `\\u${hex.padStart(4, '0')}`;
    } else out += c;
  }
  return out + '"';
}

/** Single-quoted literal where only backslash and quote are escaped (PHP, Ruby, Dart without `$`). */
export function sq(s: string): string {
  return "'" + s.replace(/[\\']/g, (c) => '\\' + c) + "'";
}

/** Longest run of `ch` in `s`. */
export function longestRun(s: string, ch: string): number {
  let max = 0;
  let cur = 0;
  for (const c of s) {
    cur = c === ch ? cur + 1 : 0;
    max = Math.max(max, cur);
  }
  return max;
}

export function bodyAllowed(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}
