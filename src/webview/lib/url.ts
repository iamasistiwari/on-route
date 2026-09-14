// URL <-> params two-way sync. Pure; no DOM.
//
// Model: RequestDef.url is normally stored WITHOUT a query string and query parameters live in
// `params`. The URL bar shows `url` + enabled params. Editing the URL bar splits the text back.
// Values are kept verbatim (no encoding/decoding) so `{{vars}}` and `%20` survive round-trips.
import { isEnabled, type KeyValue } from '../../shared/model';

export interface SplitUrl {
  base: string;
  query: KeyValue[];
  /** True if the text contained a "?" (even with an empty query). */
  hasQuery: boolean;
}

export function parseQueryString(qs: string): KeyValue[] {
  if (qs === '') return [];
  return qs
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=');
      return eq === -1 ? { key: part, value: '' } : { key: part.slice(0, eq), value: part.slice(eq + 1) };
    });
}

export function splitUrl(text: string): SplitUrl {
  const q = text.indexOf('?');
  if (q === -1) return { base: text, query: [], hasQuery: false };
  return { base: text.slice(0, q), query: parseQueryString(text.slice(q + 1)), hasQuery: true };
}

export function buildQueryString(params: KeyValue[]): string {
  return params
    .filter((p) => isEnabled(p) && (p.key !== '' || p.value !== ''))
    .map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`))
    .join('&');
}

/** URL shown in the URL bar: base url + enabled params. */
export function buildUrl(url: string, params: KeyValue[]): string {
  const qs = buildQueryString(params);
  if (qs === '') return url;
  return url + (url.includes('?') ? '&' : '?') + qs;
}

/**
 * Merge params parsed from the URL bar into the existing table: enabled rows are overwritten in
 * order (keeping description), disabled rows stay put, extra parsed rows are appended and
 * surplus enabled rows are dropped.
 */
export function mergeParams(existing: KeyValue[], parsed: KeyValue[]): KeyValue[] {
  const out: KeyValue[] = [];
  let i = 0;
  for (const p of existing) {
    if (!isEnabled(p)) {
      out.push(p);
      continue;
    }
    // Rows with empty key+value are not in the URL; keep them only while there is nothing to map.
    if (p.key === '' && p.value === '') continue;
    if (i < parsed.length) {
      const next: KeyValue = { ...p, key: parsed[i].key, value: parsed[i].value };
      out.push(next);
      i++;
    }
  }
  for (; i < parsed.length; i++) out.push({ key: parsed[i].key, value: parsed[i].value });
  return out;
}

/** Apply an edit of the URL bar text to the request's url/params. */
export function applyUrlEdit(current: { url: string; params: KeyValue[] }, text: string): { url: string; params: KeyValue[] } {
  const { base, query } = splitUrl(text);
  return { url: base, params: mergeParams(current.params, query) };
}

/**
 * Whether the URL bar text is an equivalent rendering of url+params (e.g. "x?a=" vs "x?a").
 * Used to avoid clobbering what the user is typing.
 */
export function urlTextMatches(text: string, url: string, params: KeyValue[]): boolean {
  const { base, query } = splitUrl(text);
  return buildUrl(base, query) === buildUrl(url, params);
}
