// Copy helpers for body editors:
//  - double-click an object key: copy its value (JSON only)
//  - double-click inside a string value: select the text between the quotes (JSON only)
//  - keep a mouse selection for HOLD_COPY_MS: copy it (read-only views), with a countdown toast
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { post } from '../vscode';
import { propertyValueAt, selectionCopyText, stringContentAt } from '../lib/jsonCopy';
import { Icon } from './Icon';

export const HOLD_COPY_MS = 2000;

export interface CopyAssistHandlers {
  holdStart: () => void;
  holdCancel: () => void;
  copied: (text: string, label: string) => void;
}

export interface CopyAssistOptions {
  /** Double-click on keys copies values, double-click in strings selects their content. */
  json: boolean;
  /** Copy a mouse selection that stays put for HOLD_COPY_MS. */
  hold: boolean;
}

export function copyText(text: string): void {
  const viaHost = () => post({ type: 'copyToClipboard', text });
  try {
    navigator.clipboard.writeText(text).catch(viaHost);
  } catch {
    viaHost();
  }
}

export function copyAssist(handlers: { current: CopyAssistHandlers }, opts: CopyAssistOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      pointerDown = false;
      constructor(readonly view: EditorView) {
        document.addEventListener('mouseup', this.onMouseUp, true);
      }
      onMouseUp = () => {
        if (!this.pointerDown) return;
        this.pointerDown = false;
        // Let CodeMirror finish its own mouseup handling first.
        setTimeout(() => this.startHold(), 0);
      };
      startHold() {
        this.cancel();
        const sel = this.view.state.selection.main;
        if (!opts.hold || sel.empty || !this.view.hasFocus) return;
        handlers.current.holdStart();
        this.timer = setTimeout(() => {
          this.timer = undefined;
          const { from, to } = this.view.state.selection.main;
          const text = selectionCopyText(this.view.state, from, to);
          if (text) handlers.current.copied(text, 'Copied selection');
          else handlers.current.holdCancel();
        }, HOLD_COPY_MS);
      }
      cancel() {
        if (this.timer === undefined) return;
        clearTimeout(this.timer);
        this.timer = undefined;
        handlers.current.holdCancel();
      }
      update(u: ViewUpdate) {
        if (this.timer !== undefined && (u.selectionSet || u.docChanged || (u.focusChanged && !u.view.hasFocus))) this.cancel();
      }
      destroy() {
        document.removeEventListener('mouseup', this.onMouseUp, true);
        this.cancel();
      }
    },
    {
      eventHandlers: {
        mousedown(e, view) {
          this.cancel();
          if (e.button !== 0) return false;
          this.pointerDown = true;
          if (!opts.json || e.detail !== 2 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          const prop = propertyValueAt(view.state, pos);
          if (prop) {
            e.preventDefault();
            this.pointerDown = false;
            handlers.current.copied(prop.text, `Copied value of “${prop.key}”`);
            return true;
          }
          const str = stringContentAt(view.state, pos);
          if (str && str.to > str.from) {
            e.preventDefault();
            view.focus();
            view.dispatch({
              selection: { anchor: str.from, head: str.to },
              userEvent: 'select.pointer',
            });
            return true;
          }
          return false;
        },
        keydown(e) {
          if (e.key === 'Escape') this.cancel();
          return false;
        },
      },
    },
  );
  return plugin;
}

type ToastState =
  | { id: number; phase: 'holding' }
  | {
      id: number;
      phase: 'copied';
      label: string;
      preview: string;
      chars: number;
    };

const RING = 2 * Math.PI * 9;

/** Countdown / confirmation pill for copyAssist, plus the handlers that drive it. */
export function useCopyAssistToast(onCopy: (text: string) => void = copyText) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const onCopyRef = useRef(onCopy);
  onCopyRef.current = onCopy;

  const handlers = useRef<CopyAssistHandlers>({
    holdStart: () => {
      clearTimeout(hideTimer.current);
      setToast({ id: Date.now(), phase: 'holding' });
    },
    holdCancel: () => setToast((t) => (t?.phase === 'holding' ? null : t)),
    copied: (text, label) => {
      onCopyRef.current(text);
      const flat = text.replace(/\s+/g, ' ').trim();
      setToast({
        id: Date.now(),
        phase: 'copied',
        label,
        preview: flat.length > 48 ? `${flat.slice(0, 48)}…` : flat,
        chars: text.length,
      });
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setToast(null), 1800);
    },
  });

  const dismiss = useCallback(() => setToast(null), []);
  const element = toast
    ? createPortal(
        <div key={toast.id} role="status" aria-live="polite" className="copy-assist-toast" data-phase={toast.phase} onClick={dismiss}>
          {toast.phase === 'holding' ? (
            <>
              <svg className="copy-assist-ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden>
                <circle cx="11" cy="11" r="9" className="copy-assist-ring-track" />
                <circle
                  cx="11"
                  cy="11"
                  r="9"
                  className="copy-assist-ring-bar"
                  style={{
                    strokeDasharray: RING,
                    animationDuration: `${HOLD_COPY_MS}ms`,
                  }}
                />
              </svg>
              <span className="flex flex-col leading-tight">
                <span className="font-medium">Keep it selected to copy</span>
                <Countdown ms={HOLD_COPY_MS} />
              </span>
            </>
          ) : (
            <>
              <span className="copy-assist-check">
                <Icon name="check" size={13} />
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="font-medium">
                  {toast.label}
                  <span className="ml-1.5 text-[11px] font-normal text-muted">{toast.chars.toLocaleString()} chars</span>
                </span>
                {toast.preview && <span className="truncate font-mono text-[11px] text-muted">{toast.preview}</span>}
              </span>
            </>
          )}
        </div>,
        document.body,
      )
    : null;
  return { handlers, element };
}

function Countdown({ ms }: { ms: number }) {
  const [left, setLeft] = useState(ms);
  useEffect(() => {
    const start = performance.now();
    const t = setInterval(() => setLeft(Math.max(0, ms - (performance.now() - start))), 100);
    return () => clearInterval(t);
  }, [ms]);
  return <span className="text-[11px] tabular-nums text-muted">Copying in {(left / 1000).toFixed(1)}s · Esc to cancel</span>;
}
