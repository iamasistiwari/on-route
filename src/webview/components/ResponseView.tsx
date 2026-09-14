import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, HttpErrorInfo, RequestMethod, HttpResponse } from '../../shared/model';
import { matchesEndpoint } from '../lib/history';
import {
  bodyLanguage,
  formatDuration,
  formatElapsed,
  formatSize,
  prettyJson,
  relativeTime,
  statusClass,
  statusPhrase,
  type StatusClass,
} from '../lib/format';
import type { DecodedPaste } from '../lib/base64Paste';
import { detectMedia, suggestedFileName, type MediaInfo } from '../lib/media';
import { post } from '../vscode';
import { CodeView, openSearchPanel, type EditorView } from './CodeView';
import { MethodBadge } from './MethodBadge';
import { Tabs } from './Tabs';
import { Icon } from './Icon';
import { Button, CopyButton, IconButton, Spinner, cx } from './ui';

export type ResponseTab = 'body' | 'headers' | 'history';

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

function FontSizePicker({ value, onChange }: { value: number; onChange: (size: number) => void }) {
  const sizes = value && !FONT_SIZES.includes(value) ? [...FONT_SIZES, value].sort((a, b) => a - b) : FONT_SIZES;
  return (
    <label className="relative inline-flex h-6 items-center gap-1 rounded-full pl-1.5 pr-1 text-muted hover:bg-[var(--or-soft-strong)] hover:text-fg" title="Response font size (saved in settings)">
      <Icon name="fontSize" />
      <select
        aria-label="Response font size"
        className="cursor-pointer appearance-none bg-transparent pr-1 text-[11px] text-inherit outline-none"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        <option value={0}>Auto</option>
        {sizes.map((s) => (
          <option key={s} value={s}>
            {s}px
          </option>
        ))}
      </select>
    </label>
  );
}

const STATUS_STYLE: Record<StatusClass, string> = {
  info: 'text-info bg-info/15',
  success: 'text-success bg-success/15',
  redirect: 'text-info bg-info/15',
  'client-error': 'text-warning bg-warning/15',
  'server-error': 'text-error bg-error/15',
  unknown: 'text-muted bg-muted/15',
};

export function StatusPill({ status, statusText, small }: { status: number; statusText?: string; small?: boolean }) {
  const phrase = statusPhrase(status, statusText);
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full',
        small ? 'px-1.5 text-[11px]' : 'px-2 py-0.5 text-[12px]',
        STATUS_STYLE[statusClass(status)],
      )}
      title={phrase ? `${status} ${phrase}` : String(status)}
    >
      <span className="font-mono font-semibold tabular-nums">{status}</span>
      {!small && phrase ? <span className="font-medium opacity-80">{phrase}</span> : null}
    </span>
  );
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tabular-nums">{formatElapsed(now - startedAt)}</span>;
}

/** Blob URL for a base64 body, revoked when the body or the panel goes away. */
function useBlobUrl(base64: string, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let next: string;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      next = URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch {
      setUrl(null);
      return;
    }
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [base64, mime]);
  return url;
}

/**
 * A binary body shown as what it is: pictures, players, or a plain card for bytes we cannot render.
 * Every variant can save the file, and can fall back to the raw base64.
 */
const MediaBody = memo(function MediaBody({
  base64,
  size,
  omitted,
  media,
  url,
}: {
  base64: string;
  size: number;
  /** History kept the headers but not the bytes; the file was too large to store whole. */
  omitted?: boolean;
  media: MediaInfo;
  /** Where the bytes came from, if anywhere; names the file when saving. */
  url?: string;
}) {
  const [raw, setRaw] = useState(false);
  /** The player could not decode these bytes; with a cut-off body that is the usual outcome. */
  const [undecodable, setUndecodable] = useState(false);
  const blob = useBlobUrl(base64, media.mime);
  useEffect(() => setUndecodable(false), [blob]);
  const fileName = suggestedFileName(url, media.mime);
  const save = useCallback(() => post({ type: 'saveResponseBody', base64, fileName }), [base64, fileName]);

  if (omitted) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted">
        <Icon name="file" size={22} />
        <span className="text-fg/80">
          {media.mime} · {formatSize(size)}
        </span>
        <span className="max-w-[46ch] text-[12px]">
          History keeps the headers of a file this size, not the file itself. Send the request again to view or save it.
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-1 text-[12px]">
        <span className="font-mono text-muted">{media.mime}</span>
        <span className="text-muted">· {formatSize(size)}</span>
        <div className="flex-1" />
        <button
          type="button"
          className="rounded-full px-2.5 py-0.5 text-muted hover:bg-[var(--or-soft-strong)] hover:text-fg"
          onClick={() => setRaw((r) => !r)}
        >
          {raw ? 'Preview' : 'Raw'}
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-full bg-info/15 py-0.5 pl-2 pr-2.5 font-medium text-info transition-colors hover:bg-info/25"
          title={`Save as ${fileName}`}
          onClick={save}
        >
          <Icon name="arrowDown" size={13} />
          Download
        </button>
      </div>
      {raw ? (
        <CodeView className="flex-1" value={base64} readOnly wrap language="text" />
      ) : !blob ? (
        <div className="p-3 text-muted">Body is not valid base64.</div>
      ) : media.kind === 'image' ? (
        <div className="flex-1 overflow-auto p-3">
          <img alt="Response" className="max-w-full rounded-lg border border-[var(--or-line)]" src={blob} />
        </div>
      ) : undecodable ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted">
          <Icon name="warning" size={20} className="text-warning" />
          <span className="text-fg/80">This {media.kind} cannot be played</span>
          <span className="max-w-[46ch] text-[12px]">The bytes are not a file this player can decode.</span>
          <Button variant="secondary" icon="arrowDown" onClick={save}>
            Save as {fileName}
          </Button>
        </div>
      ) : media.kind === 'audio' ? (
        <div className="p-3">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a response body has no caption track */}
          <audio className="media-player w-full" controls src={blob} onError={() => setUndecodable(true)} />
        </div>
      ) : media.kind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-start justify-center p-3">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a response body has no caption track */}
          <video
            className="media-player max-h-full max-w-full rounded-lg border border-[var(--or-line)]"
            controls
            src={blob}
            onError={() => setUndecodable(true)}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3 text-muted">
          <Icon name="file" size={22} />
          <span>
            {media.kind === 'pdf' ? 'PDF' : 'Binary'}, {size.toLocaleString()} bytes
          </span>
          <Button variant="secondary" icon="arrowDown" onClick={save}>
            Save as {fileName}
          </Button>
        </div>
      )}
    </div>
  );
});

const ResponseBody = memo(function ResponseBody({
  response,
  url,
  onCopy,
  fontSize,
  onFontSizeChange,
}: {
  response: HttpResponse;
  /** Request URL; its extension names the type when the server sends none. */
  url: string | undefined;
  onCopy: (t: string) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
}) {
  const [raw, setRaw] = useState(false);
  const [wrap, setWrap] = useState(true);
  const lang = bodyLanguage(response.contentType, response.bodyEncoding === 'utf8' ? response.body : '');
  const binary = response.bodyEncoding === 'base64';
  const media = useMemo(() => (binary ? detectMedia(response.contentType, url, response.body) : null), [binary, response.contentType, url, response.body]);
  const pretty = useMemo(() => (lang === 'json' ? prettyJson(response.body) : { text: response.body, ok: false }), [lang, response.body]);
  const viewRef = useRef<EditorView | null>(null);
  const onView = useCallback((v: EditorView) => {
    viewRef.current = v;
  }, []);
  if (media) return <MediaBody base64={response.body} size={response.size} omitted={response.bodyOmitted} media={media} url={url} />;
  if (response.body === '') return <div className="p-3 text-muted">Empty response body</div>;

  const shown = raw ? response.body : pretty.text;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 py-1 text-[12px]">
        {lang === 'json' && pretty.ok && (
          <button
            type="button"
            className="rounded-full px-2.5 py-0.5 text-muted hover:bg-[var(--or-soft-strong)] hover:text-fg"
            onClick={() => setRaw((r) => !r)}
          >
            {raw ? 'Pretty' : 'Raw'}
          </button>
        )}
        <span className="text-muted">{lang.toUpperCase()}</span>
        {response.truncated && <span className="text-warning">· truncated</span>}
        <div className="flex-1" />
        <IconButton
          icon="search"
          title="Find in body"
          onClick={() => viewRef.current && openSearchPanel(viewRef.current)}
        />
        <FontSizePicker value={fontSize} onChange={onFontSizeChange} />
        <IconButton icon="wrap" title="Toggle word wrap" active={wrap} onClick={() => setWrap((w) => !w)} />
        <CopyButton title="Copy body" text={shown} onCopy={onCopy} />
      </div>
      <CodeView
        className="flex-1"
        value={shown}
        readOnly
        wrap={wrap}
        language={raw ? 'text' : lang}
        onView={onView}
        fontSize={fontSize}
        copyValues
        holdToCopy
      />
    </div>
  );
});

interface ErrorKind {
  title: string;
  hint: string;
  icon: 'warning' | 'plug' | 'lock' | 'search' | 'file' | 'history' | 'x';
  tone: 'error' | 'warning' | 'muted';
}

function describeError(code: string | undefined): ErrorKind {
  switch (code) {
    case 'ABORTED':
      return { title: 'Request cancelled', hint: 'You stopped this request before the server replied.', icon: 'x', tone: 'muted' };
    case 'TIMEOUT':
      return {
        title: 'Request timed out',
        hint: 'The onRoute.timeoutMs setting stopped waiting. Set it to 0 to wait until the server responds.',
        icon: 'history',
        tone: 'warning',
      };
    case 'ECONNREFUSED':
      return { title: 'Connection refused', hint: 'Nothing is listening at this address. Is the server running and the port correct?', icon: 'plug', tone: 'error' };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { title: 'Host not found', hint: 'Check the hostname for typos, your network connection, or the active environment variables.', icon: 'search', tone: 'error' };
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return { title: 'Connection dropped', hint: 'The server closed the connection before sending a full response.', icon: 'plug', tone: 'error' };
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { title: 'Server unreachable', hint: 'Could not open a connection. Check the host, VPN, firewall, or network.', icon: 'plug', tone: 'error' };
    case 'ENOENT':
      return { title: 'File not found', hint: 'A file referenced in the request body does not exist.', icon: 'file', tone: 'error' };
    case 'ERR_INVALID_URL':
      return { title: 'Invalid URL', hint: 'Make sure the URL includes a scheme (http:// or https://) and all variables resolve.', icon: 'warning', tone: 'error' };
    default:
      if (code && (code.startsWith('CERT_') || code.includes('CERT') || code.includes('TLS') || code === 'EPROTO')) {
        return { title: 'TLS / certificate problem', hint: 'The secure connection failed. For local or self-signed servers, disable onRoute.rejectUnauthorized.', icon: 'lock', tone: 'error' };
      }
      return { title: 'Could not get a response', hint: 'The request failed before the server replied.', icon: 'warning', tone: 'error' };
  }
}

const TONE_STYLE: Record<ErrorKind['tone'], { ring: string; text: string }> = {
  error: { ring: 'bg-error/15 text-error', text: 'text-error' },
  warning: { ring: 'bg-warning/15 text-warning', text: 'text-warning' },
  muted: { ring: 'bg-[var(--or-soft-strong)] text-muted', text: 'text-fg' },
};

function ErrorPanel({
  error,
  url,
  onRetry,
  onCopy,
}: {
  error: NonNullable<HistoryEntry['error']>;
  url: string;
  onRetry?: () => void;
  onCopy: (t: string) => void;
}) {
  const kind = describeError(error.code);
  const tone = TONE_STYLE[kind.tone];
  const details = [error.message, error.code && `Code: ${error.code}`, `URL: ${url}`].filter(Boolean).join('\n');
  return (
    <div className="flex flex-1 items-center justify-center overflow-auto p-4">
      <div className="w-full max-w-[520px] rounded-xl border border-[var(--or-line)] bg-[var(--or-soft)] p-5">
        <div className="flex items-start gap-3">
          <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', tone.ring)}>
            <Icon name={kind.icon} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={cx('text-[14px] font-semibold', tone.text)}>{kind.title}</div>
            <div className="mt-0.5 text-[12px] text-muted">{kind.hint}</div>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-[var(--or-line)] bg-bg px-3 py-2">
          <div className="font-mono text-[12px] break-words select-text">{error.message}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted select-text" title={url}>
            {url}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {error.code && <span className="rounded-full bg-[var(--or-soft-strong)] px-2 py-0.5 font-mono">{error.code}</span>}
          <span className="font-mono tabular-nums">after {formatDuration(error.timing.totalMs)}</span>
          <div className="flex-1" />
          <CopyButton title="Copy error details" text={details} onCopy={onCopy} />
          {onRetry && (
            <Button variant="secondary" icon="send" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function HeadersTable({ headers }: { headers: [string, string][] }) {
  if (headers.length === 0) return <div className="p-3 text-muted">No headers</div>;
  return (
    <div className="overflow-auto p-2">
      <table className="kv-table w-full font-mono text-[12px]">
        <tbody>
          {headers.map(([k, v], i) => (
            <tr key={i}>
              <td className="w-[35%] px-2 py-1 align-top text-muted break-all">{k}</td>
              <td className="px-2 py-1 break-all select-text">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryList({
  history,
  hiddenCount,
  showAll,
  onToggleShowAll,
  selectedId,
  onSelect,
  onClear,
}: {
  history: HistoryEntry[];
  /** Entries of this request sent to a different method / URL, hidden unless showAll. */
  hiddenCount: number;
  showAll: boolean;
  onToggleShowAll: () => void;
  selectedId: string | null;
  onSelect: (e: HistoryEntry) => void;
  onClear: () => void;
}) {
  const toggle =
    hiddenCount > 0 || showAll ? (
      <button type="button" className="text-link hover:underline" onClick={onToggleShowAll}>
        {showAll ? 'Only this URL' : `Show ${hiddenCount} from other URLs`}
      </button>
    ) : null;
  if (history.length === 0) {
    return (
      <div className="flex flex-col gap-1 p-3 text-muted">
        <span>No history for this {hiddenCount > 0 ? 'method and URL' : 'request'} yet. Responses you receive are kept here.</span>
        {toggle && <span className="text-[12px]">{toggle}</span>}
      </div>
    );
  }
  const now = Date.now();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-2 py-1 text-[12px] text-muted">
        <span>
          {history.length} {history.length === 1 ? 'response' : 'responses'}
          {!showAll && hiddenCount > 0 ? ' for this URL' : ''}
        </span>
        {toggle}
        <div className="flex-1" />
        <Button variant="ghost" className="py-0.5 text-[12px]" icon="trash" onClick={onClear} title="Clear all history of this request">
          Clear
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto px-1.5">
        {history.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onSelect(h)}
              className={cx(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--or-soft)]',
                h.id === selectedId && 'bg-selected text-selected-fg',
              )}
            >
              {h.response ? (
                <StatusPill status={h.response.status} small />
              ) : (
                <span className="rounded-full bg-error/15 px-1.5 font-mono text-[11px] text-error">ERR</span>
              )}
              <MethodBadge method={h.request.method} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{h.request.url}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">
                {formatDuration(h.response?.timing.totalMs ?? h.error?.timing.totalMs ?? 0)}
              </span>
              {h.environment && <span className="shrink-0 text-[11px] text-muted">{h.environment}</span>}
              <span className="w-16 shrink-0 text-right text-[11px] text-muted" title={new Date(h.timestamp).toLocaleString()}>
                {relativeTime(h.timestamp, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a base64 paste turned into, shown in place of a response until it is dismissed or a send replaces it. */
function PastedBody({ paste, fontSize }: { paste: DecodedPaste; fontSize: number }) {
  if (!paste.ok) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
        <Icon name="warning" size={20} className="text-warning" />
        <div className="text-fg/80">{paste.message}</div>
        <div className="text-[12px] text-muted">Paste a base64 image, audio, video or text blob.</div>
      </div>
    );
  }
  if (paste.kind === 'media') return <MediaBody base64={paste.base64} size={paste.bytes} media={paste.media} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-1 text-[12px]">
        <span className="font-mono text-muted">text/plain</span>
        <span className="text-muted">· {formatSize(paste.bytes)}</span>
      </div>
      <CodeView className="flex-1" value={paste.text} readOnly wrap language={bodyLanguage(undefined, paste.text)} fontSize={fontSize} />
    </div>
  );
}

export interface ResponseViewProps {
  sending: boolean;
  startedAt: number | null;
  entry: HistoryEntry | null;
  history: HistoryEntry[];
  /** Current method + URL of the request; the History tab shows entries for this endpoint. */
  method: RequestMethod;
  url: string;
  tab: ResponseTab;
  onTabChange: (t: ResponseTab) => void;
  onSelectHistory: (e: HistoryEntry) => void;
  onClearHistory: () => void;
  onCopy: (text: string) => void;
  onCancel: () => void;
  /** Re-send the current request (shown on the error panel). */
  onRetry?: () => void;
  /** Response body font size in px; 0 = editor default. */
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  /** Label of the send shortcut, for the empty state hint. */
  sendShortcut: string;
  /** A base64 blob pasted into the URL bar; takes over the body pane until dismissed. */
  paste?: DecodedPaste | null;
  onDismissPaste?: () => void;
  /** The last send never reached the server. Shown in the status badge; it is not a response. */
  failure?: HttpErrorInfo | null;
}

function ResponseViewInner({
  sending,
  startedAt,
  entry,
  history,
  method,
  url,
  tab,
  onTabChange,
  onSelectHistory,
  onClearHistory,
  onCopy,
  onCancel,
  onRetry,
  fontSize,
  onFontSizeChange,
  sendShortcut,
  paste,
  onDismissPaste,
  failure,
}: ResponseViewProps) {
  const response = entry?.response;
  const [showAll, setShowAll] = useState(false);
  const scoped = useMemo(() => history.filter((h) => matchesEndpoint(h, method, url)), [history, method, url]);
  const shownHistory = showAll ? history : scoped;
  const items = useMemo(
    () => [
      { id: 'body' as const, label: 'Body' },
      // A pasted blob has no headers of its own; showing the previous response's count would mislead.
      { id: 'headers' as const, label: 'Headers', badge: paste ? undefined : response?.headers.length },
      { id: 'history' as const, label: 'History', badge: shownHistory.length },
    ],
    [response, shownHistory.length, paste],
  );

  const meta = failure ? (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="rounded-full bg-error/15 px-2 py-0.5 font-mono text-[12px] font-semibold text-error">Failed</span>
      <span className="truncate text-muted" title={failure.code ? `${failure.message} (${failure.code})` : failure.message}>
        {failure.message}
      </span>
    </div>
  ) : paste ? (
    <div className="flex items-center gap-2 text-[12px]">
      <span
        className={cx(
          'rounded-full px-2 py-0.5 font-mono text-[12px] font-semibold',
          paste.ok ? 'bg-info/15 text-info' : 'bg-error/15 text-error',
        )}
      >
        {paste.ok ? 'Base64' : 'Decode failed'}
      </span>
      {paste.ok && <span className="font-mono text-muted tabular-nums">{formatSize(paste.bytes)}</span>}
      <IconButton icon="x" title="Dismiss" onClick={() => onDismissPaste?.()} />
    </div>
  ) : response ? (
    <div className="flex items-center gap-2 text-[12px]">
      <StatusPill status={response.status} statusText={response.statusText} />
      <span className="font-mono text-muted tabular-nums" title={response.timing.ttfbMs !== undefined ? `TTFB ${formatDuration(response.timing.ttfbMs)}` : undefined}>
        {formatDuration(response.timing.totalMs)}
      </span>
      <span className="font-mono text-muted tabular-nums">{formatSize(response.size)}</span>
    </div>
  ) : entry?.error ? (
    <span className="rounded-full bg-error/15 px-2 py-0.5 font-mono text-[12px] text-error">Error</span>
  ) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <Tabs className="px-3" items={items} active={tab} onChange={onTabChange} right={meta} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tab === 'history' ? (
          <HistoryList
            history={shownHistory}
            hiddenCount={history.length - scoped.length}
            showAll={showAll}
            onToggleShowAll={() => setShowAll((s) => !s)}
            selectedId={entry?.id ?? null}
            onSelect={onSelectHistory}
            onClear={onClearHistory}
          />
        ) : paste ? (
          <PastedBody paste={paste} fontSize={fontSize} />
        ) : !entry ? (
          !sending && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-muted">
              <div className="text-fg/80">No response yet</div>
              <div className="text-[12px]">
                <kbd className="rounded-full bg-[var(--or-soft-strong)] px-1.5 font-mono">{sendShortcut}</kbd> to send · paste a cURL into the URL bar
              </div>
            </div>
          )
        ) : entry.error ? (
          <ErrorPanel error={entry.error} url={entry.request.url} onRetry={onRetry} onCopy={onCopy} />
        ) : response ? (
          tab === 'headers' ? (
            <HeadersTable headers={response.headers} />
          ) : (
            <ResponseBody key={entry.id} response={response} url={entry.request.url} onCopy={onCopy} fontSize={fontSize} onFontSizeChange={onFontSizeChange} />
          )
        ) : null}

        {sending && startedAt !== null && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-bg/80">
            <div className="flex items-center gap-2">
              <Spinner />
              <span>Sending…</span>
              <Elapsed startedAt={startedAt} />
            </div>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export const ResponseView = memo(ResponseViewInner);
