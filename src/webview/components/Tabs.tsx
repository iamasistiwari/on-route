import { memo, type ReactNode } from 'react';
import { cx } from './ui';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  badge?: number | string;
}

function TabsInner<T extends string>({
  items,
  active,
  onChange,
  right,
  className,
}: {
  items: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex items-center gap-2 py-1.5', className)}>
      <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
        {items.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => onChange(t.id)}
              className={cx(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-[3px] text-[12px] font-medium transition-colors',
                selected ? 'bg-[var(--or-soft-strong)] text-tab-active' : 'text-tab-inactive hover:bg-[var(--or-soft)] hover:text-tab-active',
              )}
            >
              {t.label}
              {t.badge !== undefined && t.badge !== 0 && (
                <span className="rounded-full bg-[var(--or-soft-strong)] px-1.5 text-[10px] leading-4 tabular-nums">{t.badge}</span>
              )}
            </button>
          );
        })}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </div>
  );
}

export const Tabs = memo(TabsInner) as typeof TabsInner;
