// Python routes: FastAPI (APIRouter + include_router), Flask (Blueprint + register_blueprint), Django (urls.py, DRF).
import { HTTP_METHODS, type HttpMethod } from '../../shared/model';
import { joinPath } from './paths';
import { PrefixGraph } from './prefixGraph';
import { dirOf, inner, joinFile, lineIndex, namedString, splitArgs, stringList, stringValue, stripComments } from './source';
import type { Framework, ScannedRoute, SourceFile } from './types';

export const PY_FILE = /\.py$/;
const SKIP_FILE = /(?:^|\/)(?:tests?|migrations|site-packages)\/|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/;

interface PyImport {
  file: string;
  /** Imported name inside the module (`from x import router`); undefined when the module itself is imported. */
  attr?: string;
}

interface PyModule {
  file: string;
  code: string;
  line: (offset: number) => number;
  imports: Map<string, PyImport>;
  /** App / router variables defined in this file and their framework. */
  vars: Map<string, Framework>;
  framework?: Framework;
}

const toMethods = (list: string[]): HttpMethod[] =>
  list.map((m) => m.toUpperCase()).filter((m): m is HttpMethod => (HTTP_METHODS as readonly string[]).includes(m));

/** Maps dotted module paths to files: every path suffix ("users.py", "routers/users.py", …) -> shortest file. */
function moduleIndex(files: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('/');
      const cur = index.get(key);
      if (!cur || f.length < cur.length) index.set(key, f);
    }
  }
  return index;
}

function resolvePy(from: string, spec: string, files: ReadonlySet<string>, index: Map<string, string>): string | undefined {
  const dots = /^\.*/.exec(spec)![0].length;
  const rest = spec.slice(dots).replace(/\./g, '/');
  if (dots) {
    let dir = dirOf(from);
    for (let i = 1; i < dots; i++) dir = dirOf(dir);
    const base = rest ? joinFile(dir, rest) : dir;
    return [`${base}.py`, `${base}/__init__.py`].find((f) => files.has(f));
  }
  return index.get(`${rest}.py`) ?? index.get(`${rest}/__init__.py`);
}

export function scanPython(sources: readonly SourceFile[]): ScannedRoute[] {
  const pySources = sources.filter((s) => PY_FILE.test(s.path) && !SKIP_FILE.test(s.path));
  const files = new Set(pySources.map((s) => s.path));
  const index = moduleIndex(pySources.map((s) => s.path));
  const graph = new PrefixGraph(true);
  const node = PrefixGraph.node;
  const out: ScannedRoute[] = [];

  const modules = new Map<string, PyModule>();
  for (const src of pySources) {
    const code = stripComments(src.text, 'hash');
    const mod: PyModule = { file: src.path, code, line: lineIndex(code), imports: new Map(), vars: new Map() };
    if (/^[ \t]*(?:from|import)\s+fastapi\b/m.test(code)) mod.framework = 'FastAPI';
    else if (/^[ \t]*(?:from|import)\s+(?:flask|quart)\b/m.test(code)) mod.framework = 'Flask';

    for (const m of code.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
      const spec = m[1];
      for (const part of m[2].replace(/[()\\]/g, ' ').split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (!name || name === '*') continue;
        const asModule = resolvePy(src.path, spec.endsWith('.') ? spec + name : `${spec}.${name}`, files, index);
        if (asModule) {
          mod.imports.set(alias ?? name, { file: asModule });
        } else {
          const target = resolvePy(src.path, spec, files, index);
          if (target) mod.imports.set(alias ?? name, { file: target, attr: name });
        }
      }
    }
    for (const m of code.matchAll(/^[ \t]*import\s+([\w.]+)\s+as\s+(\w+)/gm)) {
      const target = resolvePy(src.path, m[1], files, index);
      if (target) mod.imports.set(m[2], { file: target });
    }
    for (const m of code.matchAll(/^[ \t]*(\w+)\s*(?::\s*[\w.[\]]+\s*)?=\s*(?:\w+\.)?(FastAPI|APIRouter|Flask|Quart|Blueprint|APIBlueprint)\s*\(/gm)) {
      const fastapi = m[2] === 'FastAPI' || m[2] === 'APIRouter';
      mod.vars.set(m[1], fastapi ? 'FastAPI' : 'Flask');
      const args = inner(code, m.index! + m[0].length - 1);
      const prefix = args ? namedString(args.body, fastapi ? 'prefix' : 'url_prefix') : undefined;
      if (prefix !== undefined) graph.setOwn(node(src.path, m[1]), prefix);
    }
    modules.set(src.path, mod);
  }

  /** Router node + framework for a receiver name used in `mod` (local var, imported var, or unknown). */
  const receiver = (mod: PyModule, recv: string): { node: string; framework?: Framework } => {
    const local = mod.vars.get(recv);
    if (local) return { node: node(mod.file, recv), framework: local };
    const imp = mod.imports.get(recv);
    if (imp?.attr) return { node: node(imp.file, imp.attr), framework: modules.get(imp.file)?.vars.get(imp.attr) };
    return { node: node(mod.file, recv) };
  };

  // Mounts: include_router / register_blueprint / mount.
  for (const mod of modules.values()) {
    for (const m of mod.code.matchAll(/\b(\w+)\s*\.\s*(include_router|register_blueprint|mount)\s*\(/g)) {
      const args = inner(mod.code, m.index! + m[0].length - 1);
      if (!args) continue;
      const spans = splitArgs(args.body);
      let target = spans[0];
      let prefix = '';
      let replaceOwn = false;
      if (m[2] === 'include_router') {
        prefix = namedString(args.body, 'prefix') ?? '';
      } else if (m[2] === 'register_blueprint') {
        const urlPrefix = namedString(args.body, 'url_prefix');
        prefix = urlPrefix ?? '';
        replaceOwn = urlPrefix !== undefined;
      } else {
        prefix = stringValue(spans[0]) ?? '';
        target = spans[1];
      }
      const t = /^(\w+)(?:\.(\w+))?$/.exec(target ?? '');
      if (!t) continue;
      const imp = mod.imports.get(t[1]);
      let child: string | undefined;
      if (t[2]) child = imp && !imp.attr ? node(imp.file, t[2]) : undefined;
      else if (imp) child = imp.attr ? node(imp.file, imp.attr) : node(imp.file);
      else child = node(mod.file, t[1]);
      if (child) graph.addEdge(child, receiver(mod, m[1]).node, prefix, replaceOwn);
    }
  }

  // FastAPI / Flask decorators.
  for (const mod of modules.values()) {
    for (const m of mod.code.matchAll(/^[ \t]*@(\w+)\s*\.\s*(get|post|put|patch|delete|head|options|route|api_route)\s*\(/gm)) {
      const args = inner(mod.code, m.index! + m[0].length - 1);
      if (!args) continue;
      const r = receiver(mod, m[1]);
      const framework = r.framework ?? mod.framework;
      if (!framework) continue;
      const first = splitArgs(args.body)[0];
      const path = (first && !/^\w+\s*=/.test(first) ? stringValue(first) : undefined) ?? namedString(args.body, 'path') ?? namedString(args.body, 'rule');
      if (path === undefined || (path !== '' && !path.startsWith('/'))) continue;
      let methods: HttpMethod[];
      if (m[2] === 'route' || m[2] === 'api_route') {
        const kw = /\bmethods\s*=\s*([[(][^\])]*[\])])/.exec(args.body);
        methods = kw ? toMethods(stringList(kw[1])) : ['GET'];
      } else {
        methods = [m[2].toUpperCase() as HttpMethod];
      }
      const line = mod.line(m.index! + m[0].indexOf('@'));
      for (const prefix of graph.prefixes(r.node)) {
        for (const method of methods) out.push({ method, path: joinPath([prefix, path], true), framework, file: mod.file, line });
      }
    }
  }

  scanDjango([...modules.values()], graph, files, index, out);
  return out;
}

// ---------- Django ----------

interface DjangoView {
  methods?: HttpMethod[];
  list?: HttpMethod[];
  detail?: HttpMethod[];
}

const GENERIC_VIEWS: [RegExp, HttpMethod[]][] = [
  [/\bListCreateAPIView\b/, ['GET', 'POST']],
  [/\bRetrieveUpdateDestroyAPIView\b/, ['GET', 'PUT', 'PATCH', 'DELETE']],
  [/\bRetrieveUpdateAPIView\b/, ['GET', 'PUT', 'PATCH']],
  [/\bRetrieveDestroyAPIView\b/, ['GET', 'DELETE']],
  [/\bListAPIView\b/, ['GET']],
  [/\bCreateAPIView\b/, ['POST']],
  [/\bRetrieveAPIView\b/, ['GET']],
  [/\bUpdateAPIView\b/, ['PUT', 'PATCH']],
  [/\bDestroyAPIView\b/, ['DELETE']],
];

const VIEWSET_ACTIONS: Record<string, { kind: 'list' | 'detail'; method: HttpMethod }> = {
  list: { kind: 'list', method: 'GET' },
  create: { kind: 'list', method: 'POST' },
  retrieve: { kind: 'detail', method: 'GET' },
  update: { kind: 'detail', method: 'PUT' },
  partial_update: { kind: 'detail', method: 'PATCH' },
  destroy: { kind: 'detail', method: 'DELETE' },
};

function djangoViews(modules: PyModule[]): Map<string, DjangoView> {
  const views = new Map<string, DjangoView>();
  for (const { code } of modules) {
    for (const m of code.matchAll(/@(?:api_view|require_http_methods)\s*\(\s*\[([^\]]*)\]\s*\)[\s\S]{0,300}?\bdef\s+(\w+)/g)) {
      views.set(m[2], { methods: toMethods(stringList(m[1])) });
    }
    for (const m of code.matchAll(/@require_(GET|POST|safe)\b[\s\S]{0,300}?\bdef\s+(\w+)/g)) {
      views.set(m[2], { methods: [m[1] === 'POST' ? 'POST' : 'GET'] });
    }
    for (const m of code.matchAll(/^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm)) {
      const bodyStart = m.index! + m[0].length;
      const next = /^\S/m.exec(code.slice(bodyStart));
      const body = code.slice(bodyStart, next ? bodyStart + next.index : code.length);
      const bases = m[2];
      const defs = [...body.matchAll(/^\s+def\s+(\w+)\s*\(\s*self/gm)].map((d) => d[1]);
      if (/\bReadOnlyModelViewSet\b/.test(bases)) {
        views.set(m[1], { list: ['GET'], detail: ['GET'] });
      } else if (/\bModelViewSet\b/.test(bases)) {
        views.set(m[1], { list: ['GET', 'POST'], detail: ['GET', 'PUT', 'PATCH', 'DELETE'] });
      } else if (/ViewSet\b/.test(bases)) {
        const view: DjangoView = { list: [], detail: [] };
        for (const d of defs) {
          const action = VIEWSET_ACTIONS[d];
          if (action) view[action.kind]!.push(action.method);
        }
        views.set(m[1], view);
      } else {
        const generic = GENERIC_VIEWS.find(([re]) => re.test(bases))?.[1];
        const own = toMethods(defs.filter((d) => /^(?:get|post|put|patch|delete|head|options)$/.test(d)));
        views.set(m[1], { methods: own.length ? own : generic });
      }
    }
  }
  return views;
}

function scanDjango(modules: PyModule[], graph: PrefixGraph, files: ReadonlySet<string>, index: Map<string, string>, out: ScannedRoute[]): void {
  const urlModules = modules.filter((m) => /(?:^|\/)urls\.py$/.test(m.file) || /\burlpatterns\b/.test(m.code));
  if (!urlModules.length) return;
  const views = djangoViews(modules);
  const node = PrefixGraph.node;

  const toPath = (route: string, regex: boolean) =>
    regex
      ? route
          .replace(/^\^/, '')
          .replace(/\$$/, '')
          .replace(/\(\?P<(\w+)>[^)]*\)/g, '<$1>')
          .replace(/\\\//g, '/')
      : route;

  const pending: { mod: PyModule; route: string; methods: HttpMethod[]; pos: number }[] = [];
  for (const mod of urlModules) {
    for (const m of mod.code.matchAll(/\b(path|re_path|url)\s*\(/g)) {
      if (mod.code[m.index! - 1] === '.') continue;
      const args = inner(mod.code, m.index! + m[0].length - 1);
      if (!args) continue;
      const spans = splitArgs(args.body);
      const raw = stringValue(spans[0]);
      if (raw === undefined || spans.length < 2) continue;
      const route = toPath(raw, m[1] !== 'path');
      const view = spans[1];
      const inc = /^include\s*\(/.exec(view);
      if (inc) {
        const incArgs = inner(view, inc[0].length - 1);
        const first = incArgs ? splitArgs(incArgs.body)[0] : undefined;
        const spec = stringValue(first);
        let child: string | undefined;
        if (spec) {
          const target = resolvePy(mod.file, spec, files, index);
          if (target) child = node(target);
        } else {
          const ref = /^(\w+)(?:\.urls)?$/.exec(first ?? '');
          const imp = ref ? mod.imports.get(ref[1]) : undefined;
          if (imp && !imp.attr) child = node(imp.file);
          else if (ref) child = node(mod.file, ref[1]);
        }
        if (child) graph.addEdge(child, node(mod.file), route);
        continue;
      }
      if (/\.urls\s*$/.test(view)) continue; // admin.site.urls and similar pre-built URL sets
      const name = /(\w+)\s*\.\s*as_view\b/.exec(view)?.[1] ?? /(\w+)\s*$/.exec(view)?.[1];
      const info = name ? views.get(name) : undefined;
      pending.push({ mod, route, methods: info?.methods?.length ? info.methods : ['GET'], pos: m.index! });
    }
  }
  // Routes are emitted after every include is known, since includes can appear after the paths they prefix.
  for (const { mod, route, methods, pos } of pending) {
    for (const prefix of graph.prefixes(node(mod.file))) {
      for (const method of methods) out.push({ method, path: joinPath([prefix, route], true), framework: 'Django', file: mod.file, line: mod.line(pos) });
    }
  }

  // DRF routers: router.register(r'users', UserViewSet)
  for (const mod of modules) {
    for (const m of mod.code.matchAll(/\b(\w+)\s*\.\s*register\s*\(\s*r?(['"])(.*?)\2\s*,\s*([\w.]+)/g)) {
      const viewset = views.get(m[4].split('.').pop()!);
      if (!viewset?.list && !viewset?.detail && !/ViewSet/.test(m[4])) continue;
      const list = viewset?.list ?? ['GET', 'POST'];
      const detail = viewset?.detail ?? ['GET', 'PUT', 'PATCH', 'DELETE'];
      const line = mod.line(m.index!);
      for (const prefix of graph.prefixes(node(mod.file, m[1]))) {
        for (const method of list) out.push({ method, path: joinPath([prefix, `${m[3]}/`], true), framework: 'Django', file: mod.file, line });
        for (const method of detail) out.push({ method, path: joinPath([prefix, m[3], ':pk/'], true), framework: 'Django', file: mod.file, line });
      }
    }
  }
}
