// OWNER: agent "core-logic". Interface is fixed; implement bodies.
import type { AuthConfig, ResolvedRequest } from './model';

export interface AuthLayer {
  source: string; // "request", "folder users", "project"
  auth: AuthConfig | undefined;
}

/**
 * Walk layers from most specific (request) to least (project). First layer whose auth is not
 * `inherit`/undefined wins. If all inherit, result is { type: 'none' } with source "none".
 */
export function effectiveAuth(layers: AuthLayer[]): { auth: AuthConfig; source: string } {
  for (const layer of layers) {
    if (layer.auth && layer.auth.type !== 'inherit') {
      return { auth: layer.auth, source: layer.source };
    }
  }
  return { auth: { type: 'none' }, source: 'none' };
}

/** Base64 of the UTF-8 bytes of `s`. Works in Node and browsers (no Buffer). */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Percent-encode a query component without double-encoding existing `%XX` escapes and without
 * encoding unresolved `{{var}}` placeholders (keeps generated code readable).
 */
export function encodeQueryComponent(s: string): string {
  return s
    .split(/(\{\{[^{}]*\}\})/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // placeholder
      return part
        .split(/(%[0-9A-Fa-f]{2})/)
        .map((p, j) => (j % 2 === 1 ? p : safeEncode(p)))
        .join('');
    })
    .join('');
}

function safeEncode(s: string): string {
  try {
    return encodeURIComponent(s);
  } catch {
    return s; // lone surrogate etc.
  }
}

/** Append `key[=value]` to a URL, respecting an existing query string and fragment. */
export function appendQueryParam(url: string, key: string, value: string): string {
  const hashIdx = url.indexOf('#');
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const pair = value === '' ? encodeQueryComponent(key) : `${encodeQueryComponent(key)}=${encodeQueryComponent(value)}`;
  let sep: string;
  if (!base.includes('?')) sep = '?';
  else if (base.endsWith('?') || base.endsWith('&')) sep = '';
  else sep = '&';
  return `${base}${sep}${pair}${hash}`;
}

function hasHeader(headers: { key: string }[], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some((h) => h.key.toLowerCase() === n);
}

function hasQueryParam(url: string, key: string): boolean {
  const q = url.split('#')[0].split('?').slice(1).join('?');
  if (!q) return false;
  return q.split('&').some((pair) => {
    const k = pair.split('=')[0];
    let decoded = k;
    try {
      decoded = decodeURIComponent(k);
    } catch {
      /* keep raw */
    }
    return k === key || decoded === key;
  });
}

/**
 * Apply an (already variable-resolved) auth to a resolved request. Does not override a header the
 * user set explicitly (case-insensitive: Authorization, or apikey header name).
 * bearer => Authorization: Bearer <token>; basic => Authorization: Basic base64(user:pass);
 * apikey header => <key>: <value>; apikey query => append ?key=value to url (URL-encoded).
 * Must work in both Node and browser (no Buffer; use btoa on UTF-8 bytes).
 */
export function applyAuth(req: ResolvedRequest, auth: AuthConfig): ResolvedRequest {
  const out: ResolvedRequest = { ...req, headers: [...req.headers] };
  switch (auth.type) {
    case 'bearer':
      if (!hasHeader(out.headers, 'Authorization')) {
        out.headers.push({ key: 'Authorization', value: `Bearer ${auth.token}` });
      }
      break;
    case 'basic':
      if (!hasHeader(out.headers, 'Authorization')) {
        out.headers.push({ key: 'Authorization', value: `Basic ${base64Utf8(`${auth.username}:${auth.password}`)}` });
      }
      break;
    case 'apikey':
      if (!auth.key) break;
      if (auth.in === 'query') {
        if (!hasQueryParam(out.url, auth.key)) out.url = appendQueryParam(out.url, auth.key, auth.value);
      } else if (!hasHeader(out.headers, auth.key)) {
        out.headers.push({ key: auth.key, value: auth.value });
      }
      break;
    default:
      break;
  }
  return out;
}
