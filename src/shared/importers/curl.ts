// OWNER: agent "curl-codegen".
import { HTTP_METHODS } from '../model';
import type { AuthConfig, BodyConfig, FormField, HttpMethod, KeyValue, RequestDef } from '../model';
import { ShellParseError, tokenize } from './shellwords';

export class CurlParseError extends Error {}

const PREFIX_RE = /^\s*(?:[$>#%]\s+)?curl(?:\.exe)?(?=\s|$)/;

/** True when text (trimmed, optionally prefixed by "$ ") starts with the word `curl`. */
export function isCurlCommand(text: string): boolean {
  return typeof text === 'string' && PREFIX_RE.test(text);
}

// ---------------------------------------------------------------- flag tables

/** Short flags that take a value. Everything else short is treated as a boolean. */
const SHORT_WITH_VALUE = new Set('XHdFuAbeomwxETcKrCDUYytPQz'.split(''));

const SHORT_ALIASES: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', b: 'cookie',
  e: 'referer', G: 'get', I: 'head', T: 'upload-file',
};

/** Long flags that take a value (subset of curl's list; those not handled are skipped with their value). */
const LONG_WITH_VALUE = new Set([
  'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json',
  'form', 'form-string', 'user', 'user-agent', 'cookie', 'referer', 'url', 'url-query', 'upload-file',
  'oauth2-bearer', 'output', 'output-dir', 'connect-timeout', 'max-time', 'write-out', 'retry',
  'retry-delay', 'retry-max-time', 'proxy', 'proxy-user', 'proxy-header', 'preproxy', 'noproxy',
  'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'cacert', 'capath', 'cert', 'cert-type', 'key',
  'key-type', 'pass', 'resolve', 'connect-to', 'limit-rate', 'cookie-jar', 'config', 'range',
  'dump-header', 'interface', 'max-filesize', 'max-redirs', 'ciphers', 'tls13-ciphers', 'curves',
  'tls-max', 'unix-socket', 'abstract-unix-socket', 'dns-servers', 'doh-url', 'trace', 'trace-ascii',
  'stderr', 'aws-sigv4', 'keepalive-time', 'expect100-timeout', 'speed-limit', 'speed-time',
  'time-cond', 'local-port', 'pinnedpubkey', 'hostpubmd5', 'hostpubsha256', 'mail-from', 'mail-rcpt',
  'login-options', 'sasl-authzid', 'service-name', 'delegation', 'krb', 'ftp-port', 'quote',
  'telnet-option', 'tlsuser', 'tlspassword', 'proto', 'proto-redir', 'proto-default', 'rate',
  'parallel-max', 'netrc-file', 'random-file', 'egd-file', 'ftp-account', 'ftp-method',
  'variable', 'happy-eyeballs-timeout-ms', 'create-file-mode', 'ip-tos', 'vlan-priority',
  'proxy-cacert', 'proxy-cert', 'proxy-key', 'proxy-pass', 'proxy-ciphers', 'crlfile', 'engine',
  'etag-save', 'etag-compare', 'header-file', 'alt-svc', 'hsts', 'max-filesize', 'form-escape',
]);

// ---------------------------------------------------------------- helpers

type DataKind = 'data' | 'raw' | 'binary' | 'urlencode' | 'json';

function safeDecode(s: string, plusIsSpace: boolean): string {
  const v = plusIsSpace ? s.replace(/\+/g, ' ') : s;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function splitQuery(q: string, plusIsSpace: boolean): KeyValue[] {
  if (!q) return [];
  return q
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=');
      return eq === -1
        ? { key: safeDecode(p, plusIsSpace), value: '' }
        : { key: safeDecode(p.slice(0, eq), plusIsSpace), value: safeDecode(p.slice(eq + 1), plusIsSpace) };
    });
}

/** Encode the way curl --data-urlencode does. */
function curlUrlEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function looksLikeUrl(s: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ||
    s.startsWith('{{') ||
    /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]|$)/i.test(s)
  );
}

function mediaType(ct: string | undefined): string {
  return (ct ?? '').split(';')[0].trim().toLowerCase();
}

function isJsonMedia(ct: string | undefined): boolean {
  const m = mediaType(ct);
  return m === 'application/json' || m.endsWith('+json') || m === 'text/json';
}

function tryPrettyJson(s: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return undefined;
  }
}

function decodeBase64(s: string): string | undefined {
  try {
    const g = globalThis as { atob?: (x: string) => string };
    if (!g.atob) return undefined;
    const bin = g.atob(s.trim());
    // interpret as UTF-8
    try {
      return decodeURIComponent(
        bin
          .split('')
          .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
          .join(''),
      );
    } catch {
      return bin;
    }
  } catch {
    return undefined;
  }
}

/** Strip curl -F attributes (;type=, ;filename=, ;headers=, ;encoder=) and surrounding quotes. */
function parseFormValue(raw: string): string {
  if (raw.startsWith('"')) {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\' && i + 1 < raw.length) {
        out += raw[++i];
        continue;
      }
      if (c === '"') return out;
      out += c;
    }
    return out;
  }
  return raw.replace(/;\s*(type|filename|headers|encoder)=.*$/s, '');
}

function parseMultipart(content: string, boundary: string): FormField[] | undefined {
  const delim = '--' + boundary;
  const parts = content.split(delim);
  if (parts.length < 3) return undefined;
  const fields: FormField[] = [];
  for (const part of parts.slice(1)) {
    if (part.startsWith('--')) break;
    const body = part.replace(/^\r?\n/, '');
    const sep = /\r?\n\r?\n/.exec(body);
    if (!sep) continue;
    const head = body.slice(0, sep.index);
    const value = body.slice(sep.index + sep[0].length).replace(/\r?\n$/, '');
    const cd = /content-disposition:[^\n]*?\bname="([^"]*)"/i.exec(head);
    if (!cd) continue;
    const fn = /\bfilename="([^"]*)"/i.exec(head);
    if (fn) fields.push({ key: cd[1], value: fn[1], kind: 'file' });
    else fields.push({ key: cd[1], value, kind: 'text' });
  }
  return fields;
}

function suggestName(method: string, url: string): string {
  let rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  if (rest === url) rest = url.replace(/^\{\{[^}]*\}\}/, '');
  const path = rest.split(/[?#]/)[0];
  return `${method} ${path.startsWith('/') ? path : '/' + path}`;
}

// ---------------------------------------------------------------- parser

/**
 * Parse a curl command (as copied from Chrome/Firefox DevTools "Copy as cURL (bash)" and
 * "(cmd)", Postman, docs) into request fields. Handles: POSIX quoting ('...', "...", $'...'),
 * backslash-newline and ^-newline (cmd) continuations, -X/--request, -H/--header, -d/--data,
 * --data-raw, --data-binary, --data-urlencode, --json, -F/--form, -u/--user, -A/--user-agent,
 * -b/--cookie, -e/--referer, -G/--get, -I/--head, --url, and ignores -k, -L, -s, -v, --compressed,
 * -i, -o <file>, --location etc. Query string of URL is split into `params`.
 * Body type inference: --json or JSON-parseable data with json content-type or looks like {..}/[..]
 * => json (pretty-printed 2 spaces); form-urlencoded => urlencoded fields; -F => form; else raw.
 * -u user:pass => auth basic (not a header); "Authorization: Bearer x" header => auth bearer and
 * header removed. Method default: GET, or POST if body present.
 * Returns fields without `id`/`name`; name is suggested as "<METHOD> <path>".
 */
export function parseCurl(input: string): Omit<RequestDef, 'id'> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new CurlParseError('Nothing to import: paste a curl command, e.g. curl https://api.example.com/users');
  }
  if (!isCurlCommand(input)) {
    throw new CurlParseError('Not a curl command: the text must start with "curl".');
  }
  const text = input.replace(/^\s*[$>#%]\s+/, '');

  let tokens;
  try {
    tokens = tokenize(text);
  } catch (e) {
    const msg = e instanceof ShellParseError ? e.message : String(e);
    throw new CurlParseError(`Could not parse curl command: ${msg}. Check that all quotes are closed.`);
  }
  if (!tokens.length || !/^curl(\.exe)?$/.test(tokens[0].value)) {
    throw new CurlParseError('Not a curl command: the text must start with "curl".');
  }

  let method: string | undefined;
  let url: string | undefined;
  const headers: KeyValue[] = [];
  const cookies: string[] = [];
  const data: { kind: DataKind; value: string }[] = [];
  const form: FormField[] = [];
  const urlQuery: string[] = [];
  let auth: AuthConfig = { type: 'inherit' };
  let useGet = false;
  let head = false;
  let uploadFile: string | undefined;

  const handle = (name: string, value: string | undefined) => {
    switch (name) {
      case 'request':
        method = value!.toUpperCase();
        break;
      case 'header': {
        const v = value!;
        if (v.startsWith('@')) break; // header file
        const colon = v.indexOf(':');
        const semi = v.indexOf(';');
        if (colon === -1 || (semi !== -1 && semi < colon)) {
          if (semi !== -1 && v.slice(semi + 1).trim() === '') {
            headers.push({ key: v.slice(0, semi).trim(), value: '' });
          }
          break;
        }
        const key = v.slice(0, colon).trim();
        const val = v.slice(colon + 1).trim();
        if (!key || val === '') break; // "X:" removes a header in curl
        headers.push({ key, value: val });
        break;
      }
      case 'data':
      case 'data-ascii':
        data.push({ kind: value!.startsWith('@') ? 'binary' : 'data', value: value! });
        break;
      case 'data-raw':
        data.push({ kind: 'raw', value: value! });
        break;
      case 'data-binary':
        data.push({ kind: value!.startsWith('@') ? 'binary' : 'raw', value: value! });
        break;
      case 'data-urlencode':
        data.push({ kind: 'urlencode', value: value! });
        break;
      case 'json':
        data.push({ kind: 'json', value: value! });
        break;
      case 'form':
      case 'form-string': {
        const v = value!;
        const eq = v.indexOf('=');
        if (eq === -1) break;
        const key = v.slice(0, eq);
        const rest = v.slice(eq + 1);
        if (name === 'form' && (rest.startsWith('@') || rest.startsWith('<'))) {
          form.push({ key, value: parseFormValue(rest.slice(1)), kind: 'file' });
        } else if (name === 'form') {
          form.push({ key, value: parseFormValue(rest), kind: 'text' });
        } else {
          form.push({ key, value: rest, kind: 'text' });
        }
        break;
      }
      case 'user': {
        const v = value!;
        const i = v.indexOf(':');
        auth = i === -1
          ? { type: 'basic', username: v, password: '' }
          : { type: 'basic', username: v.slice(0, i), password: v.slice(i + 1) };
        break;
      }
      case 'oauth2-bearer':
        auth = { type: 'bearer', token: value! };
        break;
      case 'user-agent':
        headers.push({ key: 'User-Agent', value: value! });
        break;
      case 'referer':
        headers.push({ key: 'Referer', value: value!.replace(/;auto$/, '') });
        break;
      case 'cookie':
        if (value!.includes('=')) cookies.push(value!);
        break;
      case 'url':
        if (url === undefined) url = value!;
        break;
      case 'url-query':
        urlQuery.push(value!);
        break;
      case 'get':
        useGet = true;
        break;
      case 'head':
        head = true;
        break;
      case 'upload-file':
        uploadFile = value!;
        break;
      default:
        break; // ignored flag
    }
  };

  let endOfOptions = false;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.op) {
      if (/^\d?[<>]/.test(tok.value)) {
        i++; // redirection target
        continue;
      }
      break; // pipe / ; / && — end of the curl command
    }
    const t = tok.value;
    const next = () => {
      const n = tokens[i + 1];
      if (!n || n.op) throw new CurlParseError(`Missing value for option "${t}".`);
      i++;
      return n.value;
    };

    if (endOfOptions || !t.startsWith('-') || t === '-') {
      if (url === undefined) url = t;
      continue;
    }
    if (t === '--') {
      endOfOptions = true;
      continue;
    }

    if (t.startsWith('--')) {
      let name = t.slice(2);
      let value: string | undefined;
      const eq = /^([a-z0-9][a-z0-9-]*)=(.*)$/is.exec(name);
      if (eq) {
        name = eq[1];
        value = eq[2];
      }
      name = name.toLowerCase();
      if (name.startsWith('no-')) continue; // boolean negation
      if (LONG_WITH_VALUE.has(name)) {
        handle(name, value ?? next());
      } else if (value === undefined && (name === 'get' || name === 'head')) {
        handle(name, undefined);
      } else if (value === undefined) {
        // Unknown flag: swallow a following value when it clearly isn't a URL or another flag.
        const n = tokens[i + 1];
        if (
          !KNOWN_LONG_BOOL.has(name) &&
          n && !n.op && !n.value.startsWith('-') && !looksLikeUrl(n.value) &&
          (url !== undefined || hasLaterUrl(tokens, i + 2))
        ) {
          i++;
        }
      }
      continue;
    }

    // Short flag cluster, e.g. -sSL, -XPOST, -H'X: y'
    const cluster = t.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k];
      if (SHORT_WITH_VALUE.has(ch)) {
        const attached = cluster.slice(k + 1);
        const value = attached !== '' ? attached : next();
        const alias = SHORT_ALIASES[ch];
        if (alias) handle(alias, value);
        break;
      }
      const alias = SHORT_ALIASES[ch];
      if (alias) handle(alias, undefined);
    }
  }

  if (url === undefined || url.trim() === '') {
    throw new CurlParseError('No URL found in curl command.');
  }
  url = url.trim();

  if (cookies.length) {
    const existing = headers.find((h) => h.key.toLowerCase() === 'cookie');
    if (existing) existing.value = [existing.value, ...cookies].join('; ');
    else headers.push({ key: 'Cookie', value: cookies.join('; ') });
  }

  // ---- URL + params
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = 'http://' + url;
  const hash = url.indexOf('#');
  if (hash !== -1) url = url.slice(0, hash);
  const qi = url.indexOf('?');
  const params: KeyValue[] = [];
  if (qi !== -1) {
    params.push(...splitQuery(url.slice(qi + 1), false));
    url = url.slice(0, qi);
  }
  for (const q of urlQuery) params.push(...splitQuery(encodeDataUrlencode(q).replace(/^&/, ''), false));

  // ---- body
  const ctHeader = headers.find((h) => h.key.toLowerCase() === 'content-type');
  const ct = ctHeader?.value;
  let body: BodyConfig = { type: 'none' };
  let removeCt = false;

  if (data.length && useGet) {
    const joined = data
      .filter((d) => d.kind !== 'binary')
      .map((d) => (d.kind === 'urlencode' ? encodeDataUrlencode(d.value) : d.value))
      .join('&');
    params.push(...splitQuery(joined, true));
  } else if (data.length) {
    const binary = data.find((d) => d.kind === 'binary');
    const hasJson = data.some((d) => d.kind === 'json');
    if (binary) {
      body = { type: 'binary', filePath: binary.value.slice(1) };
    } else if (hasJson) {
      const content = data.map((d) => d.value).join('');
      body = { type: 'json', content: tryPrettyJson(content) ?? content };
      if (mediaType(ct) === 'application/json') removeCt = true;
    } else {
      const hasUrlencode = data.some((d) => d.kind === 'urlencode');
      const joined = data.map((d) => (d.kind === 'urlencode' ? encodeDataUrlencode(d.value) : d.value)).join('&');
      const trimmed = joined.trim();
      const m = mediaType(ct);
      const boundary = /boundary=("?)([^";]+)\1/i.exec(ct ?? '')?.[2];
      const pretty = tryPrettyJson(joined);

      if (pretty !== undefined && (isJsonMedia(ct) || (!ct && /^[[{]/.test(trimmed)))) {
        body = { type: 'json', content: pretty };
        if (m === 'application/json') removeCt = true;
      } else if (m === 'multipart/form-data' && boundary && parseMultipart(joined, boundary)?.length) {
        body = { type: 'form', fields: parseMultipart(joined, boundary)! };
        removeCt = true;
      } else if (
        hasUrlencode ||
        m === 'application/x-www-form-urlencoded' ||
        (!ct && /^[^=&\s]+=[^&\n]*(&[^=&\s]+=[^&\n]*)*$/.test(joined))
      ) {
        body = { type: 'urlencoded', fields: splitQuery(joined, true) };
        if (m === 'application/x-www-form-urlencoded') removeCt = true;
      } else {
        body = { type: 'raw', content: joined };
      }
    }
  } else if (form.length) {
    body = { type: 'form', fields: form };
    if (mediaType(ct) === 'multipart/form-data') removeCt = true;
  } else if (uploadFile !== undefined && uploadFile !== '-' && uploadFile !== '.') {
    body = { type: 'binary', filePath: uploadFile };
  }

  if (removeCt && ctHeader) headers.splice(headers.indexOf(ctHeader), 1);

  // ---- auth from Authorization header
  const authIdx = headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
  if (authIdx !== -1 && auth.type === 'inherit') {
    const v = headers[authIdx].value;
    const bearer = /^Bearer\s+(.+)$/i.exec(v);
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(v);
    if (bearer) {
      auth = { type: 'bearer', token: bearer[1].trim() };
      headers.splice(authIdx, 1);
    } else if (basic) {
      const decoded = decodeBase64(basic[1]);
      if (decoded !== undefined && decoded.includes(':')) {
        const c = decoded.indexOf(':');
        auth = { type: 'basic', username: decoded.slice(0, c), password: decoded.slice(c + 1) };
        headers.splice(authIdx, 1);
      }
    }
  }

  // ---- method
  let finalMethod: string;
  if (method) finalMethod = method;
  else if (head) finalMethod = 'HEAD';
  else if (useGet) finalMethod = 'GET';
  else if (uploadFile !== undefined) finalMethod = 'PUT';
  else if (body.type !== 'none') finalMethod = 'POST';
  else finalMethod = 'GET';
  if (!(HTTP_METHODS as readonly string[]).includes(finalMethod)) {
    throw new CurlParseError(
      `Unsupported HTTP method "${finalMethod}". Supported: ${HTTP_METHODS.join(', ')}.`,
    );
  }

  return {
    name: suggestName(finalMethod, url),
    method: finalMethod as HttpMethod,
    url,
    params,
    headers,
    auth,
    body,
  };
}

const KNOWN_LONG_BOOL = new Set([
  'compressed', 'location', 'location-trusted', 'insecure', 'silent', 'show-error', 'verbose',
  'include', 'fail', 'fail-with-body', 'globoff', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge',
  'http3', 'http3-only', 'ipv4', 'ipv6', 'remote-name', 'remote-name-all', 'remote-header-name',
  'progress-bar', 'no-progress-meter', 'raw', 'tr-encoding', 'tcp-nodelay', 'tcp-fastopen', 'ssl',
  'ssl-reqd', 'tlsv1', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'sslv2', 'sslv3', 'basic', 'digest',
  'ntlm', 'negotiate', 'anyauth', 'path-as-is', 'retry-connrefused', 'retry-all-errors', 'junk-session-cookies',
  'parallel', 'parallel-immediate', 'create-dirs', 'disable', 'disable-eprt', 'disable-epsv', 'list-only',
  'append', 'crlf', 'use-ascii', 'netrc', 'netrc-optional', 'proxy-insecure', 'proxytunnel', 'post301',
  'post302', 'post303', 'styled-output', 'suppress-connect-headers', 'xattr', 'manual', 'help', 'version',
  'ca-native', 'ssl-no-revoke', 'ssl-allow-beast', 'ssl-auto-client-cert', 'cert-status', 'false-start',
  'ignore-content-length', 'skip-existing', 'remove-on-error', 'fail-early', 'next', 'trace-time',
  'trace-ids', 'doh-insecure', 'doh-cert-status', 'sasl-ir', 'haproxy-protocol', 'socks5-basic',
  'socks5-gssapi', 'socks5-gssapi-nec', 'proxy-basic', 'proxy-digest', 'proxy-ntlm', 'proxy-negotiate',
  'proxy-anyauth', 'mail-rcpt-allowfails', 'metalink', 'q', 'disallow-username-in-url',
]);

function hasLaterUrl(tokens: { value: string; op?: boolean }[], from: number): boolean {
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].op) return false;
    if (!tokens[i].value.startsWith('-') && looksLikeUrl(tokens[i].value)) return true;
  }
  return false;
}

/** Encode one --data-urlencode argument into its wire form. */
function encodeDataUrlencode(arg: string): string {
  const eq = arg.indexOf('=');
  if (eq !== -1) {
    const name = arg.slice(0, eq);
    const content = curlUrlEncode(arg.slice(eq + 1));
    return name === '' ? content : `${name}=${content}`;
  }
  const at = arg.indexOf('@');
  if (at !== -1) {
    // name@file: file content can't be read here; keep a reference as the value
    const name = arg.slice(0, at);
    const file = arg.slice(at + 1);
    return name === '' ? curlUrlEncode('@' + file) : `${name}=${curlUrlEncode('@' + file)}`;
  }
  return curlUrlEncode(arg);
}
