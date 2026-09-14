// OWNER: agent "curl-codegen".
// Shell word splitting for pasted command lines. Pure (browser + Node).

export class ShellParseError extends Error {}

export interface ShellToken {
  value: string;
  /** True for unquoted control operators (`|`, `||`, `&&`, `;`) and redirections (`>`, `>>`, `2>`, `<`). */
  op?: boolean;
}

const WS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/**
 * Tokenize a command line. Automatically detects Windows cmd syntax (`^` escapes/continuations,
 * as produced by Chrome "Copy as cURL (cmd)") and falls back to POSIX shell rules otherwise.
 */
export function tokenize(input: string): ShellToken[] {
  return looksLikeCmd(input) ? tokenizeCmd(input) : tokenizePosix(input);
}

/** Convenience: word values only, stopping at the first control operator. */
export function splitShellWords(input: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(input)) {
    if (t.op) break;
    out.push(t.value);
  }
  return out;
}

export function looksLikeCmd(input: string): boolean {
  return /\^\r?\n/.test(input) || /(^|\s)\^"/.test(input);
}

// ---------------------------------------------------------------- POSIX

export function tokenizePosix(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const s = input;
  const n = s.length;
  let i = 0;
  let word = '';
  let inWord = false;

  const push = () => {
    if (inWord) tokens.push({ value: word });
    word = '';
    inWord = false;
  };

  while (i < n) {
    const c = s[i];

    if (WS.has(c)) {
      push();
      i++;
      continue;
    }

    // Comment at word start.
    if (c === '#' && !inWord) {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }

    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (s[i + 1] === '\r' && s[i + 2] === '\n') {
        i += 3;
        continue;
      }
      if (i + 1 < n) {
        word += s[i + 1];
        inWord = true;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // PowerShell backtick line continuation.
    if (c === '`' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      push();
      i += s[i + 1] === '\n' ? 2 : 3;
      continue;
    }

    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) throw new ShellParseError('Unterminated single quote');
      word += s.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }

    if (c === '$' && s[i + 1] === "'") {
      const r = readAnsiC(s, i + 2);
      word += r.value;
      inWord = true;
      i = r.end;
      continue;
    }

    if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const d = s[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < n) {
          const e = s[i + 1];
          if (e === '"' || e === '\\' || e === '$' || e === '`') {
            word += e;
            i += 2;
            continue;
          }
          if (e === '\n') {
            i += 2;
            continue;
          }
          if (e === '\r' && s[i + 2] === '\n') {
            i += 3;
            continue;
          }
        }
        word += d;
        i++;
      }
      if (!closed) throw new ShellParseError('Unterminated double quote');
      inWord = true;
      continue;
    }

    // Control operators and redirections (unquoted).
    if (c === '|' || c === ';') {
      push();
      const two = s.slice(i, i + 2);
      const v = two === '||' ? '||' : c;
      tokens.push({ value: v, op: true });
      i += v.length;
      continue;
    }
    if (c === '&' && s[i + 1] === '&' && !inWord) {
      tokens.push({ value: '&&', op: true });
      i += 2;
      continue;
    }
    if ((c === '>' || c === '<') && (!inWord || /^\d$/.test(word))) {
      const prefix = inWord ? word : '';
      word = '';
      inWord = false;
      let v = prefix + c;
      i++;
      if (s[i] === '>' || s[i] === '&') {
        v += s[i];
        i++;
      }
      tokens.push({ value: v, op: true });
      continue;
    }

    word += c;
    inWord = true;
    i++;
  }
  push();
  return tokens;
}

/** Reads the body of $'...' starting after the opening quote. */
function readAnsiC(s: string, start: number): { value: string; end: number } {
  let i = start;
  let out = '';
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) {
      out += decodeUtf8(bytes);
      bytes = [];
    }
  };
  const isHex = (ch: string | undefined) => !!ch && /[0-9a-fA-F]/.test(ch);

  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      flush();
      return { value: out, end: i + 1 };
    }
    if (c !== '\\' || i + 1 >= s.length) {
      flush();
      out += c;
      i++;
      continue;
    }
    const e = s[i + 1];
    i += 2;
    const simple: Record<string, string> = {
      n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v',
      '\\': '\\', "'": "'", '"': '"', '?': '?',
    };
    if (e in simple) {
      flush();
      out += simple[e];
      continue;
    }
    if (e === 'x') {
      let h = '';
      while (h.length < 2 && isHex(s[i])) h += s[i++];
      if (!h) {
        flush();
        out += '\\x';
      } else bytes.push(parseInt(h, 16));
      continue;
    }
    if (/[0-7]/.test(e)) {
      let o = e;
      while (o.length < 3 && /[0-7]/.test(s[i] ?? '')) o += s[i++];
      bytes.push(parseInt(o, 8) & 0xff);
      continue;
    }
    if (e === 'u' || e === 'U') {
      const max = e === 'u' ? 4 : 8;
      let h = '';
      while (h.length < max && isHex(s[i])) h += s[i++];
      flush();
      if (!h) out += '\\' + e;
      else {
        const cp = parseInt(h, 16);
        out += cp <= 0xffff ? String.fromCharCode(cp) : safeFromCodePoint(cp);
      }
      continue;
    }
    if (e === 'c' && i < s.length) {
      flush();
      out += String.fromCharCode(s.charCodeAt(i) & 0x1f);
      i++;
      continue;
    }
    flush();
    out += '\\' + e;
  }
  throw new ShellParseError("Unterminated $'...' quote");
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '�';
  }
}

function decodeUtf8(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let need = 0;
    let cp = 0;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    } else if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      cp = b & 0x07;
    } else {
      out += String.fromCharCode(b); // invalid lead byte: latin1 fallback
      i++;
      continue;
    }
    if (i + need >= bytes.length) {
      // truncated sequence
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    let ok = true;
    for (let k = 1; k <= need; k++) {
      const cb = bytes[i + k];
      if ((cb & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (!ok) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    out += safeFromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

// ---------------------------------------------------------------- Windows cmd

/**
 * Two layers: cmd.exe (`^` escapes the next char, `^`+newline continues the line) and then the
 * MSVCRT argv rules used by curl.exe (`"` toggles quoting, backslashes escape quotes).
 */
export function tokenizeCmd(input: string): ShellToken[] {
  // Layer 1: cmd.exe caret handling. Chrome encodes a newline inside a string as "^\n\n".
  let s = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c !== '^') {
      s += c;
      continue;
    }
    const rest = input.slice(i + 1, i + 5);
    const m = /^(\r?\n)(\r?\n)?/.exec(rest);
    if (m) {
      if (m[2]) s += '\n'; // literal newline in string
      else s += ' '; // continuation
      i += m[0].length;
      continue;
    }
    if (i + 1 < input.length) {
      s += input[i + 1];
      i++;
    }
  }

  // Layer 2: MSVCRT argv splitting.
  const tokens: ShellToken[] = [];
  let word = '';
  let inWord = false;
  let inQuote = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (!inQuote && WS.has(c)) {
      if (inWord) tokens.push({ value: word });
      word = '';
      inWord = false;
      i++;
      continue;
    }
    if (c === '\\') {
      let count = 0;
      while (s[i] === '\\') {
        count++;
        i++;
      }
      if (s[i] === '"') {
        word += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) {
          word += '"';
          i++;
        }
      } else {
        word += '\\'.repeat(count);
      }
      inWord = true;
      continue;
    }
    if (c === '"') {
      // "" inside a quoted region is a literal quote.
      if (inQuote && s[i + 1] === '"') {
        word += '"';
        i += 2;
        continue;
      }
      inQuote = !inQuote;
      inWord = true;
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  if (inWord) tokens.push({ value: word });
  return tokens;
}
