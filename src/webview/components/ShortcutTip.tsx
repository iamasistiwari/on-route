// Hover tip naming a control's keyboard shortcut. Shown after a long hover so it never gets in the way.
import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

export const SHORTCUT_TIP_DELAY_MS = 3000;

type Handler = (e: SyntheticEvent) => void;
type ChildProps = { onMouseEnter?: Handler; onMouseLeave?: Handler; onMouseDown?: Handler; onBlur?: Handler };

/**
 * Wraps a single element (button, kbd…) and, after hovering it for SHORTCUT_TIP_DELAY_MS, shows a small
 * popover with `label` and the `shortcut` keys. Leaving, pressing or scrolling hides it.
 */
export function ShortcutTip({ label, shortcut, children }: { label: string; shortcut: string; children: ReactElement<ChildProps> }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const hide = () => {
    clearTimeout(timer.current);
    setAnchor(null);
    setPos(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [anchor]);

  // Below the element, centered and kept inside the viewport; above it when there is no room below.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const { width, height } = tip.getBoundingClientRect();
    const margin = 6;
    const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - margin);
    const below = anchor.bottom + margin;
    const top = below + height > window.innerHeight - margin ? anchor.top - height - margin : below;
    setPos({ left, top });
  }, [anchor]);

  const chain = (own: Handler, theirs?: Handler): Handler => (e) => {
    theirs?.(e);
    own(e);
  };
  const child = cloneElement(children, {
    onMouseEnter: chain((e) => {
      const el = e.currentTarget as HTMLElement;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => el.isConnected && setAnchor(el.getBoundingClientRect()), SHORTCUT_TIP_DELAY_MS);
    }, children.props.onMouseEnter),
    onMouseLeave: chain(hide, children.props.onMouseLeave),
    onMouseDown: chain(hide, children.props.onMouseDown),
    onBlur: chain(hide, children.props.onBlur),
  });

  return (
    <>
      {child}
      {anchor &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="shortcut-tip"
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            <span>{label}</span>
            <kbd>{shortcut}</kbd>
          </div>,
          document.body,
        )}
    </>
  );
}
