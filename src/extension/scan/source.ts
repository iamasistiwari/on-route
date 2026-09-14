// Text helpers for the regex-based route scanners: comment stripping, bracket matching, argument splitting.

export type CommentStyle = 'c' | 'hash' | 'php';

/**
 * Blanks out comments (newlines kept, so offsets and line numbers stay valid) so commented-out routes are
 * ignored. String literals are left intact. `c`: // and block comments; `hash`: # (Python/Ruby, with
 * triple-quoted strings); `php`: both.
 */
export function stripComments(text: string, style: CommentStyle): string {
  const out = text.split('');
  const n = text.length;
  const slashes = style !== 'hash';
  const hash = style !== 'c';
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '"' || c === "'" || (c === '`' && style !== 'hash')) {
      if (style === 'hash' && text.startsWith(c + c + c, i)) {
        const end = text.indexOf(c + c + c, i + 3);
        i = end < 0 ? n : end + 3;
        continue;
      }
      i = skipString(text, i);
      continue;
    }
    if (slashes && c === '/' && d === '/') {
      const end = lineEnd(text, i);
      blank(i, end);
      i = end;
      continue;
    }
    if (slashes && c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    // PHP 8 attributes (#[...]) are code, not comments.
    if (hash && c === '#' && !(style === 'php' && d === '[')) {
      const end = lineEnd(text, i);
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

function lineEnd(text: string, from: number): number {
  const e = text.indexOf('\n', from);
  return e < 0 ? text.length : e;
}

/** Index just past the string literal starting at `start`. Quotes other than backticks stop at a newline. */
function skipString(text: string, start: number): number {
  const q = text[start];
  let j = start + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === q) return j + 1;
    if (ch === '\n' && q !== '`') return j;
    j++;
  }
  return j;
}

/** Maps a character offset to its 1-based line number. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Index of the bracket closing the one at `open` ( ( [ or { ), skipping strings; -1 when unbalanced. */
export function matchClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i) - 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Text between the bracket at `open` and its match (exclusive), or undefined when unbalanced. */
export function inner(text: string, open: number): { body: string; end: number } | undefined {
  const end = matchClose(text, open);
  return end < 0 ? undefined : { body: text.slice(open + 1, end), end };
}

/** Splits an argument list on top-level commas. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(args, i) - 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = args.slice(start).trim();
  if (last || out.length) out.push(last);
  return out;
}

/** Contents of a plain string literal ('x', "x", `x` without interpolation, Python r/b/u prefixes). */
export function stringValue(expr: string | undefined): string | undefined {
  if (expr === undefined) return undefined;
  const m = /^[rRbBuU]?(['"`])([\s\S]*)\1$/.exec(expr.trim());
  if (!m) return undefined;
  if (m[1] === '`' && m[2].includes('${')) return undefined;
  return m[2];
}

/** All string literals inside a list expression like ['GET', "POST"] or %w[...]-free arrays. */
export function stringList(expr: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out.push(m[2]);
  return out;
}

/** Value of a keyword / property argument like `prefix="/x"`, `prefix: '/x'` or `'prefix' => '/x'`. */
export function namedString(args: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|[\\s,({\\[])['"]?${name}['"]?\\s*(?:=>|=|:)\\s*(?:[rRbBuU]?)(['"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`);
  return re.exec(args)?.[2];
}

/** Posix dirname / join without importing `path` (keeps this module usable anywhere). */
export function dirOf(file: string): string {
  const i = file.lastIndexOf('/');
  return i < 0 ? '' : file.slice(0, i);
}

export function joinFile(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
