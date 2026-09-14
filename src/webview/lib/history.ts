// History helpers. Pure; no DOM.
import type { HistoryEntry, RequestMethod } from '../../shared/model';

function pathOnly(url: string): string {
  return url.trim().split(/[?#]/)[0].replace(/\/+$/, '');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a history entry was sent to the endpoint the request currently points at: same method and same
 * URL path (query ignored). `{{variables}}` in the request URL match anything, since history stores the
 * resolved URL.
 */
export function matchesEndpoint(entry: HistoryEntry, method: RequestMethod, url: string): boolean {
  if (entry.request.method !== method) return false;
  const template = pathOnly(url);
  const actual = pathOnly(entry.request.url);
  if (!template.includes('{{')) return template === actual;
  const pattern = template.split(/\{\{[^{}]*\}\}/).map(escapeRe).join('.*?');
  return new RegExp(`^${pattern}$`).test(actual);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", or e.g. "Monday, Sep 7" (with year when not the current year). */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Group entries (already newest first) by local calendar day. */
export function groupByDay(entries: HistoryEntry[], now: number = Date.now()): { key: number; label: string; entries: HistoryEntry[] }[] {
  const groups: { key: number; label: string; entries: HistoryEntry[] }[] = [];
  for (const e of entries) {
    const key = startOfDay(e.timestamp);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(e.timestamp, now), entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
