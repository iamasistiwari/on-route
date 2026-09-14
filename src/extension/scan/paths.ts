// Route path normalization, endpoint identity and naming rules for scanned requests.
import type { RequestMethod } from '../../shared/model';

/** Converts one path segment's parameter syntax to `:name` ({id}, <int:id>, [id], [...slug], :id?, *path, {{id}}). */
export function normalizeSegment(seg: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^\{\{\s*([\w$.-]+)\s*\}\}$/.exec(seg))) return `:${m[1]}`;
  if ((m = /^\{([A-Za-z_][\w-]*)(?:\.\.\.)?(?::.*)?\}$/.exec(seg))) return `:${m[1]}`;
  if ((m = /^<(?:[\w.]+:)?([A-Za-z_]\w*)>$/.exec(seg))) return `:${m[1]}`;
  if ((m = /^\[{1,2}(?:\.\.\.)?([\w-]+)\]{1,2}$/.exec(seg))) return `:${m[1]}`;
  if ((m = /^:([A-Za-z_][\w-]*)/.exec(seg))) return `:${m[1]}`;
  if ((m = /^\*([A-Za-z_]\w*)$/.exec(seg))) return `:${m[1]}`;
  return seg;
}

const isParam = (seg: string) => seg.startsWith(':');

/**
 * Joins route parts ("/api", "users/", "/:id") into one normalized path with a leading slash. With
 * `keepTrailingSlash` (Python / Django, where it is significant) a trailing slash on the last non-empty
 * part is kept.
 */
export function joinPath(parts: readonly (string | undefined)[], keepTrailingSlash = false): string {
  const segs: string[] = [];
  let trailing = false;
  for (const raw of parts) {
    const t = raw?.trim();
    if (!t) continue;
    for (const s of t.split('/')) if (s) segs.push(normalizeSegment(s));
    trailing = t.endsWith('/');
  }
  if (!segs.length) return '/';
  return `/${segs.join('/')}${keepTrailingSlash && trailing ? '/' : ''}`;
}

/** Path identity used for de-duplication: params anonymized, no trailing slash. */
export function canonicalPath(path: string): string {
  const segs = path
    .split('/')
    .filter(Boolean)
    .map((s) => (isParam(normalizeSegment(s)) ? ':' : s));
  return `/${segs.join('/')}`;
}

/** "GET /users/:" — stable identity of an endpoint across scans, renames and moves. */
export function endpointKey(method: RequestMethod, path: string): string {
  return `${method} ${canonicalPath(path)}`;
}

/** Path part of a saved request URL: leading {{variables}}, scheme + host, query and fragment removed. */
export function pathFromUrl(url: string): string {
  let s = url.trim().replace(/^(?:\{\{[^{}]+\}\})+/, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  s = s.split(/[?#]/)[0];
  return s.startsWith('/') ? s : `/${s}`;
}

/** Keeps letters, digits, "_" and "-" (case preserved); everything else becomes "-". */
export function sanitizeSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/** English singular for resource names: "users" -> "user", "categories" -> "category", "boxes" -> "box". */
export function singular(word: string): string {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

const PREFIX_SEGMENT =/^(?:api|rest|v\d+(?:\.\d+)*)$/i;

/**
 * Router group of a path: its first segment after leading "api" / version segments.
 * "/api/v1/gst/gst-to-contact" -> "gst"; "/health" -> "health"; "/api/v1" or "/:id" -> "".
 */
export function routeGroup(path: string): string {
  const segs = path.split('/').filter(Boolean).map(normalizeSegment);
  let i = 0;
  while (i < segs.length && PREFIX_SEGMENT.test(segs[i])) i++;
  const first = segs[i];
  return first && !isParam(first) ? sanitizeSlug(first) : '';
}

/**
 * File name of a scanned request: the last path segment, case preserved.
 * "/api/v1/gst/gst-to-contact" -> "gst-to-contact"; "/users/:id" -> "users-by-id"; "/" -> "root".
 */
export function requestSlug(path: string): string {
  const segs = path.split('/').filter(Boolean).map(normalizeSegment);
  const params: string[] = [];
  let last = segs.length - 1;
  while (last >= 0 && isParam(segs[last])) params.unshift(segs[last--].slice(1));
  let slug = (last >= 0 ? sanitizeSlug(segs[last]) : '') || 'root';
  const names = params.map(sanitizeSlug).filter(Boolean);
  if (names.length) slug += `-by-${names.join('-and-')}`;
  return slug.slice(0, 80).replace(/-+$/, '');
}
