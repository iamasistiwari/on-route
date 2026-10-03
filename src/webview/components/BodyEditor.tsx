import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { ViewUpdate } from '@codemirror/view';
import type { BodyConfig, RequestMethod } from '../../shared/model';
import type { VariableInfo } from '../../shared/protocol';
import { formatJson, repairJson } from '../lib/format';
import { isEmptyJson, type BodySuggestion, type JsonKeySuggestion } from '../lib/suggest';
import { CodeView, type CodeLanguage } from './CodeView';
import { KeyValueTable } from './KeyValueTable';
import { METHOD_TEXT } from './MethodBadge';
import { Button, Segmented, cx } from './ui';

type BodyType = BodyConfig['type'];

const TYPES: { value: BodyType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'raw', label: 'Raw' },
  { value: 'urlencoded', label: 'URL-encoded' },
  { value: 'form', label: 'Form data' },
  { value: 'binary', label: 'Binary' },
];

const RAW_TYPES = ['text/plain', 'application/xml', 'text/html', 'application/javascript'];
const NO_BODY_METHODS: readonly RequestMethod[] = ['GET', 'HEAD', 'OPTIONS'];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const FORMAT_SHORTCUT = isMac ? '⇧⌥F' : 'Shift+Alt+F';

function rawLanguage(ct: string | undefined): CodeLanguage {
  if (!ct) return 'text';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('html')) return 'html';
  return 'text';
}

function convert(prev: BodyConfig, type: BodyType): BodyConfig {
  const text = prev.type === 'json' || prev.type === 'raw' ? prev.content : '';
  const fields = prev.type === 'urlencoded' || prev.type === 'form' ? prev.fields : [];
  switch (type) {
    case 'none':
      return { type };
    case 'json':
      return { type, content: formatJson(text) ?? text };
    case 'raw':
      return { type, content: text, contentType: 'text/plain' };
    case 'urlencoded':
      return { type, fields: fields.map(({ key, value, enabled, description }) => ({ key, value, enabled, description })) };
    case 'form':
      return { type, fields };
    case 'binary':
      return { type, filePath: '' };
  }
}

function BodyEditorInner({
  value,
  onChange,
  variables,
  method,
  starters,
  jsonKeys,
  collapseStringsOver,
}: {
  /** JSON string values longer than this are shown shortened with "…view more"; undefined = never. */
  collapseStringsOver?: number;
  value: BodyConfig;
  onChange: (b: BodyConfig) => void;
  /** Enables {{variable}} highlighting and autocomplete. */
  variables?: readonly VariableInfo[];
  method?: RequestMethod;
  /** Bodies of similar requests, offered while this body is empty. */
  starters?: readonly BodySuggestion[];
  /** Key / value completion for the JSON editor. */
  jsonKeys?: readonly JsonKeySuggestion[];
}) {
  const cache = useRef<Partial<Record<BodyType, BodyConfig>>>({});
  cache.current[value.type] = value;
  const [jsonError, setJsonError] = useState(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  const setType = (type: BodyType) => {
    if (type === value.type) return;
    onChange(cache.current[type] ?? convert(value, type));
    setJsonError(false);
  };

  /** Pretty-print the JSON body, repairing it when broken. Returns false when it cannot be repaired. */
  const format = useCallback((): boolean => {
    const { value: v, onChange: change } = latest.current;
    if (v.type !== 'json') return false;
    const formatted = v.content.trim() ? (repairJson(v.content)?.text ?? null) : formatJson(v.content);
    setJsonError(formatted === null);
    if (formatted !== null && formatted !== v.content) change({ ...v, content: formatted });
    return formatted !== null;
  }, []);

  const formatKeys = useMemo(
    () => [
      {
        key: 'Shift-Alt-f',
        run: () => {
          format();
          return true;
        },
      },
    ],
    [format],
  );

  const onJsonChange = useCallback((content: string, update?: ViewUpdate) => {
    const { value: v, onChange: change } = latest.current;
    if (v.type !== 'json') return;
    setJsonError(false);
    // Pasting valid JSON formats it right away (tabs, extra spaces and one-liners become tidy JSON).
    const pasted = update?.transactions.some((tr) => tr.isUserEvent('input.paste'));
    const formatted = pasted ? formatJson(content) : null;
    change({ ...v, content: formatted ?? content });
  }, []);

  const showStarters =
    !!starters?.length &&
    (value.type === 'none' ? !!method && !NO_BODY_METHODS.includes(method) : value.type === 'json' && isEmptyJson(value.content));

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={TYPES} value={value.type} onChange={setType} />
        <div className="flex-1" />
        {value.type === 'json' && (
          <>
            {jsonError && <span className="text-[12px] text-error">Invalid JSON</span>}
            <Button variant="ghost" className="py-0.5 text-[12px]" title={`Format JSON (${FORMAT_SHORTCUT})`} onClick={() => format()}>
              Format
            </Button>
          </>
        )}
        {value.type === 'raw' && (
          <select
            className="ctl text-[12px]"
            aria-label="Content type"
            value={value.contentType ?? 'text/plain'}
            onChange={(e) => onChange({ ...value, contentType: e.target.value })}
          >
            {[...new Set([...RAW_TYPES, value.contentType ?? 'text/plain'])].map((ct) => (
              <option key={ct} value={ct}>
                {ct}
              </option>
            ))}
          </select>
        )}
      </div>

      {showStarters && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="mr-0.5 text-muted">Start from</span>
          {starters!.map((s) => (
            <button
              key={s.id}
              type="button"
              title={`Use the JSON body of “${s.name}”`}
              className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full bg-[var(--or-soft)] px-2.5 py-0.5 hover:bg-[var(--or-soft-strong)]"
              onClick={() => onChange({ type: 'json', content: formatJson(s.content) ?? s.content })}
            >
              <span className={cx('shrink-0 font-mono text-[10px] font-bold', METHOD_TEXT[s.method])}>{s.method}</span>
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}

      {value.type === 'none' && <div className="py-4 text-muted">This request has no body.</div>}

      {value.type === 'json' && (
        <CodeView
          className="min-h-[160px] flex-1 rounded-xl border border-[var(--or-line)]"
          language="json"
          history={false}
          value={value.content}
          placeholder='{ "hello": "world" }'
          collapseStringsOver={collapseStringsOver}
          keys={formatKeys}
          variables={variables}
          jsonSuggestions={jsonKeys}
          copyValues
          onChange={onJsonChange}
        />
      )}

      {value.type === 'raw' && (
        <CodeView
          className="min-h-[160px] flex-1 rounded-xl border border-[var(--or-line)]"
          language={rawLanguage(value.contentType)}
          history={false}
          value={value.content}
          variables={variables}
          onChange={(content) => onChange({ ...value, content })}
        />
      )}

      {value.type === 'urlencoded' && (
        <KeyValueTable rows={value.fields} variables={variables} onChange={(fields) => onChange({ ...value, fields })} />
      )}

      {value.type === 'form' && (
        <>
          <KeyValueTable rows={value.fields} kindColumn variables={variables} onChange={(fields) => onChange({ ...value, fields })} />
          <div className="text-[12px] text-muted">File fields take a path relative to the workspace root.</div>
        </>
      )}

      {value.type === 'binary' && (
        <label className="flex max-w-xl flex-col gap-1">
          <span className="text-muted">File path (relative to workspace root)</span>
          <input
            className="ctl font-mono"
            value={value.filePath}
            placeholder="fixtures/upload.bin"
            spellCheck={false}
            onChange={(e) => onChange({ ...value, filePath: e.target.value })}
          />
        </label>
      )}
    </div>
  );
}

export const BodyEditor = memo(BodyEditorInner);
