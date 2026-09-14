// Workspace endpoint scanner: collects source files and runs every language scanner over them.
import { promises as fs } from 'fs';
import * as path from 'path';
import { HTTP_METHODS } from '../../shared/model';
import { GO_FILE, scanGo } from './go';
import { JS_FILE, scanJavaScript } from './js';
import { JVM_FILE, SPRING_CONFIG, scanJvm } from './jvm';
import { endpointKey } from './paths';
import { LARAVEL_ROUTES, scanPhp } from './php';
import { PY_FILE, scanPython } from './python';
import { RAILS_ROUTES, scanRuby } from './ruby';
import type { Framework, ProjectHints, ScannedRoute, SourceFile } from './types';

const SKIP_DIRS = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'venv',
  '__pycache__',
  'site-packages',
  'public',
  'tmp',
]);
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 20_000;

const PACKAGE_JSON = /(?:^|\/)package\.json$/;

const DEFAULT_PORTS: Record<Framework, number> = {
  Express: 3000,
  Fastify: 3000,
  Hono: 3000,
  Koa: 3000,
  Elysia: 3000,
  NestJS: 3000,
  'Next.js': 3000,
  FastAPI: 8000,
  Flask: 5000,
  Django: 8000,
  Gin: 8080,
  Echo: 8080,
  Fiber: 3000,
  Chi: 8080,
  'Gorilla Mux': 8080,
  'net/http': 8080,
  Spring: 8080,
  Laravel: 8000,
  Rails: 3000,
};

export interface ScanOutcome {
  /** Unique endpoints (first definition wins), sorted by path then method. */
  routes: ScannedRoute[];
  /** Detected frameworks, most routes first. */
  frameworks: Framework[];
  filesScanned: number;
  /** The file limit was hit; some files were not scanned. */
  truncated: boolean;
  /** http://localhost:<port> from the server's listen call or the framework default. */
  suggestedBaseUrl?: string;
}

const isCandidate = (rel: string) =>
  JS_FILE.test(rel) ||
  PY_FILE.test(rel) ||
  GO_FILE.test(rel) ||
  JVM_FILE.test(rel) ||
  SPRING_CONFIG.test(rel) ||
  LARAVEL_ROUTES.test(rel) ||
  RAILS_ROUTES.test(rel) ||
  PACKAGE_JSON.test(rel);

/** Simple globs: `*`, `?`, `**`. A pattern without "/" matches a file or directory name at any depth. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(g.includes('/') ? `^${re}(?:/|$)` : `(?:^|/)${re}(?:/|$)`);
}

export async function collectSources(
  root: string,
  exclude: readonly string[] = [],
  maxFiles = DEFAULT_MAX_FILES,
): Promise<{ files: SourceFile[]; truncated: boolean }> {
  const excluded = exclude.map(globToRegExp);
  const files: SourceFile[] = [];
  let truncated = false;
  const walk = async (dirAbs: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (truncated) return;
      if (ent.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (excluded.some((e) => e.test(r))) continue;
      const abs = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) await walk(abs, r);
      } else if (ent.isFile() && isCandidate(r)) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        try {
          if ((await fs.stat(abs)).size > MAX_FILE_BYTES) continue;
          files.push({ path: r, text: await fs.readFile(abs, 'utf8') });
        } catch {
          // unreadable file: skip
        }
      }
    }
  };
  await walk(root, '');
  return { files, truncated };
}

function projectHints(files: readonly SourceFile[]): ProjectHints {
  const deps = new Set<string>();
  for (const f of files) {
    if (!PACKAGE_JSON.test(f.path)) continue;
    try {
      const pkg = JSON.parse(f.text) as Record<string, unknown>;
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const block = pkg[key];
        if (block && typeof block === 'object') for (const name of Object.keys(block)) deps.add(name);
      }
    } catch {
      // invalid package.json
    }
  }
  return { npmDependencies: deps };
}

const JS_FRAMEWORKS = new Set<Framework>(['Express', 'Fastify', 'Hono', 'Koa', 'Elysia', 'NestJS', 'Next.js']);
const GO_FRAMEWORKS = new Set<Framework>(['Gin', 'Echo', 'Fiber', 'Chi', 'Gorilla Mux', 'net/http']);

function detectPort(files: readonly SourceFile[], framework: Framework): number {
  const find = (test: (f: SourceFile) => boolean, patterns: RegExp[]): number | undefined => {
    for (const f of files) {
      if (!test(f)) continue;
      for (const re of patterns) {
        const m = re.exec(f.text);
        const n = m ? Number(m[1]) : NaN;
        if (n > 0 && n < 65536) return n;
      }
    }
    return undefined;
  };
  let port: number | undefined;
  if (JS_FRAMEWORKS.has(framework)) {
    port = find((f) => JS_FILE.test(f.path), [/\.listen\(\s*(?:\{\s*port\s*:\s*)?(\d{2,5})\b/, /\bPORT\b[^\n]{0,40}?(?:\|\||\?\?)\s*['"]?(\d{2,5})\b/]);
    port ??= find((f) => PACKAGE_JSON.test(f.path), [/next\s+(?:dev|start)[^"\n]*?(?:-p|--port)\s+(\d{2,5})/]);
  } else if (framework === 'FastAPI' || framework === 'Flask') {
    port = find((f) => PY_FILE.test(f.path) && /\b(?:uvicorn\.run|\.run)\s*\(/.test(f.text), [/\bport\s*=\s*(\d{2,5})\b/]);
  } else if (GO_FRAMEWORKS.has(framework)) {
    port = find((f) => GO_FILE.test(f.path), [/\.(?:Run|Start|Listen|ListenAndServe)\s*\(\s*"[^"]*:(\d{2,5})"/]);
  } else if (framework === 'Spring') {
    port = find((f) => SPRING_CONFIG.test(f.path), [/server\.port\s*[=:]\s*(\d{2,5})/, /^server:\s*\n(?:[ \t]+.*\n)*?[ \t]+port:\s*(\d{2,5})/m]);
  }
  return port ?? DEFAULT_PORTS[framework];
}

export function compareRoutes(a: ScannedRoute, b: ScannedRoute): number {
  return a.path.localeCompare(b.path) || HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method);
}

/** Runs every scanner over already-loaded files. Pure; used directly by tests. */
export function scanSources(files: readonly SourceFile[]): Omit<ScanOutcome, 'filesScanned' | 'truncated'> {
  const hints = projectHints(files);
  const all = [...scanJavaScript(files, hints), ...scanPython(files), ...scanGo(files), ...scanJvm(files), ...scanPhp(files), ...scanRuby(files)];
  const byKey = new Map<string, ScannedRoute>();
  for (const r of all) {
    const key = endpointKey(r.method, r.path);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const routes = [...byKey.values()].sort(compareRoutes);
  const counts = new Map<Framework, number>();
  for (const r of routes) counts.set(r.framework, (counts.get(r.framework) ?? 0) + 1);
  const frameworks = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  return { routes, frameworks, suggestedBaseUrl: frameworks.length ? `http://localhost:${detectPort(files, frameworks[0])}` : undefined };
}

export async function scanProject(root: string, opts: { exclude?: readonly string[]; maxFiles?: number } = {}): Promise<ScanOutcome> {
  const { files, truncated } = await collectSources(root, opts.exclude, opts.maxFiles);
  return { ...scanSources(files), filesScanned: files.length, truncated };
}
