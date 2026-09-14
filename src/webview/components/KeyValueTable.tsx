// Reusable editable key/value table with a trailing "ghost" row, bulk edit and optional columns.
import { memo, useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { VariableInfo } from '../../shared/protocol';
import { bulkToRows, rowsToBulk, type KvRow } from '../lib/kv';
import { IconButton, cx } from './ui';
import { VarInput } from './VarInput';

export interface KeyValueTableProps<T extends KvRow> {
  rows: T[];
  onChange: (rows: T[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Show a secret (lock) toggle column. */
  secretColumn?: boolean;
  /** New rows start locked (`secret`). */
  defaultSecret?: boolean;
  /** Hover text of the lock button, explaining what locking does here. */
  lockTitles?: { locked: string; unlocked: string };
  /** Secret rows get a disabled value input with this hint (committed files never hold secrets). */
  secretValueHint?: string;
  /** Mask values for these keys (e.g. local overrides of secret variables). */
  maskKeys?: ReadonlySet<string>;
  /** Show text/file kind toggle (multipart form). */
  kindColumn?: boolean;
  /** Allow bulk edit toggle. Default true. */
  bulk?: boolean;
  /** Initially show description column. */
  showDescription?: boolean;
  /** Hide the enable checkbox column. */
  noEnabled?: boolean;
  /** Enables {{variable}} highlighting and autocomplete in key and value cells. */
  variables?: readonly VariableInfo[];
  className?: string;
}

interface Cols {
  enabled: boolean;
  description: boolean;
  secret: boolean;
  kind: boolean;
  lockTitles?: { locked: string; unlocked: string };
  secretValueHint?: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
}

type Field = 'key' | 'value' | 'description';

interface RowProps {
  row: KvRow;
  index: number;
  ghost: boolean;
  cols: Cols;
  masked: boolean;
  variables?: readonly VariableInfo[];
  onPatch: (index: number, patch: Partial<KvRow>) => void;
  onRemove: (index: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>, index: number, field: Field) => void;
}

const Row = memo(function Row({ row, index, ghost, cols, masked, variables, onPatch, onRemove, onKeyDown }: RowProps) {
  const [reveal, setReveal] = useState(false);
  const enabled = row.enabled !== false;
  const secretLocked = cols.secretValueHint !== undefined && !!row.secret;
  const dim = !ghost && !enabled ? 'opacity-50' : '';
  const input = (field: Field, placeholder: string, extra?: { type?: string; disabled?: boolean; mono?: boolean }) =>
    variables && field !== 'description' && !extra?.disabled ? (
      <VarInput
        data-kv-row={index}
        data-kv-field={field}
        className="flex-1"
        fieldClassName={cx('cell-input', extra?.mono && 'font-mono text-[12px]')}
        value={(row[field] as string | undefined) ?? ''}
        placeholder={placeholder}
        masked={extra?.type === 'password'}
        variables={variables}
        onChange={(text) => onPatch(index, { [field]: text })}
        onKeyDown={(e) => onKeyDown(e, index, field)}
      />
    ) : (
    <input
      data-kv-row={index}
      data-kv-field={field}
      className={cx('cell-input', extra?.mono && 'font-mono text-[12px]')}
      value={(row[field] as string | undefined) ?? ''}
      placeholder={placeholder}
      type={extra?.type ?? 'text'}
      disabled={extra?.disabled}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onPatch(index, { [field]: e.target.value })}
      onKeyDown={(e) => onKeyDown(e, index, field)}
    />
  );
  return (
    <tr className={cx('group', dim)}>
      {cols.enabled && (
        <td className="w-7 text-center">
          {!ghost && (
            <input
              type="checkbox"
              className="chk align-middle"
              checked={enabled}
              aria-label="Enabled"
              onChange={(e) => onPatch(index, { enabled: e.target.checked })}
            />
          )}
        </td>
      )}
      <td>{input('key', cols.keyPlaceholder)}</td>
      <td>
        <div className="flex items-center">
          {secretLocked
            ? input('value', cols.secretValueHint ?? '', { disabled: true })
            : input('value', cols.valuePlaceholder, { type: masked && !reveal ? 'password' : 'text' })}
          {masked && !secretLocked && !ghost && (
            <IconButton icon={reveal ? 'eyeOff' : 'eye'} title={reveal ? 'Hide' : 'Show'} className="mr-0.5 h-5 w-5" onClick={() => setReveal((r) => !r)} />
          )}
        </div>
      </td>
      {cols.description && <td>{input('description', 'Description')}</td>}
      {cols.kind && (
        <td className="w-16 text-center">
          {!ghost && (
            <button
              type="button"
              className="rounded-md px-1.5 text-[11px] text-muted hover:bg-[var(--or-soft-strong)] hover:text-fg"
              title="Toggle text / file"
              onClick={() => onPatch(index, { kind: row.kind === 'file' ? 'text' : 'file' })}
            >
              {row.kind === 'file' ? 'File' : 'Text'}
            </button>
          )}
        </td>
      )}
      {cols.secret && (
        <td className="w-8 text-center">
          {!ghost && (
            <IconButton
              icon={row.secret ? 'lock' : 'unlock'}
              title={row.secret ? (cols.lockTitles?.locked ?? 'Secret (click to make plain)') : (cols.lockTitles?.unlocked ?? 'Mark as secret')}
              active={!!row.secret}
              className={cx('mx-auto h-5 w-5', !row.secret && 'text-muted')}
              onClick={() => onPatch(index, { secret: !row.secret })}
            />
          )}
        </td>
      )}
      <td className="w-7 text-center">
        {!ghost && (
          <IconButton icon="trash" title="Delete row" className="mx-auto h-5 w-5 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => onRemove(index)} />
        )}
      </td>
    </tr>
  );
});

const EMPTY: KvRow = { key: '', value: '' };

function KeyValueTableInner<T extends KvRow>({
  rows,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  secretColumn = false,
  defaultSecret = false,
  lockTitles,
  secretValueHint,
  maskKeys,
  kindColumn = false,
  bulk = true,
  showDescription = false,
  noEnabled = false,
  variables,
  className,
}: KeyValueTableProps<T>) {
  const [descOpen, setDescOpen] = useState(showDescription || rows.some((r) => !!r.description));
  const [bulkText, setBulkText] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const defaultSecretRef = useRef(defaultSecret);
  defaultSecretRef.current = defaultSecret;

  const onPatch = useCallback((index: number, patch: Partial<KvRow>) => {
    const cur = rowsRef.current;
    const next = cur.slice();
    const base = (index < cur.length ? cur[index] : { key: '', value: '', ...(defaultSecretRef.current ? { secret: true } : {}) }) as T;
    const merged = { ...base, ...patch } as T;
    if (merged.enabled !== false) delete merged.enabled;
    if (merged.secret === false) delete merged.secret;
    if (merged.kind === 'text') delete merged.kind;
    if (merged.description === '') delete merged.description;
    next[index] = merged;
    onChangeRef.current(next);
  }, []);

  const focusCell = (index: number, field: Field) => {
    requestAnimationFrame(() => {
      const el = tableRef.current?.querySelector<HTMLInputElement>(`input[data-kv-row="${index}"][data-kv-field="${field}"]`);
      el?.focus();
    });
  };

  const onRemove = useCallback((index: number) => {
    const next = rowsRef.current.slice();
    next.splice(index, 1);
    onChangeRef.current(next);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>, index: number, field: Field) => {
    const cur = rowsRef.current;
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      focusCell(Math.min(index + 1, cur.length), 'key');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusCell(Math.min(index + 1, cur.length), field);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusCell(Math.max(index - 1, 0), field);
    } else if (e.key === 'Backspace' && field === 'key' && index < cur.length) {
      const r = cur[index];
      if (r.key === '' && r.value === '' && !r.description) {
        e.preventDefault();
        const next = cur.slice();
        next.splice(index, 1);
        onChangeRef.current(next);
        focusCell(Math.max(index - 1, 0), 'key');
      }
    }
  }, []);

  const cols: Cols = {
    enabled: !noEnabled,
    description: descOpen,
    secret: secretColumn,
    kind: kindColumn,
    lockTitles,
    secretValueHint,
    keyPlaceholder,
    valuePlaceholder,
  };
  // Stable object identity so memoized rows do not re-render needlessly.
  const colsKey = JSON.stringify(cols);
  const colsRef = useRef<{ key: string; cols: Cols }>({ key: colsKey, cols });
  if (colsRef.current.key !== colsKey) colsRef.current = { key: colsKey, cols };
  const stableCols = colsRef.current.cols;

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-end gap-1 text-[11px] text-muted">
        {bulkText === null && (
          <button type="button" className="rounded-full px-2.5 py-0.5 hover:bg-[var(--or-soft-strong)] hover:text-fg" onClick={() => setDescOpen((d) => !d)}>
            {descOpen ? 'Hide description' : 'Description'}
          </button>
        )}
        {bulk && (
          <button
            type="button"
            className="rounded-full px-2.5 py-0.5 hover:bg-[var(--or-soft-strong)] hover:text-fg"
            onClick={() => setBulkText((t) => (t === null ? rowsToBulk(rowsRef.current) : null))}
          >
            {bulkText === null ? 'Bulk edit' : 'Key-value edit'}
          </button>
        )}
      </div>
      {bulkText !== null ? (
        <textarea
          className="ctl block min-h-[140px] w-full resize-y font-mono text-[12px] leading-5"
          value={bulkText}
          spellCheck={false}
          placeholder={'key: value\n// disabled: value'}
          rows={Math.max(6, bulkText.split('\n').length + 1)}
          onChange={(e) => {
            setBulkText(e.target.value);
            onChange(bulkToRows(e.target.value, rowsRef.current));
          }}
        />
      ) : (
        <table ref={tableRef} className="kv-table w-full table-fixed">
          <colgroup>
            {stableCols.enabled && <col className="w-7" />}
            <col className="w-[34%]" />
            <col />
            {stableCols.description && <col className="w-[28%]" />}
            {stableCols.kind && <col className="w-16" />}
            {stableCols.secret && <col className="w-8" />}
            <col className="w-7" />
          </colgroup>
          <tbody>
            {/* One keyed list (ghost last): typing in the ghost row turns it into row N with the same key, so
                React keeps the same <input> and focus stays put. A separate sibling would remount it. */}
            {[...rows, EMPTY].map((row, i) => {
              const ghost = i === rows.length;
              return (
                <Row
                  key={i}
                  row={row}
                  index={i}
                  ghost={ghost}
                  cols={stableCols}
                  masked={!ghost && !!maskKeys?.has(row.key)}
                  variables={variables}
                  onPatch={onPatch}
                  onRemove={onRemove}
                  onKeyDown={onKeyDown}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export const KeyValueTable = memo(KeyValueTableInner) as typeof KeyValueTableInner;
