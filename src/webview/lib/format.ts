// Formatting helpers. Pure; no DOM.
import { isEnabled, type AuthConfig } from '../../shared/model';

function trimNum(n: number): string {
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(1).replace(/\.0$/, '');
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${trimNum(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${trimNum(bytes / (1024 * 1024))} MB`;
  return `${trimNum(bytes / (1024 * 1024 * 1024))} GB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Live elapsed timer text, e.g. "0.4 s". */
export function formatElapsed(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

export type StatusClass = 'info' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'unknown';

export function statusClass(status: number): StatusClass {
  if (status >= 100 && status < 200) return 'info';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'client-error';
  if (status >= 500 && status < 600) return 'server-error';
  return 'unknown';
}

/** Standard reason phrases; servers often send none (HTTP/2 drops them). */
const STATUS_PHRASE: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Auth Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Headers Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  511: 'Network Auth Required',
};

/** Short meaning of a status code: the server's own phrase, else the standard one. */
export function statusPhrase(status: number, statusText?: string): string {
  const given = (statusText ?? '').trim();
  if (given) return given;
  const known = STATUS_PHRASE[status];
  if (known) return known;
  switch (statusClass(status)) {
    case 'info':
      return 'Informational';
    case 'success':
      return 'Success';
    case 'redirect':
      return 'Redirect';
    case 'client-error':
      return 'Client Error';
    case 'server-error':
      return 'Server Error';
    default:
      return '';
  }
}

export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

export type BodyLanguage = 'json' | 'xml' | 'html' | 'text';

export function bodyLanguage(contentType: string | undefined, body = ''): BodyLanguage {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct) return 'text';
  const head = body.trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.startsWith('<?xml') || head.startsWith('<')) return 'xml';
  return 'text';
}

/** Pretty-print JSON text; returns input unchanged if it does not parse. */
export function prettyJson(text: string): { text: string; ok: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), ok: true };
  } catch {
    return { text, ok: false };
  }
}

/**
 * Format JSON that may contain unquoted {{variables}} (e.g. `{"id": {{userId}}}`).
 * Lenient about what people paste: `//` and `/* *\/` comments, trailing commas and raw tabs/newlines
 * inside strings are cleaned up. Returns null when the text is still not valid JSON.
 */
export function formatJson(text: string): string | null {
  const raws: string[] = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i++;
      } else if (c === '\n' || c === '\r' || c === '\t') {
        // Literal control characters are invalid in JSON strings; collapse them to a space.
        if (!out.endsWith(' ')) out += ' ';
      } else {
        out += c;
        if (c === '"') inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        raws.push(text.slice(i, end + 2));
        out += `"__ORV_${raws.length - 1}__"`;
        i = end + 1;
        continue;
      }
    }
    if (c === '}' || c === ']') {
      // Drop a trailing comma before the closing bracket.
      out = out.replace(/,(\s*)$/, '$1');
    }
    out += c;
  }
  try {
    const formatted = JSON.stringify(JSON.parse(out), null, 2);
    return formatted.replace(/"__ORV_(\d+)__"/g, (_, n: string) => raws[Number(n)]);
  } catch {
    return null;
  }
}

export function countEnabled(rows: { key: string; enabled?: boolean }[]): number {
  let n = 0;
  for (const r of rows) if (isEnabled(r) && r.key.trim() !== '') n++;
  return n;
}

export function authLabel(auth: AuthConfig): string {
  switch (auth.type) {
    case 'inherit':
      return 'Inherit';
    case 'none':
      return 'No auth';
    case 'bearer':
      return 'Bearer token';
    case 'basic':
      return 'Basic auth';
    case 'apikey':
      return `API key (${auth.in})`;
  }
}

export function headerValue(headers: [string, string][], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === lower)?.[1];
}
