// URL bar with {{variable}} highlighting and autocomplete (see VarInput).
import { memo, useCallback, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { KeyValue } from '../../shared/model';
import type { VariableInfo } from '../../shared/protocol';
import type { TextSuggestion } from '../lib/suggest';
import { buildUrl, urlTextMatches } from '../lib/url';
import { Icon } from './Icon';
import { VarInput } from './VarInput';
import { cx } from './ui';

export interface UrlInputProps {
  url: string;
  params: KeyValue[];
  variables: readonly VariableInfo[];
  onChange: (text: string) => void;
  onPaste?: (e: ClipboardEvent<HTMLInputElement>) => void;
  onEnter?: () => void;
  /** Typing suggestions (endpoints, path segments, params); see VarInput. */
  suggest?: (text: string) => TextSuggestion[];
  /**
   * A base64 blob was pasted here: show it read-only in place of the URL, which is left untouched
   * underneath. Clearing it puts the URL back.
   */
  preview?: { head: string; length: number; onClear: () => void };
  className?: string;
}

function UrlInputInner({ url, params, variables, onChange, onPaste, onEnter, suggest, preview, className }: UrlInputProps) {
  const [text, setText] = useState(() => buildUrl(url, params));

  // Adopt external changes (params table edits, curl import) without clobbering partial typing like "?a=".
  if (!urlTextMatches(text, url, params)) {
    const next = buildUrl(url, params);
    if (next !== text) setText(next);
  }

  const change = useCallback(
    (next: string) => {
      setText(next);
      onChange(next);
    },
    [onChange],
  );

  if (preview) {
    return (
      <div className={cx('flex items-center gap-2 overflow-hidden px-2.5 py-[6px]', className)} title={`${preview.length.toLocaleString()} characters pasted`}>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-[18px] text-muted">{preview.head}</span>
        <span className="shrink-0 rounded-full bg-[var(--or-soft-strong)] px-2 text-[11px] leading-[18px] text-muted tabular-nums">
          {preview.length.toLocaleString()} chars
        </span>
        <button
          type="button"
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-muted hover:bg-[var(--or-soft-strong)] hover:text-fg"
          title="Clear and show the URL"
          aria-label="Clear the pasted base64"
          onClick={preview.onClear}
        >
          <Icon name="x" size={11} />
        </button>
      </div>
    );
  }

  return (
    <VarInput
      aria-label="Request URL"
      className={cx('flex items-center overflow-hidden', className)}
      fieldClassName="px-2.5 py-[6px] font-mono text-[13px] leading-[18px] outline-none"
      value={text}
      variables={variables}
      placeholder="Enter URL or paste a cURL command"
      onChange={change}
      suggest={suggest}
      onPaste={onPaste}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

export const UrlInput = memo(UrlInputInner);
