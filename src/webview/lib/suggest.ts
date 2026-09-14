// Typing suggestions for the request editor. URL bar: project endpoints, path segments, common words, query
// params and variables. Body: JSON bodies of similar requests, plus keys and values seen in the project. Pure.
import type { RequestMethod } from '../../shared/model';
import type { SuggestionRequest } from '../../shared/protocol';

export type SuggestionKind = 'endpoint' | 'segment' | 'word' | 'param' | 'variable' | 'host';

export interface TextSuggestion {
  /** The whole input text after accepting. */
  value: string;
  label: string;
  detail?: string;
  kind: SuggestionKind;
  method?: RequestMethod;
}

export interface UrlSuggestContext {
  requests: readonly SuggestionRequest[];
  /** The request being edited; never suggested to itself. */
  currentId?: string;
  folderId?: string;
  method?: RequestMethod;
  variableKeys?: readonly string[];
}

const COMMON_SEGMENTS = [
  'api', 'v1', 'v2', 'auth', 'login', 'logout', 'register', 'signup', 'refresh', 'token', 'verify', 'otp', 'password', 'reset',
  'me', 'profile', 'users', 'accounts', 'admin', 'roles', 'permissions', 'teams', 'organizations', 'projects', 'tasks',
  'health', 'status', 'ping', 'version', 'search', 'orders', 'products', 'items', 'cart', 'checkout', 'payments', 'invoices',
  'subscriptions', 'customers', 'files', 'upload', 'images', 'media', 'settings', 'config', 'notifications', 'messages',
  'comments', 'posts', 'categories', 'tags', 'reports', 'analytics', 'metrics', 'events', 'webhooks', 'sessions', 'logs',
  'export', 'import', 'bulk', 'list', 'details',
];
const STARTER_SEGMENTS = ['api', 'v1', 'auth', 'users', 'health'];
const COMMON_PARAMS = [
  'page', 'limit', 'offset', 'per_page', 'pageSize', 'cursor', 'sort', 'order', 'orderBy', 'q', 'query', 'search', 'filter',
  'fields', 'include', 'expand', 'status', 'type', 'from', 'to', 'startDate', 'endDate', 'lang', 'format', 'id',
];
const HOSTS = ['http://localhost:3000/', 'http://localhost:8080/', 'https://'];

const lc = (s: string) => s.toLowerCase();
const startsWithI = (s: string, prefix: string) => lc(s).startsWith(lc(prefix));

/** Suggestions for a URL being typed (caret at the end). Most useful first. */
export function suggestUrl(text: string, ctx: UrlSuggestContext, limit = 8): TextSuggestion[] {
  const others = ctx.requests.filter((r) => r.id !== ctx.currentId && r.url);
  const out: TextSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: TextSuggestion) => {
    if (s.value.length <= text.length || seen.has(lc(s.value))) return;
    seen.add(lc(s.value));
    out.push(s);
  };
  const relevance = (r: SuggestionRequest) => (r.folderId === ctx.folderId ? 4 : 0) + (r.method === ctx.method ? 1 : 0);

  // Query string: parameter names used in the project (same path first), then common ones.
  const q = text.indexOf('?');
  if (q >= 0) {
    const tail = text.slice(q + 1);
    const partial = tail.slice(tail.lastIndexOf('&') + 1);
    if (partial.includes('=')) return [];
    const used = new Set(tail.split('&').map((p) => p.split('=')[0]));
    const head = text.slice(0, text.length - partial.length);
    const path = lc(text.slice(0, q));
    const project = new Map<string, number>();
    for (const r of others) for (const k of r.paramKeys) project.set(k, (project.get(k) ?? 0) + (lc(r.url) === path ? 5 : 1));
    const keys = [...[...project.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k), ...COMMON_PARAMS];
    for (const k of keys) {
      if (!used.has(k) && startsWithI(k, partial)) push({ value: `${head}${k}=`, label: k, kind: 'param' });
    }
    return out.slice(0, limit);
  }

  // Start of the URL: a base URL variable or a local host.
  if (!text || /^\{\{?$/.test(text)) {
    const keys = [...(ctx.variableKeys ?? [])].sort((a, b) => Number(/url|host|base/i.test(b)) - Number(/url|host|base/i.test(a)));
    for (const k of keys.slice(0, 4)) push({ value: `{{${k}}}/`, label: `{{${k}}}/`, kind: 'variable' });
  }
  if (/^[a-z][\w+.-]*(?::\/{0,2}[^/]*)?$/i.test(text)) {
    for (const h of HOSTS) if (startsWithI(h, text)) push({ value: h, label: h, kind: 'host' });
  }

  const slash = text.lastIndexOf('/');
  const head = text.slice(0, slash + 1);
  const partial = text.slice(slash + 1);
  const inHost = /^[a-z][\w+.-]*:\/\/?[^/]*$/i.test(text) || /^[a-z][\w+.-]*:\/?\/?$/i.test(head);

  // Next path segment shared by project endpoints under what is typed so far ("gst/").
  if (slash >= 0 && !inHost) {
    const segments = new Map<string, { label: string; count: number; relevance: number }>();
    for (const r of others) {
      if (!startsWithI(r.url, head)) continue;
      const rest = r.url.slice(head.length);
      const seg = rest.split(/[/?#]/)[0];
      if (!seg || rest.length === seg.length || !startsWithI(seg, partial)) continue;
      const value = `${r.url.slice(0, head.length)}${seg}/`;
      const cur = segments.get(value) ?? { label: `${seg}/`, count: 0, relevance: 0 };
      cur.count++;
      cur.relevance = Math.max(cur.relevance, relevance(r));
      segments.set(value, cur);
    }
    const ranked = [...segments.entries()].sort((a, b) => b[1].relevance - a[1].relevance || b[1].count - a[1].count || a[0].localeCompare(b[0]));
    for (const [value, s] of ranked.slice(0, 4)) {
      push({ value, label: s.label, detail: `${s.count} ${s.count === 1 ? 'endpoint' : 'endpoints'}`, kind: 'segment' });
    }
  }

  // Whole endpoints of the project.
  if (text) {
    const endpoints = others
      .filter((r) => r.url.length > text.length && startsWithI(r.url, text))
      .sort((a, b) => relevance(b) - relevance(a) || a.url.length - b.url.length || a.url.localeCompare(b.url));
    for (const r of endpoints) push({ value: r.url, label: r.url, detail: r.name, kind: 'endpoint', method: r.method });
  }

  // Common words for the segment being typed; the request's folder name first.
  if (slash >= 0 && !inHost) {
    const folderName = ctx.folderId ? ctx.folderId.slice(ctx.folderId.lastIndexOf('/') + 1) : '';
    const words = [...(folderName ? [folderName] : []), ...COMMON_SEGMENTS];
    for (const w of words) {
      const fits = partial ? startsWithI(w, partial) && lc(w) !== lc(partial) : out.length === 0 && (w === folderName || STARTER_SEGMENTS.includes(w));
      if (fits) push({ value: head + w, label: w, kind: 'word' });
    }
  }
  return out.slice(0, limit);
}

/** The not-yet-typed rest of a suggestion, shown as faint inline text. Empty when it does not extend `text` exactly. */
export function ghostText(text: string, suggestion: TextSuggestion | undefined): string {
  return suggestion && suggestion.value.startsWith(text) ? suggestion.value.slice(text.length) : '';
}

// ---------- Body ----------

export interface BodySuggestion {
  id: string;
  name: string;
  method: RequestMethod;
  content: string;
  sameFolder: boolean;
}

export const isEmptyJson = (content: string) => /^\s*(?:\{\s*\}|\[\s*\])?\s*$/.test(content);

function pathSegments(url: string): string[] {
  return url
    .replace(/^(?:\{\{[^{}]+\}\})+/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean);
}

/** JSON bodies of other requests worth starting from: same folder, then same method, then similar path. */
export function suggestBodies(
  requests: readonly SuggestionRequest[],
  current: { id: string; folderId: string; method: RequestMethod; url: string },
  limit = 5,
): BodySuggestion[] {
  const cur = pathSegments(current.url);
  const scored: { r: SuggestionRequest; content: string; score: number }[] = [];
  for (const r of requests) {
    if (r.id === current.id || r.body?.type !== 'json' || isEmptyJson(r.body.content)) continue;
    const segs = pathSegments(r.url);
    let shared = 0;
    while (shared < Math.min(cur.length, segs.length) && lc(segs[shared]) === lc(cur[shared])) shared++;
    scored.push({ r, content: r.body.content, score: (r.folderId === current.folderId ? 10 : 0) + (r.method === current.method ? 3 : 0) + shared });
  }
  scored.sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name));
  const out: BodySuggestion[] = [];
  const seen = new Set<string>();
  for (const { r, content } of scored) {
    const key = content.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, name: r.name, method: r.method, content, sameFolder: r.folderId === current.folderId });
    if (out.length >= limit) break;
  }
  return out;
}

export interface JsonKeySuggestion {
  key: string;
  /** JSON literals seen for this key, most common first (e.g. `"active"`, `10`, `true`). */
  values: string[];
  source: 'folder' | 'project' | 'common';
}

const COMMON_KEYS: [string, string][] = [
  ['name', '""'], ['email', '""'], ['password', '""'], ['username', '""'], ['phone', '""'], ['id', '""'], ['title', '""'],
  ['description', '""'], ['status', '""'], ['type', '""'], ['token', '""'], ['firstName', '""'], ['lastName', '""'],
  ['address', '""'], ['userId', '""'], ['amount', '0'], ['quantity', '1'], ['price', '0'], ['currency', '"USD"'],
  ['page', '1'], ['limit', '10'], ['isActive', 'true'], ['enabled', 'true'], ['tags', '[]'], ['metadata', '{}'], ['data', '{}'],
];

const KEY_VALUE = /"([\w$-]+)"\s*:\s*("(?:[^"\\\n]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\{\{[^{}\n]+\}\}|\[\s*\]|\{\s*\})/g;
const KEY_OBJECT = /"([\w$-]+)"\s*:\s*[[{]/g;

/** Keys (with typical values) from other requests' JSON bodies, same folder weighted up, then common API keys. */
export function jsonKeyCorpus(requests: readonly SuggestionRequest[], current: { id: string; folderId: string }): JsonKeySuggestion[] {
  const keys = new Map<string, { score: number; folder: boolean; values: Map<string, number> }>();
  const entry = (key: string) => {
    const e = keys.get(key) ?? { score: 0, folder: false, values: new Map<string, number>() };
    keys.set(key, e);
    return e;
  };
  for (const r of requests) {
    if (r.id === current.id || r.body?.type !== 'json') continue;
    const weight = r.folderId === current.folderId ? 3 : 1;
    const inBody = new Set<string>();
    for (const m of r.body.content.matchAll(KEY_VALUE)) {
      const e = entry(m[1]);
      if (!inBody.has(m[1])) e.score += weight;
      inBody.add(m[1]);
      e.folder ||= weight === 3;
      if (m[2].length <= 80) e.values.set(m[2], (e.values.get(m[2]) ?? 0) + weight);
    }
    for (const m of r.body.content.matchAll(KEY_OBJECT)) {
      if (inBody.has(m[1])) continue;
      inBody.add(m[1]);
      const e = entry(m[1]);
      e.score += weight;
      e.folder ||= weight === 3;
    }
  }
  const out: JsonKeySuggestion[] = [...keys.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .map(([key, e]) => ({ key, values: [...e.values.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v), source: e.folder ? 'folder' : 'project' }));
  for (const [key, value] of COMMON_KEYS) if (!keys.has(key)) out.push({ key, values: [value], source: 'common' });
  return out;
}
