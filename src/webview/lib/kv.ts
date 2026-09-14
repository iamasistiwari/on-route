// Bulk-edit text <-> key/value rows. Pure; no DOM.

export interface KvRow {
  key: string;
  value: string;
  enabled?: boolean;
  description?: string;
  secret?: boolean;
  kind?: 'text' | 'file';
}

/** `key: value` per line; disabled rows are prefixed with `//`. */
export function rowsToBulk(rows: KvRow[]): string {
  return rows
    .filter((r) => r.key !== '' || r.value !== '')
    .map((r) => `${r.enabled === false ? '//' : ''}${r.key}: ${r.value}`)
    .join('\n');
}

export function bulkToRows<T extends KvRow>(text: string, prev: T[]): T[] {
  const byKey = new Map(prev.map((r) => [r.key, r]));
  const out: T[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    if (line.trim() === '') continue;
    let enabled = true;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
      enabled = false;
      line = trimmed.slice(2);
    }
    const colon = line.indexOf(':');
    const key = (colon === -1 ? line : line.slice(0, colon)).trim();
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    const base = byKey.get(key);
    const row = { ...(base ?? {}), key, value } as T;
    if (enabled) delete row.enabled;
    else row.enabled = false;
    out.push(row);
  }
  return out;
}
