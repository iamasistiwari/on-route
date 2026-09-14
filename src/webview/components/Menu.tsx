// Menus styled like VS Code context menus: the "⋯" MoreMenu button and MenuPopup, which also serves right-click menus.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
  run: () => void;
}

const MENU_WIDTH = 184;

/**
 * A menu at a viewport point. `align: 'end'` puts its right edge at `x` (for buttons at the end of a row).
 * Stays inside the viewport (flipping above `flipAbove` when there is no room below) and closes on
 * outside click, scroll, resize, window blur, Escape or Tab.
 */
export function MenuPopup({
  items,
  x,
  y,
  align = 'start',
  flipAbove,
  ignore,
  onClose,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  align?: 'start' | 'end';
  flipAbove?: number;
  /** Clicks inside this element (e.g. the button that toggles the menu) don't count as outside clicks. */
  ignore?: RefObject<HTMLElement | null>;
  /** `refocus` is true when closed with Escape, so the opener can take focus back. */
  onClose: (refocus: boolean) => void;
}) {
  const [active, setActive] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const left = Math.max(4, Math.min(align === 'end' ? x - MENU_WIDTH : x, window.innerWidth - MENU_WIDTH - 4));
    const top = y + h > window.innerHeight - 4 ? Math.max(4, (flipAbove ?? y) - h - 2) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.focus();
  }, [x, y, align, flipAbove]);

  useEffect(() => {
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !ignore?.current?.contains(t)) onClose(false);
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose(false);
    };
    const onBlur = () => onClose(false);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onBlur);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onBlur);
      window.removeEventListener('blur', onBlur);
    };
  }, [ignore, onClose]);

  const runItem = (item: MenuItem) => {
    onClose(false);
    item.run();
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') setActive((i) => (i + 1) % items.length);
    else if (e.key === 'ArrowUp') setActive((i) => (i - 1 + items.length) % items.length);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(items.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') runItem(items[active]);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(e.key === 'Escape');
    else return;
    e.preventDefault();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      className="or-menu"
      style={{ left: align === 'end' ? x - MENU_WIDTH : x, top: y, width: MENU_WIDTH }}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) => (
        <div key={item.label}>
          {item.separator && <div className="or-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={cx('or-menu-item', i === active && 'is-active', item.danger && 'is-danger')}
            onMouseEnter={() => setActive(i)}
            onClick={() => runItem(item)}
          >
            <span className="flex w-4 shrink-0 justify-center">{item.icon && <Icon name={item.icon} size={14} />}</span>
            <span className="truncate">{item.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Right-click menu for a single element: `open(e, items)` in onContextMenu, render `menu` anywhere. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const close = useCallback(() => setState(null), []);
  const open = useCallback((e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  const menu = state ? <MenuPopup items={state.items} x={state.x} y={state.y} onClose={close} /> : null;
  return { open, isOpen: state !== null, menu };
}

export function MoreMenu({
  items,
  title = 'More actions',
  className,
  buttonClassName,
  onOpenChange,
}: {
  items: MenuItem[];
  title?: string;
  className?: string;
  buttonClassName?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(
    (refocus: boolean) => {
      setAnchor(null);
      onOpenChange?.(false);
      if (refocus) btnRef.current?.focus();
    },
    [onOpenChange],
  );

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (anchor) return close(false);
    setAnchor(btnRef.current!.getBoundingClientRect());
    onOpenChange?.(true);
  };

  return (
    <span className={className}>
      <button
        ref={btnRef}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        tabIndex={-1}
        className={cx(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-inherit hover:bg-[var(--or-soft-strong)]',
          anchor && 'bg-[var(--or-soft-strong)]',
          buttonClassName,
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon name="more" size={14} />
      </button>
      {anchor && <MenuPopup items={items} x={anchor.right} y={anchor.bottom + 2} align="end" flipAbove={anchor.top} ignore={btnRef} onClose={close} />}
    </span>
  );
}
