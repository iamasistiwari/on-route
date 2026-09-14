// JavaScript / TypeScript routes: Express-style routers (Express, Fastify, Hono, Koa, Elysia), NestJS, Next.js.
import type { HttpMethod } from '../../shared/model';
import { joinPath } from './paths';
import { PrefixGraph } from './prefixGraph';
import { dirOf, inner, joinFile, lineIndex, namedString, splitArgs, stringList, stringValue, stripComments } from './source';
import type { Framework, ProjectHints, ScannedRoute, SourceFile } from './types';

export const JS_FILE = /\.[cm]?[jt]sx?$/;
const SKIP_FILE = /(?:^|\/)(?:__tests__|__mocks__|e2e|cypress)\/|\.(?:test|spec|stories|d)\.[cm]?[jt]sx?$|\.min\.js$/;
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

const VERBS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  del: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
  all: 'GET',
};
const toMethod = (s: string): HttpMethod | undefined => VERBS[s.toLowerCase()];

const SERVER_LIBS: [RegExp, Framework][] = [
  [/^(?:express|polka|restify)$/, 'Express'],
  [/^fastify$/, 'Fastify'],
  [/^hono(?:\/|$)|^@hono\//, 'Hono'],
  [/^(?:koa|@koa\/router|koa-router)$/, 'Koa'],
  [/^elysia$/, 'Elysia'],
];
const CLIENT_LIBS = /^(?:axios|ky|got|superagent|node-fetch|supertest|ofetch|redaxios|swr|@angular\/common\/http|@tanstack\/[\w-]+)$/;

const ID = '[A-Za-z_$][\\w$]*';
const STR = `(['"\`])((?:\\\\.|(?!\\X)[^\\\\\\n])*)\\X`;
const str = (group: number) => STR.replace(/X/g, String(group));

const ROUTER_INIT = new RegExp(
  `(?:const|let|var)\\s+(${ID})\\s*(?::\\s*[\\w$.<>, |]+?)?\\s*=\\s*(?:await\\s+)?(?:new\\s+(?:Hono|OpenAPIHono|Router|KoaRouter|Koa|Elysia)\\b\\s*(?:<[^>()]*>)?\\s*\\(|(?:express\\s*\\.\\s*)?Router\\s*\\(|express\\s*\\(|[Ff]astify\\s*\\(|polka\\s*\\(|restify\\s*\\.\\s*createServer\\s*\\()`,
  'g',
);
const TYPED_ROUTER = new RegExp(
  `\\b(${ID})\\s*\\??\\s*:\\s*(?:express\\s*\\.\\s*)?(?:Express|Application|Router|IRouter|FastifyInstance|Hono|OpenAPIHono|Elysia|KoaRouter)\\b`,
  'g',
);
const ROUTE_CALL = new RegExp(`\\b(${ID})\\s*\\.\\s*(get|post|put|patch|delete|del|head|options|all)\\s*\\(\\s*${str(3)}\\s*,`, 'g');
const CHAIN_CALL = new RegExp(`^[ \\t]*\\.\\s*(get|post|put|patch|delete|head|options|all)\\s*\\(\\s*${str(2)}\\s*,`, 'gm');
const ROUTE_ROUTE = new RegExp(`\\b(${ID})\\s*\\.\\s*route\\s*\\(\\s*${str(2)}\\s*\\)`, 'g');
const ROUTE_OBJECT = new RegExp(`\\b(${ID})\\s*\\.\\s*route\\s*\\(\\s*\\{`, 'g');
const HONO_ON = new RegExp(`\\b(${ID})\\s*\\.\\s*on\\s*\\(`, 'g');
const MOUNT_CALL = new RegExp(`\\b(${ID})\\s*\\.\\s*(use|route|register|mount|group)\\s*\\(`, 'g');
const FN_ARG = new RegExp(`^(?:async\\s+)?(?:function\\s*[\\w$]*\\s*\\(\\s*(${ID})|\\(\\s*(${ID})[^)]*\\)\\s*(?::[^=]*)?=>|(${ID})\\s*=>)`);

const STRICT_RECEIVER = /^(?:app|router|server|fastify|[a-z]\w*Router)$/;
const LOOSE_RECEIVER = /^(?:app|api|router|server|route|routes|fastify|instance|[a-z]\w*(?:Router|Routes|App|Api))$/;

interface Scope {
  start: number;
  end: number;
  param: string;
}

interface JsModule {
  file: string;
  code: string;
  line: (offset: number) => number;
  imports: Map<string, string>;
  framework?: Framework;
  isClient: boolean;
  routers: Set<string>;
  scopes: Scope[];
}

interface Span {
  text: string;
  start: number;
}

/** Top-level arguments of the call whose "(" is at `open`, with absolute offsets. */
function argSpans(code: string, open: number): { spans: Span[]; end: number; body: string } | undefined {
  const a = inner(code, open);
  if (!a) return undefined;
  const spans: Span[] = [];
  let from = 0;
  for (const text of splitArgs(a.body)) {
    const idx = a.body.indexOf(text, from);
    spans.push({ text, start: open + 1 + Math.max(idx, 0) });
    from = Math.max(idx, 0) + text.length;
  }
  return { spans, end: a.end, body: a.body };
}

function resolveModule(from: string, spec: string, files: ReadonlySet<string>): string | undefined {
  let base: string;
  if (spec.startsWith('.')) {
    base = joinFile(dirOf(from), spec);
  } else if (/^[@~]\//.test(spec)) {
    const i = from.lastIndexOf('src/');
    base = (i >= 0 ? from.slice(0, i + 4) : 'src/') + spec.slice(2);
  } else {
    return undefined;
  }
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  return [base, ...EXTS.map((e) => stem + e), ...EXTS.map((e) => `${stem}/index${e}`)].find((c) => files.has(c));
}

function parseImports(file: string, code: string, files: ReadonlySet<string>): { imports: Map<string, string>; specs: string[] } {
  const imports = new Map<string, string>();
  const specs: string[] = [];
  const add = (names: string[], spec: string) => {
    specs.push(spec);
    const target = resolveModule(file, spec, files);
    if (target) for (const n of names) imports.set(n, target);
  };
  const bindings = (clause: string): string[] =>
    clause
      .split(',')
      .map((p) => p.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
      .map((p) => p.split(/\s+as\s+|\s*:\s*/).pop()!.trim());

  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    const names: string[] = [];
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause);
    if (def) names.push(def[1]);
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) names.push(ns[1]);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) names.push(...bindings(braces[1]));
    add(names, m[2]);
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\})\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    add(m[1].startsWith('{') ? bindings(m[1].slice(1, -1)) : [m[1]], m[2]);
  }
  for (const m of code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return { imports, specs };
}

/**
 * Receiver of a chained call (`app\n  .get(...)\n  .post(...)`): the head identifier of the statement.
 * Bracketed content is dropped so handler bodies between the calls don't hide the head.
 */
function chainHead(code: string, pos: number): string | undefined {
  let depth = 0;
  let i = pos - 1;
  for (; i >= 0; i--) {
    const c = code[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) break;
      depth--;
    } else if (c === ';' && depth === 0) break;
  }
  let flat = '';
  depth = 0;
  for (const c of code.slice(i + 1, pos)) {
    if (c === '(' || c === '[' || c === '{') depth++;
    if (depth === 0) flat += c;
    if (c === ')' || c === ']' || c === '}') depth--;
  }
  const lines = flat.split('\n').map((l) => l.trim());
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (!l || l.startsWith('.') || /^[)\]}]/.test(l)) continue;
    const m = /^(?:export\s+default\s+)?(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*)?(?:await\s+)?(?:new\s+[\w$]+|([A-Za-z_$][\w$]*))/.exec(l);
    return m?.[1] ?? m?.[2];
  }
  return undefined;
}

function projectFramework(hints: ProjectHints): Framework | undefined {
  for (const dep of hints.npmDependencies) for (const [re, fw] of SERVER_LIBS) if (re.test(dep)) return fw;
  return undefined;
}

export function scanJavaScript(sources: readonly SourceFile[], hints: ProjectHints): ScannedRoute[] {
  const files = new Set(sources.map((s) => s.path));
  const out: ScannedRoute[] = [];
  const graph = new PrefixGraph();
  const node = PrefixGraph.node;
  const defaultFramework = projectFramework(hints);
  const hasServerLib = defaultFramework !== undefined;
  const hasNext = hints.npmDependencies.has('next');

  const modules: JsModule[] = [];
  let nestPrefix = '';
  for (const src of sources) {
    if (!JS_FILE.test(src.path) || SKIP_FILE.test(src.path)) continue;
    const code = stripComments(src.text, 'c');
    const { imports, specs } = parseImports(src.path, code, files);
    const framework = specs.map((s) => SERVER_LIBS.find(([re]) => re.test(s))?.[1]).find(Boolean);
    const mod: JsModule = {
      file: src.path,
      code,
      line: lineIndex(code),
      imports,
      framework,
      isClient: !framework && specs.some((s) => CLIENT_LIBS.test(s)),
      routers: new Set(),
      scopes: [],
    };
    for (const m of code.matchAll(ROUTER_INIT)) {
      mod.routers.add(m[1]);
      const call = argSpans(code, m.index! + m[0].length - 1);
      const prefix = call ? namedString(call.body, 'prefix') : undefined;
      const basePath = call ? new RegExp(`^\\s*\\.\\s*basePath\\s*\\(\\s*${str(1)}`).exec(code.slice(call.end + 1, call.end + 200))?.[2] : undefined;
      if (prefix !== undefined || basePath !== undefined) graph.setOwn(node(src.path, m[1]), joinPath([prefix, basePath]));
    }
    for (const m of code.matchAll(TYPED_ROUTER)) mod.routers.add(m[1]);
    nestPrefix = new RegExp(`\\.setGlobalPrefix\\(\\s*${str(1)}`).exec(code)?.[2] ?? nestPrefix;
    modules.push(mod);
  }

  const nodeAt = (mod: JsModule, recv: string, pos: number): string => {
    let best: Scope | undefined;
    for (const s of mod.scopes) if (s.param === recv && s.start <= pos && pos <= s.end && (!best || s.start > best.start)) best = s;
    return best ? node(mod.file, recv, best.start) : node(mod.file, recv);
  };
  const inScope = (mod: JsModule, recv: string) => mod.scopes.some((s) => s.param === recv);

  // Pass 1: mounts (app.use('/api', router), app.route('/x', sub), fastify.register(plugin, { prefix })).
  const mounted = new Set<string>();
  for (const mod of modules) {
    const { code, file } = mod;
    for (const m of code.matchAll(MOUNT_CALL)) {
      const recv = m[1];
      const kind = m[2];
      if (mod.isClient || !(mod.routers.has(recv) || LOOSE_RECEIVER.test(recv) || inScope(mod, recv))) continue;
      const call = argSpans(code, m.index! + m[0].length - 1);
      if (!call?.spans.length) continue;
      let prefix = '';
      let targets = call.spans;
      if (kind === 'register') {
        prefix = namedString(call.spans[1]?.text ?? '', 'prefix') ?? '';
        targets = call.spans.slice(0, 1);
      } else {
        const p = stringValue(call.spans[0].text);
        if (p !== undefined) {
          prefix = p;
          targets = call.spans.slice(1);
        } else if (kind === 'route' || kind === 'group') {
          continue;
        }
      }
      const parent = nodeAt(mod, recv, m.index!);
      for (const t of targets) {
        let mm: RegExpExecArray | null;
        if ((mm = /^(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(t.text))) {
          const target = resolveModule(file, mm[1], files);
          if (target) {
            graph.addEdge(node(target), parent, prefix);
            mounted.add(target);
          }
        } else if ((mm = FN_ARG.exec(t.text))) {
          const param = mm[1] ?? mm[2] ?? mm[3];
          mod.scopes.push({ start: t.start, end: t.start + t.text.length, param });
          graph.addEdge(node(file, param, t.start), parent, prefix);
        } else if ((mm = /^(?:await\s+)?([A-Za-z_$][\w$]*)(?:\s*\.\s*[\w$]+)*(?:\s*\([^()]*\))?$/.exec(t.text))) {
          const id = mm[1];
          const factory = new RegExp(`(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*=\\s*(?:await\\s+)?(${ID})\\s*\\(`).exec(code);
          const target = mod.imports.get(id) ?? (factory ? mod.imports.get(factory[1]) : undefined);
          if (target) {
            graph.addEdge(node(target), parent, prefix);
            mounted.add(target);
          } else {
            graph.addEdge(node(file, id), parent, prefix);
          }
        }
      }
    }
  }

  // Pass 2: routes.
  for (const mod of modules) {
    const { code, file } = mod;
    const framework = mod.framework ?? defaultFramework ?? 'Express';
    const accepts = (recv: string) =>
      mod.routers.has(recv) ||
      (!mod.isClient && inScope(mod, recv)) ||
      (!mod.isClient && (mod.framework !== undefined || mounted.has(file)) && LOOSE_RECEIVER.test(recv)) ||
      (!mod.isClient && hasServerLib && STRICT_RECEIVER.test(recv));
    const emit = (recv: string, method: HttpMethod, path: string, pos: number) => {
      if (!accepts(recv)) return;
      if (path === '' ? !(mod.routers.has(recv) || inScope(mod, recv)) : !path.startsWith('/')) return;
      if (/^\/?\*$/.test(path)) return;
      for (const p of graph.prefixes(nodeAt(mod, recv, pos))) {
        out.push({ method, path: joinPath([p, path]), framework, file, line: mod.line(pos) });
      }
    };

    if (/@Controller\s*\(/.test(code)) {
      scanNest(mod, nestPrefix, out);
      continue;
    }
    if (hasNext) scanNext(mod, out);

    for (const m of code.matchAll(ROUTE_CALL)) emit(m[1], toMethod(m[2])!, m[4], m.index!);
    for (const m of code.matchAll(CHAIN_CALL)) {
      const head = chainHead(code, m.index!);
      if (head) emit(head, toMethod(m[1])!, m[3], m.index!);
    }
    for (const m of code.matchAll(ROUTE_ROUTE)) {
      // router.route('/x').get(h).post(h)
      let k = m.index! + m[0].length;
      for (;;) {
        const c = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(k, k + 200));
        if (!c) break;
        const call = inner(code, k + c[0].length - 1);
        if (!call) break;
        const method = toMethod(c[1]);
        if (method) emit(m[1], method, m[3], m.index!);
        k = call.end + 1;
      }
    }
    for (const m of code.matchAll(ROUTE_OBJECT)) {
      // fastify.route({ method: ['GET', 'POST'], url: '/x' })
      const obj = inner(code, m.index! + m[0].length - 1);
      if (!obj) continue;
      const methods = /\bmethod\s*:\s*(\[[^\]]*\]|(['"`])\w+\2)/.exec(obj.body);
      const url = namedString(obj.body, 'url') ?? namedString(obj.body, 'path');
      if (!methods || url === undefined) continue;
      for (const verb of stringList(methods[1])) {
        const method = toMethod(verb);
        if (method) emit(m[1], method, url, m.index!);
      }
    }
    if (mod.framework === 'Hono') {
      for (const m of code.matchAll(HONO_ON)) {
        const call = argSpans(code, m.index! + m[0].length - 1);
        if (!call || call.spans.length < 2) continue;
        const paths = call.spans[1].text.startsWith('[') ? stringList(call.spans[1].text) : [stringValue(call.spans[1].text)];
        for (const verb of stringList(call.spans[0].text)) {
          const method = toMethod(verb);
          for (const p of paths) if (method && p !== undefined) emit(m[1], method, p, m.index!);
        }
      }
    }
  }
  return out;
}

function scanNest(mod: JsModule, globalPrefix: string, out: ScannedRoute[]): void {
  const { code, file } = mod;
  const controllers = [...code.matchAll(/@Controller\s*\(/g)];
  controllers.forEach((c, i) => {
    const args = inner(code, c.index! + c[0].length - 1);
    if (!args) return;
    const arg = args.body.trim();
    const prefix = stringValue(arg) ?? (arg.startsWith('[') ? stringList(arg)[0] : namedString(arg, 'path')) ?? '';
    const end = i + 1 < controllers.length ? controllers[i + 1].index! : code.length;
    const re = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(/g;
    re.lastIndex = args.end;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) && m.index < end) {
      const call = inner(code, m.index + m[0].length - 1);
      if (!call) continue;
      const t = call.body.trim();
      const paths = t.startsWith('[') ? stringList(t) : [t === '' ? '' : (stringValue(t) ?? namedString(t, 'path'))];
      for (const p of paths) {
        if (p === undefined) continue;
        out.push({ method: toMethod(m[1])!, path: joinPath([globalPrefix, prefix, p]), framework: 'NestJS', file, line: mod.line(m.index) });
      }
    }
  });
}

const NEXT_METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

function scanNext(mod: JsModule, out: ScannedRoute[]): void {
  const { code, file } = mod;
  const app = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/.exec(file);
  if (app) {
    const segs = app[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@') && !s.startsWith('_'));
    const found = new Map<string, number>();
    for (const m of code.matchAll(new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function\\s+|(?:const|let|var)\\s+)(${NEXT_METHODS})\\b`, 'g'))) {
      if (!found.has(m[1])) found.set(m[1], m.index!);
    }
    for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
      for (const name of m[1].split(',').map((p) => p.trim().split(/\s+as\s+/).pop()!)) {
        if (new RegExp(`^(?:${NEXT_METHODS})$`).test(name) && !found.has(name)) found.set(name, m.index!);
      }
    }
    for (const [verb, pos] of found) {
      out.push({ method: verb as HttpMethod, path: joinPath(segs), framework: 'Next.js', file, line: mod.line(pos) });
    }
    return;
  }
  const pages = /(?:^|\/)pages\/(api\/.+)\.[cm]?[jt]sx?$/.exec(file);
  if (pages) {
    const path = joinPath([pages[1].replace(/(?:^|\/)index$/, '')]);
    const methods = new Set<string>();
    for (const m of code.matchAll(new RegExp(`\\bmethod\\s*(?:===?|!==?)\\s*['"\`](${NEXT_METHODS})['"\`]|\\bcase\\s+['"\`](${NEXT_METHODS})['"\`]`, 'g'))) {
      methods.add(m[1] ?? m[2]);
    }
    if (!methods.size) methods.add('GET');
    for (const verb of methods) out.push({ method: verb as HttpMethod, path, framework: 'Next.js', file, line: 1 });
  }
}
