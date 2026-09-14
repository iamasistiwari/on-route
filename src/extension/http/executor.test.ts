import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedRequest } from '../../shared/model';
import { executeRequest, HttpExecuteError, MAX_BASE64_BYTES, MAX_BODY_BYTES, type ExecuteOptions } from './executor';

let server: Server;
let base: string;
let dir: string;

const readAll = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'on-route-exec-'));
  writeFileSync(join(dir, 'hello.txt'), 'hello file');
  writeFileSync(join(dir, 'data.bin'), Buffer.from([0, 1, 2, 255, 254]));

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readAll(req);
    switch (url.pathname) {
      case '/json':
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Set-Cookie', ['a=1', 'b=2']);
        res.end(JSON.stringify({ ok: true, q: url.searchParams.get('q') }));
        return;
      case '/echo':
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            method: req.method,
            contentType: req.headers['content-type'] ?? null,
            auth: req.headers.authorization ?? null,
            body: body.toString('utf8'),
            bodyHex: body.toString('hex'),
          }),
        );
        return;
      case '/redirect':
        res.statusCode = 302;
        res.setHeader('Location', '/json');
        res.end();
        return;
      case '/slow':
        setTimeout(() => res.end('late'), 2000).unref();
        return;
      case '/binary':
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]));
        return;
      case '/plain-utf8':
        res.end('héllo'); // no content-type, valid utf-8
        return;
      default:
        res.statusCode = 404;
        res.statusMessage = 'Nope';
        res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const opts = (over: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
  timeoutMs: 5000,
  rejectUnauthorized: true,
  followRedirects: true,
  workspaceRoot: dir,
  ...over,
});

const get = (path: string): ResolvedRequest => ({ method: 'GET', url: base + path, headers: [], body: { type: 'none' } });

async function expectError(p: Promise<unknown>): Promise<HttpExecuteError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpExecuteError);
    return e as HttpExecuteError;
  }
  throw new Error('expected rejection');
}

describe('executeRequest', () => {
  it('GET json with headers list, size and timing', async () => {
    const res = await executeRequest(get('/json?q=hi'), opts());
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.bodyEncoding).toBe('utf8');
    expect(JSON.parse(res.body)).toEqual({ ok: true, q: 'hi' });
    expect(res.contentType).toBe('application/json');
    expect(res.size).toBe(Buffer.byteLength(res.body));
    expect(res.timing.totalMs).toBeGreaterThan(0);
    expect(res.timing.ttfbMs).toBeGreaterThan(0);
    expect(res.timing.ttfbMs!).toBeLessThanOrEqual(res.timing.totalMs);
    expect(res.headers).toContainEqual(['content-type', 'application/json']);
    expect(res.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v)).toEqual(['a=1', 'b=2']);
    expect(res.truncated).toBeUndefined();
  });

  it('non-2xx is a response, not an error', async () => {
    const res = await executeRequest(get('/missing'), opts());
    expect(res.status).toBe(404);
    expect(res.statusText).toBe('Nope');
    expect(res.body).toBe('not found');
  });

  it('POST json echo with headers', async () => {
    const res = await executeRequest(
      {
        method: 'POST',
        url: `${base}/echo`,
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer t' },
        ],
        body: { type: 'text', content: '{"a":"ü"}', contentType: 'application/json' },
      },
      opts(),
    );
    const echo = JSON.parse(res.body);
    expect(echo).toMatchObject({ method: 'POST', contentType: 'application/json', auth: 'Bearer t', body: '{"a":"ü"}' });
  });

  it('urlencoded body', async () => {
    const res = await executeRequest(
      {
        method: 'POST',
        url: `${base}/echo`,
        headers: [],
        body: { type: 'urlencoded', fields: [{ key: 'a b', value: 'c&d' }, { key: 'x', value: '1' }] },
      },
      opts(),
    );
    const echo = JSON.parse(res.body);
    expect(echo.contentType).toBe('application/x-www-form-urlencoded');
    expect(echo.body).toBe('a+b=c%26d&x=1');
  });

  it('multipart form with a file; user content-type is replaced by boundary', async () => {
    const res = await executeRequest(
      {
        method: 'POST',
        url: `${base}/echo`,
        headers: [{ key: 'Content-Type', value: 'multipart/form-data' }],
        body: {
          type: 'form',
          fields: [
            { key: 'name', value: 'rex', kind: 'text' },
            { key: 'doc', value: 'hello.txt', kind: 'file' },
          ],
        },
      },
      opts(),
    );
    const echo = JSON.parse(res.body);
    expect(echo.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(echo.body).toContain('name="name"');
    expect(echo.body).toContain('rex');
    expect(echo.body).toContain('filename="hello.txt"');
    expect(echo.body).toContain('hello file');
  });

  it('form with a missing file => readable error', async () => {
    const err = await expectError(
      executeRequest(
        { method: 'POST', url: `${base}/echo`, headers: [], body: { type: 'form', fields: [{ key: 'f', value: 'nope.txt', kind: 'file' }] } },
        opts(),
      ),
    );
    expect(err.info.message).toContain('nope.txt');
    expect(err.info.code).toBe('ENOENT');
  });

  it('binary body from file', async () => {
    const res = await executeRequest(
      { method: 'PUT', url: `${base}/echo`, headers: [], body: { type: 'binary', filePath: 'data.bin' } },
      opts(),
    );
    const echo = JSON.parse(res.body);
    expect(echo.bodyHex).toBe('000102fffe');
    expect(echo.contentType).toBe('application/octet-stream');
  });

  it('follows redirects when enabled', async () => {
    const res = await executeRequest(get('/redirect'), opts({ followRedirects: true }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('does not follow redirects when disabled', async () => {
    const res = await executeRequest(get('/redirect'), opts({ followRedirects: false }));
    expect(res.status).toBe(302);
    expect(res.headers).toContainEqual(['location', '/json']);
  });

  it('timeout => TIMEOUT', async () => {
    const err = await expectError(executeRequest(get('/slow'), opts({ timeoutMs: 100 })));
    expect(err.info.code).toBe('TIMEOUT');
    expect(err.info.timing.totalMs).toBeGreaterThanOrEqual(90);
  });

  it('abort => ABORTED', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const err = await expectError(executeRequest(get('/slow'), opts({ signal: ac.signal })));
    expect(err.info.code).toBe('ABORTED');
  });

  it('already-aborted signal => ABORTED', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await expectError(executeRequest(get('/json'), opts({ signal: ac.signal })));
    expect(err.info.code).toBe('ABORTED');
  });

  it('connection refused => ECONNREFUSED with readable message', async () => {
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(r));
    const err = await expectError(executeRequest({ ...get(''), url: `http://127.0.0.1:${port}/` }, opts()));
    expect(err.info.code).toBe('ECONNREFUSED');
    expect(err.info.message).toBe('Connection refused (is the server running?)');
    expect(typeof err.info.timing.totalMs).toBe('number');
  });

  it('binary response => base64', async () => {
    const res = await executeRequest(get('/binary'), opts());
    expect(res.bodyEncoding).toBe('base64');
    expect(Buffer.from(res.body, 'base64')).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]));
    expect(res.size).toBe(5);
  });

  it('valid utf-8 without content-type => utf8', async () => {
    const res = await executeRequest(get('/plain-utf8'), opts());
    expect(res.bodyEncoding).toBe('utf8');
    expect(res.body).toBe('héllo');
  });
});

describe('body size caps', () => {
  // V8 refuses to build a string longer than this, and every body becomes one before it can be shown.
  const V8_MAX_STRING = 0x1fffffe8;

  it('keeps UTF-8 bodies inside the string limit, just under 512 MB', () => {
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(V8_MAX_STRING);
    expect(MAX_BODY_BYTES).toBeGreaterThan(511 * 1024 * 1024);
  });

  it('keeps base64 of a binary body inside the string limit', () => {
    expect(Math.ceil(MAX_BASE64_BYTES / 3) * 4).toBeLessThanOrEqual(V8_MAX_STRING);
    expect(MAX_BASE64_BYTES).toBeLessThan(MAX_BODY_BYTES);
  });
});
