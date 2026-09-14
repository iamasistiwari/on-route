import { useEffect } from 'react';
import { cx } from './ui';

export interface ToastData {
  id: number;
  message: string;
  kind?: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export function Toast({ toast, onDismiss }: { toast: ToastData | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, toast.kind === 'error' ? 8000 : 6000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);
  if (!toast) return null;
  return (
    <div
      role="status"
      className={cx(
        'fixed bottom-3 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-full border py-1.5 pl-4 pr-2 shadow-lg shadow-shadow',
        'bg-widget text-fg',
        toast.kind === 'error' ? 'border-error' : 'border-[var(--or-line)]',
      )}
    >
      <span className={cx('truncate', toast.kind === 'error' && 'text-error')}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="text-link hover:underline"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-[var(--or-soft-strong)] hover:text-fg" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
