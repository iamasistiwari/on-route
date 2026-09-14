// PHP routes: Laravel routes/*.php (Route::get, prefix groups, apiResource / resource).
import { HTTP_METHODS, type HttpMethod } from '../../shared/model';
import { joinPath, singular } from './paths';
import { inner, lineIndex, splitArgs, stringList, stringValue, stripComments } from './source';
import type { ScannedRoute, SourceFile } from './types';

export const LARAVEL_ROUTES = /(?:^|\/)routes\/[\w.-]+\.php$/;

interface Group {
  start: number;
  end: number;
  prefix: string;
}

const RESOURCE_ACTIONS: { action: string; method: HttpMethod; member: boolean; suffix?: string; api: boolean }[] = [
  { action: 'index', method: 'GET', member: false, api: true },
  { action: 'create', method: 'GET', member: false, suffix: 'create', api: false },
  { action: 'store', method: 'POST', member: false, api: true },
  { action: 'show', method: 'GET', member: true, api: true },
  { action: 'edit', method: 'GET', member: true, suffix: 'edit', api: false },
  { action: 'update', method: 'PUT', member: true, api: true },
  { action: 'destroy', method: 'DELETE', member: true, api: true },
];

export function scanPhp(sources: readonly SourceFile[]): ScannedRoute[] {
  const out: ScannedRoute[] = [];
  for (const src of sources) {
    if (!LARAVEL_ROUTES.test(src.path) || !/\bRoute::/.test(src.text)) continue;
    const code = stripComments(src.text, 'php');
    const line = lineIndex(code);
    const base = /(?:^|\/)api\.php$/.test(src.path) ? 'api' : '';

    // Groups: Route::prefix('v1')->middleware(...)->group(function () { ... }) / Route::group(['prefix' => 'v1'], function () { ... })
    const groups: Group[] = [];
    for (const m of code.matchAll(/\bgroup\s*\(/g)) {
      const args = inner(code, m.index! + m[0].length - 1);
      if (!args) continue;
      const fn = /function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{/.exec(args.body);
      if (!fn) continue;
      const bodyStart = m.index! + m[0].length + fn.index + fn[0].length - 1;
      const body = inner(code, bodyStart);
      if (!body) continue;
      const stmtStart = code.lastIndexOf('Route::', m.index!);
      const stmt = stmtStart >= 0 ? code.slice(stmtStart, m.index!) : '';
      const prefix =
        /\bprefix\s*\(\s*(['"])(.*?)\1\s*\)/.exec(stmt)?.[2] ?? /['"]prefix['"]\s*=>\s*(['"])(.*?)\1/.exec(args.body.slice(0, fn.index))?.[2] ?? '';
      groups.push({ start: bodyStart, end: body.end, prefix });
    }
    const prefixAt = (pos: number) => [base, ...groups.filter((g) => g.start < pos && pos < g.end).sort((a, b) => a.start - b.start).map((g) => g.prefix)];

    for (const m of code.matchAll(/\bRoute::(get|post|put|patch|delete|options|any|match)\s*\(/g)) {
      const args = inner(code, m.index! + m[0].length - 1);
      if (!args) continue;
      const spans = splitArgs(args.body);
      let methods: HttpMethod[];
      let path: string | undefined;
      if (m[1] === 'match') {
        methods = stringList(spans[0] ?? '')
          .map((x) => x.toUpperCase())
          .filter((x): x is HttpMethod => (HTTP_METHODS as readonly string[]).includes(x));
        path = stringValue(spans[1]);
      } else {
        methods = [m[1] === 'any' ? 'GET' : (m[1].toUpperCase() as HttpMethod)];
        path = stringValue(spans[0]);
      }
      if (path === undefined) continue;
      for (const method of methods) {
        out.push({ method, path: joinPath([...prefixAt(m.index!), path]), framework: 'Laravel', file: src.path, line: line(m.index!) });
      }
    }

    for (const m of code.matchAll(/\bRoute::(apiResource|resource)\s*\(/g)) {
      const args = inner(code, m.index! + m[0].length - 1);
      const name = args ? stringValue(splitArgs(args.body)[0]) : undefined;
      if (!args || !name) continue;
      const stmtEnd = code.indexOf(';', args.end);
      const chain = code.slice(args.end, stmtEnd < 0 ? undefined : stmtEnd);
      const only = /->only\s*\(([^)]*)\)/.exec(chain);
      const except = /->except\s*\(([^)]*)\)/.exec(chain);
      const parts = name.split('.');
      const last = parts.pop()!;
      const nested = parts.map((p) => `${p}/{${singular(p)}}`);
      const collection = joinPath([...prefixAt(m.index!), ...nested, last]);
      const member = joinPath([collection, `{${singular(last).replace(/-/g, '_')}}`]);
      for (const a of RESOURCE_ACTIONS) {
        if (m[1] === 'apiResource' && !a.api) continue;
        if (only && !stringList(only[1]).includes(a.action)) continue;
        if (except && stringList(except[1]).includes(a.action)) continue;
        out.push({
          method: a.method,
          path: joinPath([a.member ? member : collection, a.suffix]),
          framework: 'Laravel',
          file: src.path,
          line: line(m.index!),
        });
      }
    }
  }
  return out;
}
