// Java / Kotlin routes: Spring (@RestController + @RequestMapping / @GetMapping ...), with server.servlet.context-path.
import { HTTP_METHODS, type HttpMethod } from '../../shared/model';
import { joinPath } from './paths';
import { inner, lineIndex, splitArgs, stringList, stripComments } from './source';
import type { ScannedRoute, SourceFile } from './types';

export const JVM_FILE = /\.(?:java|kt)$/;
export const SPRING_CONFIG = /(?:^|\/)application(?:-[\w-]+)?\.(?:properties|ya?ml)$/;
const SKIP_FILE = /(?:^|\/)src\/test\//;

const CLASS_AFTER = /^\s*(?:@\w+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*|(?:public|private|protected|abstract|final|open|internal|data|sealed)\s+)*(?:class|interface|object)\s+\w+/;

interface Mapping {
  index: number;
  end: number;
  verb: string;
  paths: string[] | undefined;
  methods: HttpMethod[];
}

function readMapping(code: string, m: RegExpExecArray): Mapping {
  const afterName = m.index + m[0].length;
  const open = /^\s*\(/.exec(code.slice(afterName, afterName + 50));
  const verb = m[1];
  if (!open) return { index: m.index, end: afterName, verb, paths: [''], methods: [] };
  const args = inner(code, afterName + open[0].length - 1);
  if (!args) return { index: m.index, end: afterName, verb, paths: undefined, methods: [] };
  const spans = splitArgs(args.body);
  let paths: string[] | undefined;
  const first = spans[0];
  if (!first) paths = [''];
  else if (!/^\w+\s*=/.test(first)) paths = stringList(first).length ? stringList(first) : undefined;
  else {
    const named = /\b(?:value|path)\s*=\s*([[{][^\]}]*[\]}]|"[^"]*")/.exec(args.body);
    paths = named ? stringList(named[1]) : [''];
  }
  const methods = [...args.body.matchAll(/RequestMethod\.(\w+)/g)]
    .map((x) => x[1])
    .filter((x): x is HttpMethod => (HTTP_METHODS as readonly string[]).includes(x));
  return { index: m.index, end: args.end + 1, verb, paths, methods };
}

export function scanJvm(sources: readonly SourceFile[]): ScannedRoute[] {
  let contextPath = '';
  for (const src of sources) {
    if (!SPRING_CONFIG.test(src.path)) continue;
    const m = /server\.servlet\.context-path\s*[=:]\s*['"]?([^\s'"]+)/.exec(src.text) ?? /\bcontext-path:\s*['"]?([^\s'"]+)/.exec(src.text);
    if (m) {
      contextPath = m[1];
      break;
    }
  }

  const out: ScannedRoute[] = [];
  for (const src of sources) {
    if (!JVM_FILE.test(src.path) || SKIP_FILE.test(src.path) || !/@(?:Rest)?Controller\b/.test(src.text)) continue;
    const code = stripComments(src.text, 'c');
    const line = lineIndex(code);
    const classes = [...code.matchAll(/\b(?:class|interface|object)\s+\w+/g)].map((c) => c.index!);
    const mappings = [...code.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping\b/g)].map((m) => readMapping(code, m));

    const classPrefix = new Map<number, string>();
    const classLevel = new Set<Mapping>();
    for (const mp of mappings) {
      if (mp.verb !== 'Request' || !CLASS_AFTER.test(code.slice(mp.end, mp.end + 600))) continue;
      classLevel.add(mp);
      const owner = classes.find((c) => c > mp.index);
      if (owner !== undefined) classPrefix.set(owner, mp.paths?.[0] ?? '');
    }
    for (const mp of mappings) {
      if (classLevel.has(mp) || !mp.paths) continue;
      const owner = [...classes].reverse().find((c) => c < mp.index);
      const prefix = owner !== undefined ? (classPrefix.get(owner) ?? '') : '';
      const methods: HttpMethod[] = mp.verb === 'Request' ? (mp.methods.length ? mp.methods : ['GET']) : [mp.verb.toUpperCase() as HttpMethod];
      for (const p of mp.paths) {
        for (const method of methods) {
          out.push({ method, path: joinPath([contextPath, prefix, p]), framework: 'Spring', file: src.path, line: line(mp.index) });
        }
      }
    }
  }
  return out;
}
