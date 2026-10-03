// Read-only preview of what the effective auth adds to a request (header or query param), shown
// above the Headers / Params tables so inherited folder/project auth is visible where it lands.
import { useState } from 'react';
import type { AuthConfig, KeyValue } from '../../shared/model';
import { IconButton, cx } from './ui';

export interface AuthRow {
  key: string;
  value: string;
  /** Value is a credential (masked until revealed). */
  secret: boolean;
}

const VAR_ONLY = /^\{\{[^{}]*\}\}$/;

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** The header or query param `auth` contributes, mirroring `applyAuth`. */
export function authRow(auth: AuthConfig, target: 'header' | 'query'): AuthRow | null {
  switch (auth.type) {
    case 'bearer':
      return target === 'header' ? { key: 'Authorization', value: `Bearer ${auth.token}`, secret: true } : null;
    case 'basic': {
      if (target !== 'header') return null;
      const pair = `${auth.username}:${auth.password}`;
      // Variables are resolved at send time, so encoding the placeholders would be misleading.
      const encoded = pair.includes('{{') ? `base64(${pair})` : base64Utf8(pair);
      return { key: 'Authorization', value: `Basic ${encoded}`, secret: true };
    }
    case 'apikey':
      if (!auth.key || (auth.in === 'query') !== (target === 'query')) return null;
      return { key: auth.key, value: auth.value, secret: true };
    default:
      return null;
  }
}

function maskValue(value: string): string {
  const sp = value.indexOf(' ');
  const scheme = /^(Bearer|Basic) /.test(value) ? value.slice(0, sp + 1) : '';
  const rest = value.slice(scheme.length);
  if (!rest || VAR_ONLY.test(rest.trim())) return value;
  return scheme + '•'.repeat(Math.min(12, Math.max(6, rest.length)));
}

export interface InheritedAuthRowsProps {
  /** The request's own auth. */
  own: AuthConfig;
  inherited: { auth: AuthConfig; source: string };
  target: 'header' | 'query';
  /** User-defined rows; an enabled row with the same key overrides the auth row. */
  rows: readonly KeyValue[];
  onEdit: () => void;
}

export function InheritedAuthRows({ own, inherited, target, rows, onEdit }: InheritedAuthRowsProps) {
  const [reveal, setReveal] = useState(false);
  const fromParent = own.type === 'inherit';
  const auth = fromParent ? inherited.auth : own;
  const row = authRow(auth, target);
  if (!row) return null;

  const cmp = (k: string) => (target === 'header' ? k.toLowerCase() === row.key.toLowerCase() : k === row.key);
  const overridden = rows.some((r) => r.enabled !== false && cmp(r.key));
  const source = fromParent ? inherited.source : 'Auth tab';
  const shown = row.secret && !reveal ? maskValue(row.value) : row.value;

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-muted">
        <span>{fromParent ? 'Inherited' : 'From auth'}</span>
        <span>·</span>
        <button type="button" className="rounded-full px-1.5 hover:bg-[var(--or-soft-strong)] hover:text-fg" title="Edit authorization" onClick={onEdit}>
          {source}
        </button>
      </div>
      <table className="kv-table w-full table-fixed">
        <colgroup>
          <col className="w-7" />
          <col className="w-[34%]" />
          <col />
          <col className="w-7" />
        </colgroup>
        <tbody>
          <tr className={cx(overridden && 'opacity-50')} title={overridden ? `Overridden by your ${row.key} ${target === 'header' ? 'header' : 'parameter'}` : `Added automatically from ${source}`}>
            <td className="w-7 text-center">
              <input type="checkbox" className="chk align-middle" checked={!overridden} disabled aria-label="Applied" />
            </td>
            <td>
              <div className={cx('cell-input truncate font-mono text-[12px] text-muted', overridden && 'line-through')}>{row.key}</div>
            </td>
            <td>
              <div className={cx('cell-input truncate font-mono text-[12px] text-muted', overridden && 'line-through')}>{shown || '(empty)'}</div>
            </td>
            <td className="w-7 text-center">
              {row.secret && (
                <IconButton icon={reveal ? 'eyeOff' : 'eye'} title={reveal ? 'Hide' : 'Show'} className="h-5 w-5" onClick={() => setReveal((r) => !r)} />
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
