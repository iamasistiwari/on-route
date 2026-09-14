// WebSocket session for WS requests. Pure Node (undici), no `vscode` import.
import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Agent, WebSocket } from 'undici';
import type { ResolvedRequest } from '../../shared/model';
import type { WsEvent, WsStatus } from '../../shared/protocol';
import { readableError } from '../http/executor';

export interface WsOptions {
  /** Handshake timeout; 0 = none. */
  timeoutMs: number;
  rejectUnauthorized: boolean;
}

type WsEventBody = WsEvent extends infer E ? (E extends WsEvent ? Omit<E, 'id' | 'at'> : never) : never;

/** Headers the WebSocket client sets itself; user values would break the handshake. */
const HANDSHAKE_HEADERS = new Set(['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'content-length', 'content-type']);

/** http(s):// -> ws(s)://; a URL without scheme gets ws://. Other schemes are left for the client to reject. */
export function toWebSocketUrl(url: string): string {
  const trimmed = url.trim();
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/^https:\/\//i.test(trimmed)) return `wss://${trimmed.slice(8)}`;
  if (/^http:\/\//i.test(trimmed)) return `ws://${trimmed.slice(7)}`;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return `ws://${trimmed}`;
  return trimmed;
}

/** Splits request headers into handshake headers and subprotocols (from Sec-WebSocket-Protocol). */
export function handshakeHeaders(headers: ResolvedRequest['headers']): { headers: Record<string, string>; protocols: string[] } {
  const out: Record<string, string> = {};
  const protocols: string[] = [];
  for (const h of headers) {
    const key = h.key.trim();
    const lower = key.toLowerCase();
    if (!key || HANDSHAKE_HEADERS.has(lower)) continue;
    if (lower === 'sec-websocket-protocol') {
      protocols.push(...h.value.split(',').map((p) => p.trim()).filter(Boolean));
      continue;
    }
    out[key] = out[key] !== undefined ? `${out[key]}, ${h.value}` : h.value;
  }
  return { headers: out, protocols };
}

function headerPairs(raw: unknown): [string, string][] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2).map(([k, v]) => [String(k), String(v)]);
  if (typeof raw === 'object' && Symbol.iterator in raw) return headerPairs([...(raw as Iterable<unknown>)]);
  if (typeof raw === 'object') return Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
  return [];
}

const OPEN_CHANNEL = 'undici:websocket:open';

/** One connection. Reports every step through `onEvent`; never throws after construction. */
export class WsSession {
  private ws: WebSocket | undefined;
  private dispatcher: Agent | undefined;
  private timer: NodeJS.Timeout | undefined;
  private handshakeHeaders: [string, string][] = [];
  private _status: WsStatus = 'idle';
  private started = 0;
  private closedReported = false;
  /** Opened, but not reported yet: undici publishes the handshake headers right after firing `open`. */
  private openPending = false;

  /** `events` is empty when only the status changed. */
  constructor(private readonly onEvent: (events: WsEvent[], status: WsStatus) => void) {}

  get status(): WsStatus {
    return this._status;
  }

  private emit(body: WsEventBody, status: WsStatus = this._status): void {
    this._status = status;
    this.onEvent([{ id: randomUUID(), at: Date.now(), ...body } as WsEvent], status);
  }

  private readonly onOpenChannel = (message: unknown) => {
    const m = message as { websocket?: unknown; handshakeResponse?: { headers?: unknown } };
    if (m.websocket === this.ws) this.handshakeHeaders = headerPairs(m.handshakeResponse?.headers);
  };

  connect(request: ResolvedRequest, options: WsOptions): void {
    if (this._status !== 'idle') return;
    const url = toWebSocketUrl(request.url);
    this.started = Date.now();
    this.closedReported = false;
    this.handshakeHeaders = [];
    this.emit({ kind: 'connecting', url }, 'connecting');

    const { headers, protocols } = handshakeHeaders(request.headers);
    let ws: WebSocket;
    try {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: options.rejectUnauthorized } });
      subscribe(OPEN_CHANNEL, this.onOpenChannel);
      ws = new WebSocket(url, { headers, protocols, dispatcher: this.dispatcher });
    } catch (e) {
      this.emit({ kind: 'error', message: readableError(e) }, 'idle');
      this.cleanup();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    if (options.timeoutMs > 0) {
      this.timer = setTimeout(() => {
        if (this.ws !== ws || this._status !== 'connecting') return;
        this.emit({ kind: 'error', message: `Connection timed out after ${options.timeoutMs} ms` });
        this.finish(ws, 1006, '', false);
        ws.close();
      }, options.timeoutMs);
    }

    const reportOpen = () => {
      if (!this.openPending || this.ws !== ws) return;
      this.openPending = false;
      this.emit({ kind: 'open', protocol: ws.protocol, headers: this.handshakeHeaders, ms: Date.now() - this.started }, 'open');
    };
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      clearTimeout(this.timer);
      this.openPending = true;
      queueMicrotask(reportOpen);
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      reportOpen();
      const data: unknown = ev.data;
      if (typeof data === 'string') {
        this.emit({ kind: 'received', data, size: Buffer.byteLength(data) });
      } else {
        const buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array));
        this.emit({ kind: 'received', data: buf.toString('base64'), size: buf.length, binary: true });
      }
    });
    ws.addEventListener('error', (ev) => {
      if (this.ws !== ws) return;
      const err = (ev as { error?: unknown }).error;
      const connecting = this._status === 'connecting';
      const message = err ? readableError(err) : (ev as { message?: string }).message || 'WebSocket error';
      this.emit({ kind: 'error', message: connecting && /non-101|network error/i.test(message) ? `Handshake failed: ${message}` : message });
    });
    ws.addEventListener('close', (ev) => this.finish(ws, ev.code, ev.reason, ev.wasClean));
  }

  /** Sends a text message. Returns false when not connected. */
  send(data: string): boolean {
    if (!this.ws || this._status !== 'open') return false;
    try {
      this.ws.send(data);
      this.emit({ kind: 'sent', data, size: Buffer.byteLength(data) });
      return true;
    } catch (e) {
      this.emit({ kind: 'error', message: readableError(e) });
      return false;
    }
  }

  /** Closes the connection (or aborts a pending handshake). */
  close(code = 1000, reason = ''): void {
    const ws = this.ws;
    if (!ws) return;
    if (this._status === 'connecting') {
      this.finish(ws, 1006, 'Cancelled', false);
      ws.close();
      return;
    }
    if (this._status !== 'open') return;
    this._status = 'closing';
    this.onEvent([], 'closing');
    try {
      ws.close(code, reason);
    } catch {
      this.finish(ws, code, reason, false);
    }
  }

  private finish(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    if (this.ws !== ws || this.closedReported) return;
    this.openPending = false;
    this.closedReported = true;
    this.emit({ kind: 'closed', code, reason, wasClean }, 'idle');
    this.cleanup();
  }

  private cleanup(): void {
    clearTimeout(this.timer);
    unsubscribe(OPEN_CHANNEL, this.onOpenChannel);
    this.ws = undefined;
    const d = this.dispatcher;
    this.dispatcher = undefined;
    // Let the close frame flush before tearing the agent down.
    if (d) setTimeout(() => void d.close().catch(() => undefined), 1000).unref?.();
  }

  dispose(): void {
    const ws = this.ws;
    if (ws) {
      this.closedReported = true;
      this.cleanup();
      try {
        ws.close(1001);
      } catch {
        // Already closing.
      }
    }
    this._status = 'idle';
  }
}
