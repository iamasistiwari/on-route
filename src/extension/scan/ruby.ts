// Ruby routes: Rails config/routes.rb (verbs, resources, namespace / scope, member / collection blocks).
import type { HttpMethod } from '../../shared/model';
import { joinPath, singular } from './paths';
import { lineIndex, stripComments } from './source';
import type { ScannedRoute, SourceFile } from './types';

export const RAILS_ROUTES = /(?:^|\/)config\/routes(?:\/[\w-]+)?\.rb$/;

interface Frame {
  /** Path contributed by this block. */
  prefix: string;
  /** member / collection blocks replace the enclosing resource's nested prefix. */
  override?: string;
  resource?: { name: string; singular: boolean };
}

const RESOURCES_ACTIONS: { action: string; method: HttpMethod; member: boolean }[] = [
  { action: 'index', method: 'GET', member: false },
  { action: 'create', method: 'POST', member: false },
  { action: 'show', method: 'GET', member: true },
  { action: 'update', method: 'PATCH', member: true },
  { action: 'destroy', method: 'DELETE', member: true },
];
const RESOURCE_ACTIONS: { action: string; method: HttpMethod }[] = [
  { action: 'show', method: 'GET' },
  { action: 'create', method: 'POST' },
  { action: 'update', method: 'PATCH' },
  { action: 'destroy', method: 'DELETE' },
];

/** Symbols in `only: [:index, :show]`, `only: %i[index show]` or `only: :index`. */
function symbols(opts: string, key: string): string[] | undefined {
  const m = new RegExp(`\\b${key}:\\s*(\\[[^\\]]*\\]|%[iw]\\[[^\\]]*\\]|:\\w+)`).exec(opts);
  if (!m) return undefined;
  return m[1].startsWith('%') ? m[1].slice(3, -1).trim().split(/\s+/) : [...m[1].matchAll(/:?(\w+)/g)].map((x) => x[1]);
}

export function scanRuby(sources: readonly SourceFile[]): ScannedRoute[] {
  const out: ScannedRoute[] = [];
  for (const src of sources) {
    if (!RAILS_ROUTES.test(src.path)) continue;
    const code = stripComments(src.text, 'hash');
    const lineOf = lineIndex(code);
    const stack: Frame[] = [];
    const current = () => {
      const parts: string[] = [];
      for (const f of stack) {
        if (f.override !== undefined) parts[parts.length - 1] = f.override;
        else parts.push(f.prefix);
      }
      return parts;
    };
    const enclosingResource = () => [...stack].reverse().find((f) => f.resource)?.resource;
    const emit = (method: HttpMethod, parts: string[], pos: number) =>
      out.push({ method, path: joinPath(parts), framework: 'Rails', file: src.path, line: lineOf(pos) });

    let offset = 0;
    for (const raw of code.split('\n')) {
      const pos = offset;
      offset += raw.length + 1;
      const line = raw.trim();
      if (!line) continue;
      const opens = /\bdo\s*(?:\|[^|]*\|)?\s*$/.test(line);
      if (/^end\b/.test(line)) {
        stack.pop();
        continue;
      }
      let m: RegExpExecArray | null;
      if ((m = /^namespace\s*\(?\s*:(\w+)/.exec(line))) {
        if (opens) stack.push({ prefix: m[1] });
      } else if (/^scope\b/.test(line)) {
        const path = /^scope\s*\(?\s*(?:path:\s*)?(['"])\/?(.*?)\1/.exec(line)?.[2] ?? /\bpath:\s*(['"])\/?(.*?)\1/.exec(line)?.[2] ?? '';
        if (opens) stack.push({ prefix: path });
      } else if ((m = /^(resources?)\s*\(?\s*:(\w+)(.*)$/.exec(line))) {
        const isSingular = m[1] === 'resource';
        const name = m[2];
        const opts = m[3];
        const only = symbols(opts, 'only');
        const except = symbols(opts, 'except');
        const keep = (action: string) => (!only || only.includes(action)) && !except?.includes(action);
        const base = current();
        if (isSingular) {
          for (const a of RESOURCE_ACTIONS) if (keep(a.action)) emit(a.method, [...base, name], pos);
        } else {
          for (const a of RESOURCES_ACTIONS) if (keep(a.action)) emit(a.method, a.member ? [...base, name, ':id'] : [...base, name], pos);
        }
        if (opens) {
          stack.push({ prefix: isSingular ? name : `${name}/:${singular(name)}_id`, resource: { name, singular: isSingular } });
        }
      } else if (/^member\s+do\b/.test(line)) {
        const res = enclosingResource();
        stack.push({ prefix: '', override: res ? (res.singular ? res.name : `${res.name}/:id`) : '' });
      } else if (/^collection\s+do\b/.test(line)) {
        const res = enclosingResource();
        stack.push({ prefix: '', override: res ? res.name : '' });
      } else if ((m = /^(get|post|put|patch|delete|match)\s*\(?\s*(?:(['"])(.*?)\2|:(\w+))(.*)$/.exec(line))) {
        const path = m[3] ?? m[4];
        const opts = m[5];
        let methods: HttpMethod[] = [m[1] === 'match' ? 'GET' : (m[1].toUpperCase() as HttpMethod)];
        if (m[1] === 'match') {
          const via = symbols(opts, 'via');
          if (via && !via.includes('all')) methods = via.map((v) => v.toUpperCase() as HttpMethod);
        }
        let parts = current();
        const on = /\bon:\s*:(member|collection)/.exec(opts)?.[1];
        const res = enclosingResource();
        if (on && res) parts = [...parts.slice(0, -1), on === 'member' && !res.singular ? `${res.name}/:id` : res.name];
        for (const method of methods) emit(method, [...parts, path], pos);
        if (opens) stack.push({ prefix: '' });
      } else if (/^root\b/.test(line)) {
        emit('GET', current(), pos);
      } else if (opens) {
        stack.push({ prefix: '' });
      }
    }
  }
  return out;
}
