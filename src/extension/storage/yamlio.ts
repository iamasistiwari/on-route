// OWNER: agent "storage". YAML / file IO helpers.
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import YAML, { LineCounter, isNode } from 'yaml';
import type { z } from 'zod';

export function stringifyYaml(obj: unknown): string {
  const doc = new YAML.Document(obj, { aliasDuplicateObjects: false });
  return doc.toString({ lineWidth: 0, minContentWidth: 0, blockQuote: 'literal', indentSeq: true });
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; message: string; line?: number };

function formatPath(p: readonly PropertyKey[]): string {
  return p.map((s) => (typeof s === 'number' ? `[${s}]` : String(s))).join('.').replace(/\.\[/g, '[');
}

/** Parse YAML text and validate with schema. Returns message + 1-based line on failure. */
export function parseYaml<S extends z.ZodType>(text: string, schema: S): ParseResult<z.output<S>> {
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, prettyErrors: true });
  if (doc.errors.length) {
    const e = doc.errors[0];
    return { ok: false, message: e.message.split('\n')[0], line: e.linePos?.[0]?.line };
  }
  const raw = doc.toJS() ?? {};
  const res = schema.safeParse(raw);
  if (res.success) return { ok: true, data: res.data };
  const issue = res.error.issues[0];
  const p = issue.path as PropertyKey[];
  let line: number | undefined;
  for (let n = p.length; n >= 0 && line === undefined; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(p.slice(0, n) as unknown[], true);
    if (isNode(node) && node.range) line = lineCounter.linePos(node.range[0]).line;
  }
  const where = p.length ? `${formatPath(p)}: ` : '';
  return { ok: false, message: `${where}${issue.message}`, line };
}

export function parseJson<S extends z.ZodType>(text: string, schema: S): ParseResult<z.output<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = (e as Error).message;
    let line: number | undefined;
    const lm = /line (\d+)/.exec(msg);
    const pm = /position (\d+)/.exec(msg);
    if (lm) line = Number(lm[1]);
    else if (pm) line = text.slice(0, Number(pm[1])).split('\n').length;
    return { ok: false, message: msg, line };
  }
  const res = schema.safeParse(raw);
  if (res.success) return { ok: true, data: res.data };
  const issue = res.error.issues[0];
  const p = issue.path as PropertyKey[];
  return { ok: false, message: `${p.length ? formatPath(p) + ': ' : ''}${issue.message}` };
}

/** Write file atomically: temp file in the same directory, then rename. Creates parent dirs. */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
