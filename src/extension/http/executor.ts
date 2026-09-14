// OWNER: agent "core-logic". Pure Node (undici), no `vscode` import.
import { createReadStream, openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { Agent, FormData, interceptors, request, type Dispatcher } from 'undici';
import type { HttpErrorInfo, HttpResponse, ResolvedRequest } from '../../shared/model';

export interface ExecuteOptions {
  timeoutMs: number; // 0 = none
  rejectUnauthorized: boolean;
  followRedirects: boolean;
  signal?: AbortSignal;
  /** Base dir for resolving relative file paths in form/binary bodies. */
  workspaceRoot: string;
}

export class HttpExecuteError extends Error {
  constructor(readonly info: HttpErrorInfo) {
    super(info.message);
  }
}

/** V8 refuses to allocate a string longer than this, and every body becomes a string to be shown. */
const MAX_STRING_LENGTH = 0x1fffffe8;

/** Response bytes kept: ~512 MB, the most UTF-8 text that can become a string (ASCII is the worst case). */
export const MAX_BODY_BYTES = MAX_STRING_LENGTH;

/**
 * Base64 costs 4 characters per 3 bytes, so binary hits the same cap at three quarters: ~384 MB.
 * Binary bodies are cut off here rather than throwing on toString().
 */
export const MAX_BASE64_BYTES = Math.floor(MAX_STRING_LENGTH / 4) * 3;

const MAX_REDIRECTS = 10;

const ERROR_MESSAGES: Record<string, string> = {
  ECONNREFUSED: 'Connection refused (is the server running?)',
  ENOTFOUND: 'Host not found (DNS lookup failed)',
  EAI_AGAIN: 'DNS lookup timed out (temporary failure)',
  ECONNRESET: 'Connection reset by server',
  EPIPE: 'Connection closed unexpectedly',
  ETIMEDOUT: 'Connection timed out',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  CERT_HAS_EXPIRED: 'TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate (disable certificate verification to allow)',
  SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed certificate in chain (disable certificate verification to allow)',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Unable to verify TLS certificate',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Unable to verify TLS certificate issuer',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host name',
  EPROTO: 'TLS/protocol error',
  UND_ERR_CONNECT_TIMEOUT: 'Connection timed out',
  UND_ERR_HEADERS_TIMEOUT: 'Timed out waiting for response headers',
  UND_ERR_BODY_TIMEOUT: 'Timed out reading response body',
  UND_ERR_SOCKET: 'Socket error (connection closed by server)',
  UND_ERR_MAX_REDIRECTIONS: 'Too many redirects',
  ERR_INVALID_URL: 'Invalid URL',
  UND_ERR_INVALID_ARG: 'Invalid request',
  ENOENT: 'File not found',
};

const TEXT_TYPE_RE = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html/i;
/**
 * Types that are bytes even when they happen to decode as UTF-8 (a PDF is mostly ASCII, and showing it as
 * text is useless). Checked after TEXT_TYPE_RE, so `image/svg+xml` still comes through as text.
 */
const BINARY_TYPE_RE = /^(image|audio|video|font)\/|^application\/(pdf|ogg|mp4|zip|gzip|wasm|x-tar|x-7z-compressed|x-rar-compressed|octet-stream)/i;

/** Find the most specific error code in an error / its cause chain / AggregateError members. */
function findCode(err: unknown, depth = 0): { code?: string; message?: string } {
  if (!err || typeof err !== 'object' || depth > 5) return {};
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  const fromCause = findCode(e.cause, depth + 1);
  if (fromCause.code && ERROR_MESSAGES[fromCause.code]) return fromCause;
  if (Array.isArray(e.errors)) {
    for (const sub of e.errors) {
      const s = findCode(sub, depth + 1);
      if (s.code) return s;
    }
  }
  if (typeof e.code === 'string') return { code: e.code, message: typeof e.message === 'string' ? e.message : undefined };
  if (fromCause.code) return fromCause;
  return { message: typeof e.message === 'string' ? e.message : undefined };
}

/** Human readable message for a network error (known codes mapped, e.g. ECONNREFUSED). */
export function readableError(err: unknown): string {
  const { code, message } = findCode(err);
  return (code && ERROR_MESSAGES[code]) || message || String(err);
}

function toExecuteError(err: unknown, started: number, extra?: string): HttpExecuteError {
  const { code } = findCode(err);
  const readable = readableError(err);
  return new HttpExecuteError({
    message: extra ? `${readable}: ${extra}` : readable,
    code,
    timing: { totalMs: elapsed(started) },
  });
}

const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;

async function buildBody(
  req: ResolvedRequest,
  root: string,
): Promise<{ body?: string | FormData | Readable; dropContentType?: boolean; defaultContentType?: string }> {
  const b = req.body;
  switch (b.type) {
    case 'text':
      return { body: b.content, defaultContentType: b.contentType };
    case 'urlencoded': {
      const usp = new URLSearchParams();
      for (const f of b.fields) usp.append(f.key, f.value);
      return { body: usp.toString(), defaultContentType: 'application/x-www-form-urlencoded' };
    }
    case 'form': {
      const fd = new FormData();
      for (const f of b.fields) {
        if (f.kind === 'file') {
          const abs = path.resolve(root, f.value);
          const blob = await openFile(abs, f.value);
          fd.append(f.key, blob, path.basename(abs));
        } else {
          fd.append(f.key, f.value);
        }
      }
      // multipart boundary must come from the FormData encoder
      return { body: fd, dropContentType: true };
    }
    case 'binary': {
      const abs = path.resolve(root, b.filePath);
      await statFile(abs, b.filePath);
      return { body: createReadStream(abs), defaultContentType: 'application/octet-stream' };
    }
    default:
      return {};
  }
}

class FileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function statFile(abs: string, display: string) {
  try {
    const s = await stat(abs);
    if (!s.isFile()) throw new FileError('ENOENT', `Not a file: ${display}`);
  } catch (e) {
    if (e instanceof FileError) throw e;
    throw new FileError((e as { code?: string }).code ?? 'ENOENT', `File not found: ${display}`);
  }
}

async function openFile(abs: string, display: string) {
  await statFile(abs, display);
  return openAsBlob(abs);
}

function headersList(h: Record<string, string | string[] | undefined>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.push([k, item]);
    else out.push([k, v]);
  }
  return out;
}

/**
 * Send with undici `request` (Agent with connect.rejectUnauthorized; redirect interceptor when
 * followRedirects, max 10). Measures totalMs and ttfbMs. Body: text => string; urlencoded =>
 * URLSearchParams; form => FormData (files via fs openAsBlob); binary => file stream.
 * Response body: utf8 if content-type is text-ish/json/xml/js or bytes are valid UTF-8, else base64.
 * Bodies over MAX_BODY_BYTES truncated (MAX_BASE64_BYTES for binary). Abort/timeout => HttpExecuteError code 'ABORTED' / 'TIMEOUT';
 * network errors => code from error (ECONNREFUSED, ENOTFOUND, CERT_*...) with readable message.
 */
export async function executeRequest(req: ResolvedRequest, opts: ExecuteOptions): Promise<HttpResponse> {
  const started = performance.now();

  if (opts.signal?.aborted) {
    throw new HttpExecuteError({ message: 'Request cancelled', code: 'ABORTED', timing: { totalMs: 0 } });
  }

  let built: Awaited<ReturnType<typeof buildBody>>;
  try {
    built = await buildBody(req, opts.workspaceRoot);
  } catch (e) {
    if (e instanceof FileError) {
      throw new HttpExecuteError({ message: e.message, code: e.code, timing: { totalMs: elapsed(started) } });
    }
    throw toExecuteError(e, started);
  }

  const headers: string[] = [];
  let hasContentType = false;
  for (const h of req.headers) {
    const isCt = h.key.toLowerCase() === 'content-type';
    if (isCt && built.dropContentType) continue;
    if (isCt) hasContentType = true;
    headers.push(h.key, h.value);
  }
  if (!hasContentType && built.defaultContentType && !built.dropContentType) {
    headers.push('content-type', built.defaultContentType);
  }

  const timeoutSignal = opts.timeoutMs > 0 ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  const signals = [timeoutSignal, opts.signal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  const agent = new Agent({
    connect: { rejectUnauthorized: opts.rejectUnauthorized },
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const dispatcher: Dispatcher = opts.followRedirects
    ? agent.compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }))
    : agent;

  const abortError = (): HttpExecuteError | undefined => {
    const totalMs = elapsed(started);
    if (timeoutSignal?.aborted) {
      return new HttpExecuteError({ message: `Request timed out after ${opts.timeoutMs} ms`, code: 'TIMEOUT', timing: { totalMs } });
    }
    if (opts.signal?.aborted) {
      return new HttpExecuteError({ message: 'Request cancelled', code: 'ABORTED', timing: { totalMs } });
    }
    return undefined;
  };

  try {
    const res = await request(req.url, {
      method: req.method,
      headers,
      body: built.body,
      signal,
      dispatcher,
    });
    const ttfbMs = elapsed(started);

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const stream = res.body;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const remaining = MAX_BODY_BYTES - size;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        size += Math.max(remaining, 0);
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
    if (truncated) stream.destroy();
    const buf = Buffer.concat(chunks);

    // Binary costs four characters per three bytes, so it hits the string cap before MAX_BODY_BYTES does.
    const encodeBase64 = (b: Buffer): string => {
      if (b.length <= MAX_BASE64_BYTES) return b.toString('base64');
      truncated = true;
      return b.subarray(0, MAX_BASE64_BYTES).toString('base64');
    };

    const ctHeader = res.headers['content-type'];
    const contentType = Array.isArray(ctHeader) ? ctHeader[0] : ctHeader;
    let bodyEncoding: 'utf8' | 'base64' = 'utf8';
    let body: string;
    if (buf.length === 0) body = '';
    else if (contentType && TEXT_TYPE_RE.test(contentType)) body = buf.toString('utf8');
    else if (contentType && BINARY_TYPE_RE.test(contentType)) {
      body = encodeBase64(buf);
      bodyEncoding = 'base64';
    } else {
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        // truncation may have split a multi-byte char; that is still fine to show as base64
        body = encodeBase64(buf);
        bodyEncoding = 'base64';
      }
    }

    const response: HttpResponse = {
      status: res.statusCode,
      statusText: res.statusText ?? '',
      headers: headersList(res.headers),
      body,
      bodyEncoding,
      size,
      timing: { totalMs: elapsed(started), ttfbMs },
    };
    if (contentType) response.contentType = contentType;
    if (truncated) response.truncated = true;
    return response;
  } catch (e) {
    throw abortError() ?? toExecuteError(e, started);
  } finally {
    // body is fully consumed (or failed) at this point; tear down sockets so nothing lingers
    agent.destroy().catch(() => undefined);
  }
}
