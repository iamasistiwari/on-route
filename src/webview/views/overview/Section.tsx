import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Button, DirtyDot } from '../../components/ui';

/** One overview page: title, description, actions, then content. */
export function Section({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 max-w-[640px]">
          <h2 id={`${id}-title`} className="text-[18px] font-semibold leading-7">
            {title}
          </h2>
          {description && <p className="mt-1 text-[12.5px] leading-[1.55] text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Auto save for overview drafts: null = off, 0 = immediately, else seconds between saves. Provided by OverviewView. */
export const AutoSaveContext = createContext<number | null>(null);

/** "Immediately" waits this long after the last edit. */
const IMMEDIATE_SAVE_DELAY_MS = 800;

export function SaveActions({ dirty, onSave, onReset }: { dirty: boolean; onSave: () => void; onReset: () => void }) {
  const autoSave = useContext(AutoSaveContext);
  const latest = useRef({ dirty, onSave });
  latest.current = { dirty, onSave };
  useEffect(() => {
    if (!autoSave) return;
    const t = setInterval(() => {
      if (latest.current.dirty) latest.current.onSave();
    }, autoSave * 1000);
    return () => clearInterval(t);
  }, [autoSave]);
  // onSave is a new function on every draft edit, so this restarts the delay while typing.
  useEffect(() => {
    if (autoSave !== 0 || !dirty) return;
    const t = setTimeout(() => latest.current.dirty && latest.current.onSave(), IMMEDIATE_SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [autoSave, dirty, onSave]);
  return (
    <>
      <DirtyDot show={dirty} />
      {dirty && (
        <Button variant="ghost" className="py-0.5" onClick={onReset}>
          Discard
        </Button>
      )}
      <Button variant="primary" className="py-0.5" disabled={!dirty} title={dirty ? 'Save changes' : 'No changes'} onClick={onSave}>
        Save
      </Button>
    </>
  );
}
