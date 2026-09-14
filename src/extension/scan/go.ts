// Go routes: Gin, Echo, Fiber, Chi, gorilla/mux and net/http, with route groups across functions and files.
import { HTTP_METHODS, type HttpMethod } from '../../shared/model';
import { joinPath } from './paths';
import { PrefixGraph } from './prefixGraph';
import { dirOf, inner, lineIndex, splitArgs, stringList, stripComments } from './source';
import type { Framework, ScannedRoute, SourceFile } from './types';

export const GO_FILE = /\.go$/;
const SKIP_FILE = /_test\.go$|(?:^|\/)vendor\//;

const GO_LIBS: [RegExp, Framework][] = [
  [/github\.com\/gin-gonic\/gin\b/, 'Gin'],
  [/github\.com\/labstack\/echo\b/, 'Echo'],
  [/github\.com\/gofiber\/fiber\b/, 'Fiber'],
  [/github\.com\/go-chi\/chi\b/, 'Chi'],
  [/github\.com\/gorilla\/mux\b/, 'Gorilla Mux'],
];

const ROUTER_TYPE = /^\*?(?:gin\.(?:RouterGroup|Engine|IRouter|IRoutes)|echo\.(?:Echo|Group)|fiber\.(?:Router|App)|chi\.(?:Router|Mux)|mux\.Router|http\.ServeMux)$/;

interface GoParam {
  name: string;
  index: number;
  router: boolean;
}

interface GoScope {
  /** Offset of the `func` keyword. */
  funcPos: number;
  start: number;
  end: number;
  params: GoParam[];
  name?: string;
  recvType?: string;
  file: string;
}

interface GoModule {
  file: string;
  code: string;
  line: (offset: number) => number;
  frameworks: Set<Framework>;
  imports: Map<string, string>;
  scopes: GoScope[];
  groups: { name: string; pos: number }[];
}

const toMethod = (s: string): HttpMethod | undefined => {
  const up = s.toUpperCase();
  if (up === 'ANY' || up === 'ALL') return 'GET';
  return (HTTP_METHODS as readonly string[]).includes(up) ? (up as HttpMethod) : undefined;
};

function parseImports(code: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const m of code.matchAll(/\bimport\s*(?:\(([\s\S]*?)\)|((?:[\w.]+\s+)?"[^"]+"))/g)) {
    for (const spec of (m[1] ?? m[2]).matchAll(/(?:([\w.]+)\s+)?"([^"]+)"/g)) {
      const parts = spec[2].split('/');
      const last = /^v\d+$/.test(parts[parts.length - 1]) && parts.length > 1 ? parts[parts.length - 2] : parts[parts.length - 1];
      imports.set(spec[1] ?? last.replace(/^go-/, ''), spec[2]);
    }
  }
  return imports;
}

function parseScopes(file: string, code: string): GoScope[] {
  const scopes: GoScope[] = [];
  for (const m of code.matchAll(/\bfunc\s*(?:\(\s*(?:\w+\s+)?\*?\s*([\w.]+)(?:\[[^\]]*\])?\s*\)\s*)?(\w+)?\s*(?:\[[^\]]*\]\s*)?\(/g)) {
    const params = inner(code, m.index! + m[0].length - 1);
    if (!params) continue;
    // The body brace sits on the same line, after an optional result type.
    let j = params.end + 1;
    let start = -1;
    while (j < code.length) {
      const c = code[j];
      if (c === '{') {
        start = j;
        break;
      }
      if (c === '(') {
        const close = inner(code, j);
        if (!close) break;
        j = close.end + 1;
        continue;
      }
      if (c === '\n' || c === ')' || c === ',' || c === ';' || c === '}') break;
      j++;
    }
    if (start < 0) continue;
    const end = inner(code, start)?.end ?? code.length;
    const parts = splitArgs(params.body);
    const parsed: GoParam[] = [];
    let type = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      const typed = /^(\w+)\s+(.+)$/.exec(parts[i]);
      if (typed) type = typed[2].trim();
      const name = typed ? typed[1] : /^\w+$/.test(parts[i]) ? parts[i] : undefined;
      if (name) parsed.unshift({ name, index: i, router: ROUTER_TYPE.test(type.replace(/\s+/g, '')) });
    }
    scopes.push({ funcPos: m.index!, start, end, params: parsed, name: m[2], recvType: m[1]?.split('.').pop(), file });
  }
  return scopes;
}

export function scanGo(sources: readonly SourceFile[]): ScannedRoute[] {
  const graph = new PrefixGraph();
  const node = PrefixGraph.node;
  const out: ScannedRoute[] = [];

  const modules: GoModule[] = [];
  for (const src of sources) {
    if (!GO_FILE.test(src.path) || SKIP_FILE.test(src.path)) continue;
    const code = stripComments(src.text, 'c');
    const imports = parseImports(code);
    const frameworks = new Set<Framework>();
    for (const path of imports.values()) for (const [re, fw] of GO_LIBS) if (re.test(path)) frameworks.add(fw);
    const hasHttp = [...imports.values()].includes('net/http');
    if (!frameworks.size && !hasHttp) continue;
    if (hasHttp) frameworks.add('net/http');
    modules.push({ file: src.path, code, line: lineIndex(code), frameworks, imports, scopes: parseScopes(src.path, code), groups: [] });
  }

  const enclosingFunc = (mod: GoModule, pos: number) => {
    let best: GoScope | undefined;
    for (const s of mod.scopes) if (s.name && s.start <= pos && pos <= s.end && (!best || s.start > best.start)) best = s;
    return best;
  };

  /** Router node a variable refers to at `pos`: a group assigned earlier in the same function, a closure / function param, or the root. */
  const nodeAt = (mod: GoModule, name: string, pos: number): string => {
    let param: GoScope | undefined;
    for (const s of mod.scopes) {
      if (s.start <= pos && pos <= s.end && s.params.some((p) => p.name === name) && (!param || s.start > param.start)) param = s;
    }
    const fn = enclosingFunc(mod, pos);
    let group: { pos: number } | undefined;
    for (const g of mod.groups) {
      if (g.name !== name || g.pos >= pos) continue;
      if (param && g.pos < param.start) continue;
      if (fn && (g.pos < fn.start || g.pos > fn.end)) continue;
      if (!group || g.pos > group.pos) group = g;
    }
    if (group) return node(mod.file, name, group.pos + 1);
    if (param) return node(mod.file, name, param.start);
    return node(mod.file, name);
  };

  // Groups: api := r.Group("/api"), s := r.PathPrefix("/api").Subrouter()
  for (const mod of modules) {
    for (const m of mod.code.matchAll(/\b(\w+)\s*:?=\s*(\w+)\s*\.\s*(?:Group|PathPrefix)\s*\(\s*"([^"]*)"/g)) {
      mod.groups.push({ name: m[1], pos: m.index! });
    }
    for (const m of mod.code.matchAll(/\b(\w+)\s*:?=\s*(\w+)\s*\.\s*(?:Group|PathPrefix)\s*\(\s*"([^"]*)"/g)) {
      graph.addEdge(node(mod.file, m[1], m.index! + 1), nodeAt(mod, m[2], m.index!), m[3]);
    }
    // Closures: r.Route("/users", func(r chi.Router) { ... }), r.Group(func(r chi.Router) { ... })
    for (const m of mod.code.matchAll(/\b(\w+)\s*\.\s*(?:Route|Group)\s*\(\s*(?:"([^"]*)"\s*,\s*)?func\s*\(/g)) {
      const funcPos = m.index! + m[0].lastIndexOf('func');
      const scope = mod.scopes.find((s) => s.funcPos === funcPos);
      const param = scope?.params[0];
      if (scope && param) graph.addEdge(node(mod.file, param.name, scope.start), nodeAt(mod, m[1], m.index!), m[2] ?? '');
    }
  }

  // Calls into functions taking a router: routes.RegisterUsers(api.Group("/users")), h.Routes(v1)
  const byName = new Map<string, GoScope[]>();
  for (const mod of modules) {
    for (const s of mod.scopes) {
      if (!s.name || !s.params.some((p) => p.router)) continue;
      byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    }
  }
  for (const mod of modules) {
    for (const m of mod.code.matchAll(/(?:\b(\w+)\s*\.\s*)?\b([A-Za-z_]\w*)\s*\(/g)) {
      const candidates = byName.get(m[2]);
      if (!candidates) continue;
      if (/\bfunc\s*(?:\([^)]*\)\s*)?$/.test(mod.code.slice(Math.max(0, m.index! - 80), m.index! + (m[1] ? m[0].indexOf(m[2]) : 0)))) continue;
      const q = m[1];
      let list = candidates;
      if (q) {
        const imp = mod.imports.get(q);
        if (imp) {
          const pkg = imp.split('/').pop()!;
          list = candidates.filter((s) => !s.recvType && (dirOf(s.file) === pkg || dirOf(s.file).endsWith(`/${pkg}`)));
        } else {
          const hint = new RegExp(`\\b${q}\\s*:?=\\s*&?(?:\\w+\\.)?(\\w+)`).exec(mod.code)?.[1]?.replace(/^New/, '');
          list = candidates.filter((s) => s.recvType && (!hint || s.recvType === hint));
        }
      } else {
        list = candidates.filter((s) => !s.recvType && dirOf(s.file) === dirOf(mod.file));
      }
      if (list.length !== 1) continue;
      const fn = list[0];
      const call = inner(mod.code, m.index! + m[0].length - 1);
      if (!call) continue;
      const args = splitArgs(call.body);
      for (const p of fn.params) {
        if (!p.router) continue;
        const arg = args[p.index];
        let a: RegExpExecArray | null;
        if (!arg) continue;
        if ((a = /^(\w+)$/.exec(arg))) graph.addEdge(node(fn.file, p.name, fn.start), nodeAt(mod, a[1], m.index!), '');
        else if ((a = /^(\w+)\s*\.\s*(?:Group|PathPrefix)\s*\(\s*"([^"]*)"/.exec(arg))) {
          graph.addEdge(node(fn.file, p.name, fn.start), nodeAt(mod, a[1], m.index!), a[2]);
        }
      }
    }
  }

  // Routes.
  for (const mod of modules) {
    const { code, file, frameworks } = mod;
    const emit = (recv: string, method: HttpMethod, path: string, pos: number, framework: Framework) => {
      if (path !== '' && !path.startsWith('/')) return;
      for (const prefix of graph.prefixes(nodeAt(mod, recv, pos))) {
        out.push({ method, path: joinPath([prefix, path]), framework, file, line: mod.line(pos) });
      }
    };
    const ginLike: Framework | undefined = frameworks.has('Echo') ? 'Echo' : frameworks.has('Gin') ? 'Gin' : undefined;
    const fiberLike: Framework | undefined = frameworks.has('Fiber') ? 'Fiber' : frameworks.has('Chi') ? 'Chi' : undefined;

    if (ginLike) {
      for (const m of code.matchAll(/\b(\w+)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)\s*\(\s*"([^"]*)"/g)) {
        emit(m[1], toMethod(m[2])!, m[3], m.index!, ginLike);
      }
    }
    if (fiberLike) {
      for (const m of code.matchAll(/\b(\w+)\s*\.\s*(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*"([^"]*)"/g)) {
        if (m[1] === 'http') continue;
        emit(m[1], toMethod(m[2])!, m[3], m.index!, fiberLike);
      }
    }
    const framework = ginLike ?? fiberLike ?? (frameworks.has('Gorilla Mux') ? 'Gorilla Mux' : 'net/http');
    for (const m of code.matchAll(/\b(\w+)\s*\.\s*(?:Handle|Method|MethodFunc|Add)\s*\(\s*(?:"([A-Za-z]+)"|http\.Method(\w+))\s*,\s*"([^"]*)"/g)) {
      const method = toMethod(m[2] ?? m[3]);
      if (method) emit(m[1], method, m[4], m.index!, framework);
    }
    if (!ginLike && frameworks.size) {
      for (const m of code.matchAll(/\b(\w+)\s*\.\s*(HandleFunc|Handle)\s*\(\s*"([^"]*)"/g)) {
        const pattern = /^(?:([A-Z]+)\s+)?(\S*)$/.exec(m[3].trim());
        if (!pattern) continue;
        let path = pattern[2];
        if (!path.startsWith('/')) path = path.includes('/') ? path.slice(path.indexOf('/')) : '';
        if (!path) continue;
        let methods: HttpMethod[] = [];
        if (pattern[1]) {
          const one = toMethod(pattern[1]);
          if (one) methods = [one];
        } else {
          const call = inner(code, m.index! + m[0].indexOf('('));
          const after = call ? /^\s*\.\s*Methods\s*\(([^)]*)\)/.exec(code.slice(call.end + 1, call.end + 200)) : null;
          methods = after ? stringList(after[1]).map(toMethod).filter((x): x is HttpMethod => !!x) : [];
          if (!methods.length) methods = ['GET'];
        }
        const serveMux = m[1] === 'http' || new RegExp(`\\b${m[1]}\\s*:?=\\s*http\\.NewServeMux\\(`).test(code);
        const fw: Framework = serveMux ? 'net/http' : frameworks.has('Gorilla Mux') ? 'Gorilla Mux' : frameworks.has('Chi') ? 'Chi' : 'net/http';
        for (const method of methods) emit(m[1], method, path, m.index!, fw);
      }
    }
  }
  return out;
}
