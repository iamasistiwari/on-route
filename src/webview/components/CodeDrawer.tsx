import { useEffect, useState } from 'react';
import type { RequestDef } from '../../shared/model';
import { CODE_TARGETS, type CodeTarget } from '../../shared/protocol';
import { post } from '../vscode';
import { CodeView } from './CodeView';
import { CopyButton, IconButton, Spinner } from './ui';

const copyToClipboard = (text: string) => post({ type: 'copyToClipboard', text });

const GROUPS = [...new Set(CODE_TARGETS.map((t) => t.group))];
const STORAGE_KEY = 'onRoute.codeTarget';

function initialTarget(): CodeTarget {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage unavailable
  }
  return CODE_TARGETS.find((t) => t.id === saved)?.id ?? 'curl';
}

export interface CodeDrawerProps {
  request: RequestDef;
  code: { target: CodeTarget; code: string } | null;
  onClose: () => void;
}

/** Right-side drawer showing generated code; asks the host to regenerate when inputs change. */
export function CodeDrawer({ request, code, onClose }: CodeDrawerProps) {
  const [target, setTarget] = useState<CodeTarget>(initialTarget);
  const [resolveVariables, setResolve] = useState(false);
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => post({ type: 'generateCode', request, target, resolveVariables }), 150);
    return () => clearTimeout(t);
  }, [request, target, resolveVariables]);

  useEffect(() => {
    // Remember the last language across drawers and reloads.
    try {
      localStorage.setItem(STORAGE_KEY, target);
    } catch {
      // storage unavailable
    }
  }, [target]);

  const current = code && code.target === target ? code.code : null;
  const syntax = CODE_TARGETS.find((t) => t.id === target)!.syntax;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Generate code">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <aside className="relative flex h-full w-[min(640px,100%)] flex-col border-l border-border bg-widget shadow-xl shadow-shadow">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="font-semibold">Code</span>
          <select
            className="ctl min-w-0 max-w-[220px] text-[12px]"
            aria-label="Language"
            value={target}
            onChange={(e) => setTarget(e.target.value as CodeTarget)}
          >
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {CODE_TARGETS.filter((t) => t.group === g).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12px]">
            <input type="checkbox" className="chk" checked={resolveVariables} onChange={(e) => setResolve(e.target.checked)} />
            Resolve variables
          </label>
          <div className="flex-1" />
          <IconButton icon="wrap" title={wrap ? 'Disable word wrap' : 'Word wrap'} active={wrap} onClick={() => setWrap((w) => !w)} />
          {/* Stays open after copying so the "Copied" confirmation is visible; Esc closes. */}
          <CopyButton variant="primary" label="Copy" title="Copy code" disabled={current === null} text={current ?? ''} onCopy={copyToClipboard} />
          <IconButton icon="x" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          {current === null ? (
            <div className="flex items-center gap-2 p-4 text-muted">
              <Spinner /> Generating…
            </div>
          ) : (
            <CodeView className="flex-1" value={current} readOnly wrap={wrap} language={syntax} />
          )}
        </div>
      </aside>
    </div>
  );
}
