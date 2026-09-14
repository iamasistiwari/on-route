// Variable helpers for the UI (highlighting, resolved preview). Pure; no DOM.
import { isEnabled, type Variable } from '../../shared/model';
import type { VariableInfo } from '../../shared/protocol';
import { closestMatch } from './fuzzy';

export interface Segment {
  text: string;
  /** Set when this segment is a {{variable}} reference. */
  varName?: string;
}

const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function tokenizeTemplate(input: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of input.matchAll(VAR_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: input.slice(last, idx) });
    out.push({ text: m[0], varName: m[1] });
    last = idx + m[0].length;
  }
  if (last < input.length) out.push({ text: input.slice(last) });
  return out;
}

/** The {{variable}} reference covering character `index` of `input`, with its [from, to) range. */
export function varAt(input: string, index: number): { name: string; from: number; to: number } | null {
  for (const m of input.matchAll(VAR_RE)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (index >= from && index < to) return m[1] ? { name: m[1], from, to } : null;
  }
  return null;
}

/** How long the pointer rests on a {{variable}} before its value is shown. */
export const VAR_HOVER_MS = 2000;

export interface VarDescription {
  name: string;
  /** Text to show as the value. */
  value: string;
  /** Scope that supplied the value, when defined. */
  source?: string;
  state: 'value' | 'empty' | 'secret' | 'dynamic' | 'unresolved';
  /** Unresolved: a defined variable with a similar name (likely a typo). */
  suggestion?: string;
}

/** What a hover over `{{name}}` shows. Secret values are never available in the webview. */
export function describeVar(name: string, vars: readonly VariableInfo[]): VarDescription {
  const v = vars.find((x) => x.key === name);
  if (!v) {
    if (DYNAMIC_VARS.includes(name)) return { name, value: 'Generated when the request is sent', source: 'dynamic', state: 'dynamic' };
    const suggestion = closestMatch(name, [...vars.map((x) => x.key), ...DYNAMIC_VARS]);
    return { name, value: 'Not defined in the project, its folders or the active environment', state: 'unresolved', ...(suggestion && { suggestion }) };
  }
  if (v.secret) return v.resolved ? { name, value: '••••••', source: v.source, state: 'secret' } : { name, value: 'Secret without a local value', source: v.source, state: 'unresolved' };
  if (!v.resolved) return { name, value: 'No value', source: v.source, state: 'unresolved' };
  return v.value === '' ? { name, value: 'Empty string', source: v.source, state: 'empty' } : { name, value: v.value, source: v.source, state: 'value' };
}

export const DYNAMIC_VARS = ['$uuid', '$timestamp', '$isoTimestamp', '$randomInt'];

export function isKnownVar(name: string, keys: ReadonlySet<string>): boolean {
  return keys.has(name) || DYNAMIC_VARS.includes(name);
}

const DYNAMIC_INFO: VariableInfo[] = DYNAMIC_VARS.map((key) => ({ key, value: '', source: 'dynamic', secret: false, resolved: true }));

/** Keys that resolve to a value (secrets without a local value are excluded). */
export function resolvedKeys(vars: readonly VariableInfo[]): Set<string> {
  return new Set(vars.filter((v) => v.resolved).map((v) => v.key));
}

/** Names referenced in `text` that do not resolve. */
export function unresolvedNames(text: string, keys: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const s of tokenizeTemplate(text)) if (s.varName !== undefined && s.varName !== '' && !isKnownVar(s.varName, keys)) out.add(s.varName);
  return [...out];
}

/** Suggestions for `query`: prefix matches first, then substring matches; dynamic vars last. */
export function suggestVariables(vars: readonly VariableInfo[], query: string): VariableInfo[] {
  const q = query.toLowerCase();
  const all = [...vars, ...DYNAMIC_INFO];
  const prefix = all.filter((v) => v.key.toLowerCase().startsWith(q));
  const inner = q ? all.filter((v) => !v.key.toLowerCase().startsWith(q) && v.key.toLowerCase().includes(q)) : [];
  if (prefix.length || inner.length) return [...prefix, ...inner];
  // Nothing contains the query: offer the closest spelling ("baseUlr" -> baseUrl).
  const close = closestMatch(query, all.map((v) => v.key));
  return close ? all.filter((v) => v.key === close) : [];
}

const NAME_CHARS = '[\\w.$-]*';
const OPEN_BEFORE = new RegExp(`\\{\\{\\s*(${NAME_CHARS})$`);
const TAIL_CLOSED = new RegExp(`^${NAME_CHARS}\\s*\\}\\}`);
const TAIL_OPEN = new RegExp(`^${NAME_CHARS}`);

export interface CompletionRange {
  /** Index of the opening `{{`. */
  from: number;
  /** End of the text to replace (covers the rest of the name and an existing `}}`). */
  to: number;
  query: string;
}

/** When the caret sits inside `{{partial`, the range a completion replaces; otherwise null. */
export function completionRange(text: string, caret: number): CompletionRange | null {
  const m = OPEN_BEFORE.exec(text.slice(0, caret));
  if (!m) return null;
  const after = text.slice(caret);
  const tail = TAIL_CLOSED.exec(after) ?? TAIL_OPEN.exec(after);
  return { from: m.index, to: caret + (tail?.[0].length ?? 0), query: m[1] };
}

export function applyCompletion(text: string, range: CompletionRange, key: string): { text: string; caret: number } {
  const insert = `{{${key}}}`;
  return { text: text.slice(0, range.from) + insert + text.slice(range.to), caret: range.from + insert.length };
}

export interface ResolvedVar {
  key: string;
  value: string;
  source: string;
  secret: boolean;
}

/** Merge scopes (lowest precedence first) keeping track of where each value came from. */
export function mergeScopes(scopes: { name: string; variables: Variable[] }[]): ResolvedVar[] {
  const map = new Map<string, ResolvedVar>();
  for (const scope of scopes) {
    for (const v of scope.variables) {
      if (!isEnabled(v) || v.key.trim() === '') continue;
      const prev = map.get(v.key);
      const secret = !!v.secret || !!prev?.secret;
      if (v.secret && v.value === '') {
        if (prev) prev.secret = true;
        else map.set(v.key, { key: v.key, value: '', source: scope.name, secret: true });
        continue;
      }
      map.set(v.key, { key: v.key, value: v.value, source: scope.name, secret });
    }
  }
  return [...map.values()];
}
