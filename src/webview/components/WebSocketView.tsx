// WebSocket session log (response pane of a WS request): messages sent / received plus connection events.
import { memo, useMemo, useRef, useState } from 'react';
import type { BodyConfig } from '../../shared/model';
import type { VariableInfo, WsEvent, WsStatus } from '../../shared/protocol';
import { formatDuration, formatJson, formatSize, prettyJson } from '../lib/format';
import { CodeView } from './CodeView';
import { Icon } from './Icon';
import { Tabs } from './Tabs';
import { Button, CopyButton, IconButton, Segmented, Spinner, cx } from './ui';

type LogTab = 'messages' | 'handshake';
type Direction = 'all' | 'sent' | 'received';

const PREVIEW_CHARS = 300;

const STATUS_LABEL: Record<WsStatus, string> = {
  idle: 'Disconnected',
  connecting: 'Connecting…',
  open: 'Connected',
  closing: 'Closing…',
};

function timeOf(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

type MessageEvent = Extract<WsEvent, { kind: 'sent' | 'received' }>;
const isMessage = (e: WsEvent): e is MessageEvent => e.kind === 'sent' || e.kind === 'received';

/** Text shown for a message: base64 payloads are labelled instead of dumped. */
function messageText(e: MessageEvent): string {
  return e.kind === 'received' && e.binary ? `Binary message (${formatSize(e.size)}), base64:\n${e.data}` : e.data;
}

function eventText(e: WsEvent): string {
  switch (e.kind) {
    case 'connecting':
      return `Connecting to ${e.url}`;
    case 'open':
      return `Connected in ${formatDuration(e.ms)}${e.protocol ? ` · protocol ${e.protocol}` : ''}`;
    case 'closed':
      return `Disconnected · code ${e.code}${e.reason ? ` · ${e.reason}` : ''}`;
    case 'error':
      return e.message;
    default:
      return '';
  }
}

export function WsStatusPill({ status }: { status: WsStatus }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
        status === 'open' ? 'bg-success/15 text-success' : status === 'idle' ? 'bg-muted/15 text-muted' : 'bg-warning/15 text-warning',
      )}
    >
      {status === 'open' || status === 'idle' ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : <Spinner className="h-2.5 w-2.5" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

export interface WebSocketViewProps {
  status: WsStatus;
  events: WsEvent[];
  onClear: () => void;
  onCopy: (text: string) => void;
  onDisconnect: () => void;
  fontSize: number;
  /** Label of the send shortcut, for the empty state hint. */
  sendShortcut: string;
}

function WebSocketViewInner({ status, events, onClear, onCopy, onDisconnect, fontSize, sendShortcut }: WebSocketViewProps) {
  const [tab, setTab] = useState<LogTab>('messages');
  const [direction, setDirection] = useState<Direction>('all');
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const messageCount = useMemo(() => events.filter(isMessage).length, [events]);
  const handshake = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'open') return e;
    }
    return undefined;
  }, [events]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return events.filter((e) => {
      if (!isMessage(e)) return direction === 'all' && !q;
      if (direction !== 'all' && e.kind !== direction) return false;
      return !q || e.data.toLowerCase().includes(q);
    });
  }, [events, direction, filter]);

  const selected = useMemo(() => {
    const e = selectedId ? events.find((x) => x.id === selectedId) : undefined;
    return e && isMessage(e) ? e : undefined;
  }, [events, selectedId]);
  const detail = useMemo(() => {
    if (!selected) return null;
    const raw = messageText(selected);
    const pretty = prettyJson(raw);
    return { raw, text: pretty.ok ? pretty.text : raw, json: pretty.ok };
  }, [selected]);

  const items = useMemo(
    () => [
      { id: 'messages' as const, label: 'Messages', badge: messageCount },
      { id: 'handshake' as const, label: 'Handshake', badge: handshake?.headers.length },
    ],
    [messageCount, handshake],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <Tabs
        className="px-3"
        items={items}
        active={tab}
        onChange={setTab}
        right={
          <>
            <WsStatusPill status={status} />
            {status === 'open' && (
              <button type="button" className="rounded-full px-2 py-0.5 text-[11.5px] text-link hover:underline" onClick={onDisconnect}>
                Disconnect
              </button>
            )}
          </>
        }
      />
      {tab === 'handshake' ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {handshake ? (
            handshake.headers.length ? (
              <table className="w-full border-collapse font-mono text-[12px]">
                <tbody>
                  {handshake.headers.map(([k, v], i) => (
                    <tr key={i} className="border-b border-[var(--or-line)] align-top">
                      <td className="w-[35%] py-1 pr-3 text-muted select-text">{k}</td>
                      <td className="py-1 break-all select-text">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-[12px] text-muted">Connected; the server's handshake headers are not available.</div>
            )
          ) : (
            <div className="text-[12px] text-muted">Connect to see the handshake response headers.</div>
          )}
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-muted">
          <div className="text-fg/80">Not connected</div>
          <div className="text-[12px]">
            <kbd className="rounded-full bg-[var(--or-soft-strong)] px-1.5 font-mono">{sendShortcut}</kbd> to connect, then write a message in the Message tab
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3 pb-1.5">
            <Segmented
              options={[
                { value: 'all', label: 'All' },
                { value: 'sent', label: 'Sent' },
                { value: 'received', label: 'Received' },
              ]}
              value={direction}
              onChange={setDirection}
            />
            <input
              aria-label="Filter messages"
              className="ctl is-pill min-w-[120px] flex-1 py-[2px] text-[12px]"
              placeholder="Filter messages"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <IconButton
              icon="trash"
              title="Clear messages"
              onClick={() => {
                setSelectedId(null);
                onClear();
              }}
            />
          </div>
          <ul className="min-h-0 flex-1 overflow-auto border-t border-[var(--or-line)] font-mono text-[12px]" role="list">
            {shown.map((e) =>
              isMessage(e) ? (
                <li key={e.id}>
                  <button
                    type="button"
                    aria-pressed={e.id === selectedId}
                    onClick={() => setSelectedId((id) => (id === e.id ? null : e.id))}
                    className={cx(
                      'flex w-full items-start gap-2 border-b border-[var(--or-line)] px-3 py-1 text-left hover:bg-[var(--or-soft)]',
                      e.id === selectedId && 'bg-[var(--or-soft-strong)]',
                    )}
                  >
                    <span className={cx('mt-[2px] shrink-0', e.kind === 'sent' ? 'text-m-post' : 'text-m-get')} title={e.kind === 'sent' ? 'Sent' : 'Received'}>
                      <Icon name={e.kind === 'sent' ? 'arrowUp' : 'arrowDown'} size={12} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {e.kind === 'received' && e.binary ? <span className="text-muted">Binary message</span> : e.data.slice(0, PREVIEW_CHARS)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted tabular-nums">{formatSize(e.size)}</span>
                    <span className="shrink-0 text-[11px] text-muted tabular-nums">{timeOf(e.at)}</span>
                  </button>
                </li>
              ) : (
                <li
                  key={e.id}
                  className={cx(
                    'flex items-center gap-2 border-b border-[var(--or-line)] px-3 py-1 font-sans text-[11.5px]',
                    e.kind === 'error' ? 'text-error' : e.kind === 'open' ? 'text-success' : 'text-muted',
                  )}
                >
                  <span className="min-w-0 flex-1 break-words select-text">{eventText(e)}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">{timeOf(e.at)}</span>
                </li>
              ),
            )}
          </ul>
          {selected && detail && (
            <div className="flex h-[40%] min-h-[120px] flex-col border-t border-[var(--or-line)]">
              <div className="flex items-center gap-2 px-3 py-1 text-[11.5px] text-muted">
                <span className={selected.kind === 'sent' ? 'text-m-post' : 'text-m-get'}>{selected.kind === 'sent' ? 'Sent' : 'Received'}</span>
                <span className="tabular-nums">{timeOf(selected.at)}</span>
                <span className="tabular-nums">{formatSize(selected.size)}</span>
                <span className="flex-1" />
                <CopyButton text={detail.raw} onCopy={onCopy} title="Copy message" />
                <IconButton icon="x" title="Close" onClick={() => setSelectedId(null)} />
              </div>
              <CodeView className="min-h-0 flex-1" value={detail.text} language={detail.json ? 'json' : 'text'} readOnly wrap fontSize={fontSize} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const WebSocketView = memo(WebSocketViewInner);

/** Message tab of a WS request: the draft message (saved as the request body) and Send. */
export function WsComposer({
  value,
  variables,
  onChange,
  canSend,
  onSend,
  sendShortcut,
}: {
  value: BodyConfig;
  variables: readonly VariableInfo[];
  onChange: (body: BodyConfig) => void;
  canSend: boolean;
  onSend: () => void;
  sendShortcut: string;
}) {
  const format = value.type === 'json' ? 'json' : 'text';
  const content = value.type === 'json' || value.type === 'raw' ? value.content : '';
  const setContent = (next: string) => onChange(format === 'json' ? { type: 'json', content: next } : { type: 'raw', content: next });
  const keys = useMemo(
    () => [
      {
        key: 'Mod-Enter',
        run: () => {
          sendRef.current();
          return true;
        },
      },
    ],
    [],
  );
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: 'text', label: 'Text' },
            { value: 'json', label: 'JSON' },
          ]}
          value={format}
          onChange={(f) => onChange(f === 'json' ? { type: 'json', content } : { type: 'raw', content })}
        />
        {format === 'json' && (
          <Button
            variant="ghost"
            icon="braces"
            className="py-[2px] text-[12px]"
            disabled={formatJson(content) === null}
            onClick={() => {
              const pretty = formatJson(content);
              if (pretty !== null) setContent(pretty);
            }}
          >
            Format
          </Button>
        )}
        <span className="flex-1" />
        <span title={canSend ? `Send message (${sendShortcut})` : 'Connect first'} className="inline-flex">
          <Button variant="primary" icon="send" disabled={!canSend} onClick={onSend}>
            Send message
          </Button>
        </span>
      </div>
      <div className="ctl flex min-h-[140px] flex-1 flex-col p-0">
        <CodeView
          className="min-h-0 flex-1"
          value={content}
          onChange={setContent}
          language={format}
          variables={variables}
          keys={keys}
          history={false}
          placeholder={format === 'json' ? '{ "type": "ping" }' : 'Message to send…'}
        />
      </div>
    </div>
  );
}
