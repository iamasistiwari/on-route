import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, ProjectTree, RequestSummary } from '../../../shared/model';
import { CodeView } from '../../components/CodeView';
import { Icon } from '../../components/Icon';
import { MethodBadge } from '../../components/MethodBadge';
import { StatusPill } from '../../components/ResponseView';
import { Button, Segmented, Spinner, cx } from '../../components/ui';
import { bodyLanguage, formatDuration, formatSize, prettyJson, relativeTime, statusClass } from '../../lib/format';
import { clockTime, groupByDay } from '../../lib/history';
import { post } from '../../vscode';
import { Section } from './Section';

type StatusFilter = 'all' | 'ok' | 'failed';

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ok', label: 'Successful' },
  { value: 'failed', label: 'Failed' },
];

const isFailed = (e: HistoryEntry) => !e.response || e.response.status >= 400;

function dotColor(e: HistoryEntry): string {
  if (!e.response) return 'bg-error';
  switch (statusClass(e.response.status)) {
    case 'success':
      return 'bg-success';
    case 'client-error':
      return 'bg-warning';
    case 'server-error':
      return 'bg-error';
    default:
      return 'bg-info';
  }
}

function Details({ entry, summary }: { entry: HistoryEntry; summary: RequestSummary | undefined }) {
  const res = entry.response;
  const reqBody = entry.request.body;
  const lang = res ? bodyLanguage(res.contentType, res.bodyEncoding === 'utf8' ? res.body : '') : 'text';
  const shown = useMemo(() => (res && lang === 'json' ? prettyJson(res.body).text : (res?.body ?? '')), [res, lang]);
  return (
    <div className="mb-2 ml-[22px] mt-1 space-y-3 rounded-xl border border-[var(--or-line)] bg-sidebar p-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-mono select-text">
          <span className="font-semibold">{entry.request.method}</span> {entry.request.url}
        </span>
        <Button
          variant="secondary"
          icon="open"
          className="py-0.5 text-[12px]"
          disabled={!summary}
          title={summary ? 'Open the request with this response selected' : 'This request no longer exists'}
          onClick={() => post({ type: 'openRequest', id: entry.requestId, historyId: entry.id })}
        >
          Open request
        </Button>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-muted">
        <span title={new Date(entry.timestamp).toLocaleString()}>{new Date(entry.timestamp).toLocaleString()}</span>
        <span>Environment: {entry.environment ?? 'none'}</span>
        {res && <span>Size: {formatSize(res.size)}</span>}
        {res?.timing.ttfbMs !== undefined && <span>TTFB: {formatDuration(res.timing.ttfbMs)}</span>}
      </div>

      {entry.request.headers.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted hover:text-fg">Request headers ({entry.request.headers.length})</summary>
          <div className="mt-1 space-y-0.5 font-mono select-text">
            {entry.request.headers.map((h, i) => (
              <div key={i} className="break-all">
                <span className="text-muted">{h.key}:</span> {h.value}
              </div>
            ))}
          </div>
        </details>
      )}
      {reqBody.type === 'text' && reqBody.content && (
        <details>
          <summary className="cursor-pointer text-muted hover:text-fg">Request body</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono select-text">{prettyJson(reqBody.content).text}</pre>
        </details>
      )}

      {entry.error ? (
        <div>
          <div className="font-semibold text-error">Could not get a response</div>
          <div className="font-mono break-words select-text">{entry.error.message}</div>
        </div>
      ) : res ? (
        <div>
          <div className="mb-1 flex items-center gap-2 text-muted">
            Response body
            {res.truncated && <span className="text-warning">· truncated</span>}
          </div>
          {res.bodyEncoding === 'base64' ? (
            <div className="text-muted">Binary response, {res.size.toLocaleString()} bytes</div>
          ) : res.body === '' ? (
            <div className="text-muted">Empty response body</div>
          ) : (
            <CodeView className="h-[240px] rounded-xl border border-[var(--or-line)] bg-bg" value={shown} readOnly wrap language={lang} />
          )}
        </div>
      ) : null}
    </div>
  );
}

const TimelineItem = memo(function TimelineItem({
  entry,
  summary,
  open,
  onToggle,
  now,
}: {
  entry: HistoryEntry;
  summary: RequestSummary | undefined;
  open: boolean;
  onToggle: (id: string) => void;
  now: number;
}) {
  const total = entry.response?.timing.totalMs ?? entry.error?.timing.totalMs ?? 0;
  return (
    <li className="relative">
      <span className={cx('absolute left-[3px] top-[10px] z-[1] h-[9px] w-[9px] rounded-full ring-2 ring-bg', dotColor(entry))} />
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(entry.id)}
        className={cx('flex w-full items-center gap-2 rounded-lg py-1 pl-[22px] pr-2 text-left hover:bg-[var(--or-soft)]', open && 'bg-[var(--or-soft)]')}
      >
        <span className="w-[68px] shrink-0 font-mono text-[11px] text-muted tabular-nums" title={relativeTime(entry.timestamp, now)}>
          {clockTime(entry.timestamp)}
        </span>
        {entry.response ? (
          <StatusPill status={entry.response.status} small />
        ) : (
          <span className="shrink-0 rounded-md bg-error/15 px-1 font-mono text-[11px] font-semibold text-error">ERR</span>
        )}
        <MethodBadge method={entry.request.method} />
        <span className={cx('max-w-[35%] shrink-0 truncate', !summary && 'text-muted line-through')} title={entry.requestId}>
          {summary?.name ?? entry.requestId}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted" title={entry.request.url}>
          {entry.request.url}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">{formatDuration(total)}</span>
        {entry.environment && <span className="hidden shrink-0 text-[11px] text-muted sm:inline">{entry.environment}</span>}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="shrink-0 text-muted" />
      </button>
      {open && <Details entry={entry} summary={summary} />}
    </li>
  );
});

/**
 * Height the entry list may take before it scrolls on its own: everything left between its top edge
 * and the bottom of the page's scroll area. Measured rather than hardcoded, because the header above
 * it changes height when the description wraps.
 */
function useFillHeight(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): number | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      // Hidden pages measure as 0; leave them alone until they are shown.
      if (top === 0) return;
      const scroller = el.closest('[data-overview-scroll]');
      const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      setHeight(Math.max(160, bottom - top - 12));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return height;
}

export function HistorySection({ tree, entries, bytes }: { tree: ProjectTree; entries: HistoryEntry[] | null; bytes: number }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const requests = useMemo(() => new Map(tree.requests.map((r) => [r.id, r])), [tree.requests]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter === 'ok' && isFailed(e)) return false;
      if (filter === 'failed' && !isFailed(e)) return false;
      if (!q) return true;
      const name = requests.get(e.requestId)?.name ?? e.requestId;
      return [name, e.requestId, e.request.url, e.request.method, String(e.response?.status ?? 'error'), e.environment ?? '']
        .some((s) => s.toLowerCase().includes(q));
    });
  }, [entries, query, filter, requests]);

  const now = Date.now();
  const groups = useMemo(() => groupByDay(filtered, now), [filtered]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const list = entries ?? [];
    const failed = list.filter(isFailed).length;
    const times = list.map((e) => e.response?.timing.totalMs ?? e.error?.timing.totalMs ?? 0);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    return { total: list.length, failed, avg };
  }, [entries]);

  const toggle = useMemo(() => (id: string) => setOpenId((cur) => (cur === id ? null : id)), []);
  const listRef = useRef<HTMLDivElement>(null);
  const listHeight = useFillHeight(listRef, [entries === null, entries?.length === 0]);

  return (
    <Section
      id="history"
      title="History"
      description="Every response recorded in this workspace, newest first. Click an entry for details, or open the request with that response."
      actions={
        <Button
          variant="secondary"
          icon="trash"
          className="py-0.5"
          disabled={!entries?.length}
          title={bytes > 0 ? `Delete every recorded response and free ${formatSize(bytes)} on disk` : 'Delete every recorded response'}
          onClick={() => post({ type: 'clearAllHistory' })}
        >
          Clear all
          {bytes > 0 && <span className="text-muted">· {formatSize(bytes)}</span>}
        </Button>
      }
    >
      {entries === null ? (
        <div className="flex items-center gap-2 py-3 text-muted">
          <Spinner /> Loading history…
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-[var(--or-line-strong)] px-4 py-10 text-center text-muted">
          <Icon name="history" size={20} />
          <div className="text-fg/80">No history yet</div>
          <div className="text-[12px]">Responses appear here as you send requests.</div>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
            <span>
              <b className="font-semibold text-fg">{stats.total}</b> responses
            </span>
            <span>
              <b className="font-semibold text-success">{stats.total - stats.failed}</b> successful
            </span>
            <span>
              <b className={cx('font-semibold', stats.failed ? 'text-error' : 'text-fg')}>{stats.failed}</b> failed
            </span>
            <span>
              avg <b className="font-semibold text-fg">{formatDuration(stats.avg)}</b>
            </span>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="ctl is-pill flex min-w-[200px] flex-1 items-center gap-2 py-[5px]">
              <Icon name="search" className="text-muted" />
              <input
                className="min-w-0 flex-1 bg-transparent py-[1px] outline-none"
                placeholder="Filter by name, URL, method, status or environment"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                aria-label="Filter history"
              />
            </div>
            <Segmented options={FILTERS} value={filter} onChange={setFilter} />
          </div>

          {groups.length === 0 ? (
            <div className="py-3 text-muted">No responses match.</div>
          ) : (
            <div ref={listRef} className="space-y-4 overflow-y-auto pr-1" style={{ maxHeight: listHeight }}>
              {groups.map((g) => (
                <section key={g.key}>
                  <h3 className="mb-1 flex items-baseline gap-2 text-[12px] font-semibold text-muted">
                    {g.label}
                    <span className="font-normal normal-case tracking-normal">
                      {g.entries.length} {g.entries.length === 1 ? 'response' : 'responses'}
                    </span>
                  </h3>
                  <ul className="relative">
                    <span className="absolute bottom-2 left-[7px] top-2 w-px bg-border" aria-hidden />
                    {g.entries.map((e) => (
                      <TimelineItem key={e.id} entry={e} summary={requests.get(e.requestId)} open={openId === e.id} onToggle={toggle} now={now} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
