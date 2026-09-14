import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedRequest } from '../../shared/model';
import type { WsEvent, WsStatus } from '../../shared/protocol';
import { handshakeHeaders, toWebSocketUrl, WsSession } from './wsClient';

// Minimal RFC 6455 echo server: small unfragmented frames only, enough for the client under test.
let server: Server;
let port: number;
const sockets = new Set<Socket>();

function frame(opcode: number, payload: Buffer): Buffer {
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

function onUpgrade(req: IncomingMessage, socket: Socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  if (req.url === '/reject') {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  const protocol = req.headers['sec-websocket-protocol']?.split(',')[0]?.trim();
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      'X-Test: yes',
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
      '',
      '',
    ].join('\r\n'),
  );
  // Greet with the auth header the client sent, so the test can check handshake headers.
  socket.write(frame(0x1, Buffer.from(`auth=${req.headers.authorization ?? ''}`)));
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 6) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        len = buf.readUInt16BE(2);
        offset = 4;
      }
      if (buf.length < offset + 4 + len) return;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ mask[i % 4];
      buf = buf.subarray(offset + 4 + len);
      if (opcode === 0x8) {
        socket.end(frame(0x8, payload));
        return;
      }
      socket.write(frame(opcode, payload));
    }
  });
}

beforeAll(async () => {
  server = createServer((_req, res) => res.end('not a websocket'));
  server.on('upgrade', onUpgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const request = (path: string, headers: ResolvedRequest['headers'] = []): ResolvedRequest => ({
  method: 'GET',
  url: `http://127.0.0.1:${port}${path}`,
  headers,
  body: { type: 'none' },
});

/** Collects session output and resolves waits on it. */
function recorder() {
  const events: WsEvent[] = [];
  let status: WsStatus = 'idle';
  const waiters: (() => void)[] = [];
  const session = new WsSession((evs, s) => {
    events.push(...evs);
    status = s;
    for (const w of waiters.splice(0)) w();
  });
  const until = (pred: () => boolean, timeoutMs = 3000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; events: ${JSON.stringify(events)}`)), timeoutMs);
      const check = () => {
        if (pred()) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  return { session, events, until, status: () => status };
}

const options = { timeoutMs: 5000, rejectUnauthorized: true };

describe('toWebSocketUrl', () => {
  it('maps http(s) to ws(s) and adds a missing scheme', () => {
    expect(toWebSocketUrl('https://x.test/a')).toBe('wss://x.test/a');
    expect(toWebSocketUrl('http://x.test')).toBe('ws://x.test');
    expect(toWebSocketUrl(' wss://x.test ')).toBe('wss://x.test');
    expect(toWebSocketUrl('localhost:8080/ws')).toBe('ws://localhost:8080/ws');
  });
});

describe('handshakeHeaders', () => {
  it('drops headers the client manages and turns Sec-WebSocket-Protocol into subprotocols', () => {
    expect(
      handshakeHeaders([
        { key: 'Authorization', value: 'Bearer t' },
        { key: 'Connection', value: 'keep-alive' },
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Sec-WebSocket-Protocol', value: 'chat, v2' },
      ]),
    ).toEqual({ headers: { Authorization: 'Bearer t' }, protocols: ['chat', 'v2'] });
  });
});

describe('WsSession', () => {
  it('connects with headers, echoes messages and closes cleanly', async () => {
    const r = recorder();
    r.session.connect(request('/echo', [{ key: 'Authorization', value: 'Bearer abc' }, { key: 'Sec-WebSocket-Protocol', value: 'chat' }]), options);
    expect(r.status()).toBe('connecting');
    await r.until(() => r.status() === 'open');
    const open = r.events.find((e) => e.kind === 'open');
    expect(open).toMatchObject({ protocol: 'chat' });
    expect(open?.kind === 'open' && open.headers.some(([k, v]) => k.toLowerCase() === 'x-test' && v === 'yes')).toBe(true);

    await r.until(() => r.events.some((e) => e.kind === 'received'));
    expect(r.events.find((e) => e.kind === 'received')).toMatchObject({ data: 'auth=Bearer abc' });

    expect(r.session.send('{"hello":"world"}')).toBe(true);
    await r.until(() => r.events.filter((e) => e.kind === 'received').length === 2);
    expect(r.events.filter((e) => e.kind === 'sent')).toMatchObject([{ data: '{"hello":"world"}', size: 17 }]);
    expect(r.events.filter((e) => e.kind === 'received')[1]).toMatchObject({ data: '{"hello":"world"}' });

    r.session.close();
    await r.until(() => r.status() === 'idle');
    expect(r.events.at(-1)).toMatchObject({ kind: 'closed', code: 1000 });
    expect(r.session.send('late')).toBe(false);
  });

  it('reports a rejected handshake and ends idle', async () => {
    const r = recorder();
    r.session.connect(request('/reject'), options);
    await r.until(() => r.status() === 'idle' && r.events.some((e) => e.kind === 'closed'));
    expect(r.events.some((e) => e.kind === 'error')).toBe(true);
    expect(r.events.some((e) => e.kind === 'open')).toBe(false);
  });

  it('reports a refused connection', async () => {
    const r = recorder();
    r.session.connect({ ...request('/'), url: 'ws://127.0.0.1:1/' }, options);
    await r.until(() => r.status() === 'idle' && r.events.some((e) => e.kind === 'closed'));
    expect(r.events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('cancels a pending handshake', async () => {
    const r = recorder();
    r.session.connect(request('/echo'), options);
    r.session.close();
    expect(r.status()).toBe('idle');
    expect(r.events.at(-1)).toMatchObject({ kind: 'closed', reason: 'Cancelled' });
  });
});
