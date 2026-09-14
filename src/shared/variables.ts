// OWNER: agent "core-logic". Interface is fixed; implement bodies.
import { appendQueryParam, applyAuth } from './auth';
import type { AuthConfig, RequestDef, ResolvedBody, ResolvedRequest, Variable } from './model';
import { isEnabled } from './model';

/** A named layer of variables. */
export interface VariableScope {
  name: string; // "project", "folder users", "environment dev", "local"
  variables: Variable[];
}

/**
 * Merge scopes into a flat map. Scopes are passed LOWEST precedence first:
 *   project < folders (outer→inner) < environment < local overrides/secrets
 * Disabled variables are skipped. Secret variables with empty value do not override lower scopes.
 */
export function buildVariableMap(scopes: VariableScope[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const scope of scopes) {
    for (const v of scope.variables) {
      if (!v.key || !isEnabled(v)) continue;
      if (v.secret && (v.value ?? '') === '') continue;
      map[v.key] = v.value ?? '';
    }
  }
  return map;
}

const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const MAX_DEPTH = 3;

function dynamicValue(name: string): string | undefined {
  switch (name) {
    case '$uuid':
      return globalThis.crypto.randomUUID();
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000));
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$randomInt':
      return String(Math.floor(Math.random() * 1001));
    default:
      return undefined;
  }
}

/**
 * Replace {{name}} (whitespace inside braces allowed) with values. Unknown names are left
 * as-is and reported in `missing`. Dynamic vars: {{$uuid}}, {{$timestamp}} (unix seconds),
 * {{$isoTimestamp}}, {{$randomInt}} (0-1000). Values are substituted once (no recursion
 * beyond 3 levels of nested variable references like baseUrl -> {{host}}).
 */
export function resolveString(
  input: string,
  vars: Record<string, string>,
  opts: { dynamic?: boolean } = {},
): { value: string; missing: string[] } {
  const missing = new Set<string>();
  const walk = (s: string, depth: number): string =>
    s.replace(VAR_RE, (match, rawName: string) => {
      const name = rawName.trim();
      if (!name) return match;
      if (name.startsWith('$')) {
        if (opts.dynamic === false) return match;
        const dyn = dynamicValue(name);
        if (dyn !== undefined) return dyn;
      }
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        const val = vars[name];
        return depth < MAX_DEPTH ? walk(val, depth + 1) : val;
      }
      missing.add(name);
      return match;
    });
  const value = input ? walk(input, 0) : input ?? '';
  return { value, missing: [...missing] };
}

export interface ResolveOptions {
  vars: Record<string, string>;
  /** Effective auth (already inheritance-resolved via effectiveAuth). */
  auth: AuthConfig;
  /** Substitute {{$uuid}}-style dynamic vars. Default true; false keeps them as placeholders (code export). */
  dynamic?: boolean;
}

/**
 * RequestDef -> ResolvedRequest: substitute vars in url/params/headers/body/auth, append enabled
 * params to URL (preserving existing query string), drop disabled rows, apply auth, infer
 * Content-Type (json => application/json, urlencoded => application/x-www-form-urlencoded,
 * raw => contentType if given) unless user set one. Form bodies leave Content-Type to the executor.
 */
export function resolveRequest(req: RequestDef, opts: ResolveOptions): { request: ResolvedRequest; missing: string[] } {
  const missing = new Set<string>();
  const r = (s: string | undefined): string => {
    const res = resolveString(s ?? '', opts.vars, { dynamic: opts.dynamic });
    res.missing.forEach((m) => missing.add(m));
    return res.value;
  };

  let url = r(req.url);
  for (const p of req.params ?? []) {
    if (!isEnabled(p)) continue;
    const key = r(p.key);
    const value = r(p.value);
    if (!key && !value) continue;
    url = appendQueryParam(url, key, value);
  }

  const headers: { key: string; value: string }[] = [];
  for (const h of req.headers ?? []) {
    if (!isEnabled(h)) continue;
    const key = r(h.key).trim();
    if (!key) continue;
    headers.push({ key, value: r(h.value) });
  }

  let body: ResolvedBody;
  let inferredType: string | undefined;
  const b = req.body ?? { type: 'none' };
  switch (b.type) {
    case 'json':
      body = { type: 'text', content: r(b.content), contentType: 'application/json' };
      inferredType = 'application/json';
      break;
    case 'raw': {
      const contentType = b.contentType ? r(b.contentType) : undefined;
      body = contentType ? { type: 'text', content: r(b.content), contentType } : { type: 'text', content: r(b.content) };
      inferredType = contentType;
      break;
    }
    case 'urlencoded':
      body = {
        type: 'urlencoded',
        fields: b.fields.filter(isEnabled).map((f) => ({ key: r(f.key), value: r(f.value) })),
      };
      inferredType = 'application/x-www-form-urlencoded';
      break;
    case 'form':
      body = {
        type: 'form',
        fields: b.fields.filter(isEnabled).map((f) => ({ key: r(f.key), value: r(f.value), kind: f.kind ?? 'text' })),
      };
      break;
    case 'binary':
      body = { type: 'binary', filePath: r(b.filePath) };
      break;
    default:
      body = { type: 'none' };
  }

  if (inferredType && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: inferredType });
  }

  const auth = resolveAuth(opts.auth, r);
  // A WebSocket handshake is a GET request.
  const request = applyAuth({ method: req.method === 'WS' ? 'GET' : req.method, url, headers, body }, auth);
  return { request, missing: [...missing] };
}

function resolveAuth(auth: AuthConfig, r: (s: string) => string): AuthConfig {
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: r(auth.token) };
    case 'basic':
      return { type: 'basic', username: r(auth.username), password: r(auth.password) };
    case 'apikey':
      return { type: 'apikey', key: r(auth.key), value: r(auth.value), in: auth.in };
    default:
      return auth;
  }
}
