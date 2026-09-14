// Single-line input with {{variable}} highlighting (known = blue, unknown = red) and `{{` autocomplete.
// Optional typing suggestions (`suggest`) show as a list plus faint inline text; Tab accepts.
// Highlighting uses a transparent input over a styled mirror; popups render in a fixed-position portal
// so they are not clipped by scrolling tables.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { VariableInfo } from '../../shared/protocol';
import { ghostText, type SuggestionKind, type TextSuggestion } from '../lib/suggest';
import {
  applyCompletion,
  completionRange,
  describeVar,
  isKnownVar,
  resolvedKeys,
  suggestVariables,
  tokenizeTemplate,
  unresolvedNames,
  varAt,
  VAR_HOVER_MS,
  type CompletionRange,
} from '../lib/vars';
import { METHOD_SHORT, METHOD_TEXT } from './MethodBadge';
import { cx } from './ui';

export interface VarInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'> {
  value: string;
  onChange: (text: string) => void;
  variables: readonly VariableInfo[];
  /** Wrapper classes (layout, border, background). */
  className?: string;
  /** Classes shared by the input and its highlight mirror (padding, font, line height) so glyphs line up. */
  fieldClassName?: string;
  /** Password-style input: no highlighting, autocomplete still works. */
  masked?: boolean;
  /**
   * Typing suggestions for the whole text while the caret is at the end. Accept with Tab, → at the end, a
   * click, or Enter after choosing with ↑↓ (plain Enter keeps its normal meaning).
   */
  suggest?: (text: string) => TextSuggestion[];
}

const MAX_ITEMS = 50;
const POPUP_WIDTH = 320;
const POPUP_MAX_HEIGHT = 220;
const HINT_MAX_WIDTH = 640;

const KIND_LABEL: Record<SuggestionKind, string> = {
  endpoint: '',
  segment: 'path',
  word: 'word',
  param: 'param',
  variable: 'var',
  host: 'host',
};

let measureCanvas: HTMLCanvasElement | undefined;
function textWidth(input: HTMLInputElement, text: string): number {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0;
  const cs = getComputedStyle(input);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return ctx.measureText(text).width;
}

type PopupPos = { left: number; top?: number; bottom?: number; width: number };

/** Index of the character under client x in a single-line input (text measured with its font). */
function charIndexAt(input: HTMLInputElement, clientX: number): number {
  const rect = input.getBoundingClientRect();
  const padLeft = parseFloat(getComputedStyle(input).paddingLeft) || 0;
  const x = clientX - rect.left - padLeft + input.scrollLeft;
  const text = input.value;
  if (x < 0) return -1;
  // Binary search the first prefix wider than x.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (textWidth(input, text.slice(0, mid + 1)) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type HoverVar = { name: string; from: number; left: number; top?: number; bottom?: number };

/** Below the input when there is room, otherwise above it. */
function placePopup(rect: DOMRect, left: number, width: number): PopupPos {
  const below = rect.bottom + POPUP_MAX_HEIGHT + 4 <= window.innerHeight || rect.top < POPUP_MAX_HEIGHT;
  return below ? { left, top: rect.bottom + 2, width } : { left, bottom: window.innerHeight - rect.top + 2, width };
}

function VarInputInner({ value, onChange, variables, className, fieldClassName, masked, suggest, onKeyDown, onBlur, title, placeholder, ...rest }: VarInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [range, setRange] = useState<CompletionRange | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<PopupPos | null>(null);

  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;
  const [hints, setHints] = useState<TextSuggestion[]>([]);
  const [hintActive, setHintActive] = useState(0);
  /** The user picked a hint with the arrow keys, so Enter accepts it instead of submitting. */
  const [hintChosen, setHintChosen] = useState(false);
  const [hintPos, setHintPos] = useState<PopupPos | null>(null);
  const hintsOpen = hints.length > 0 && !range;

  /** {{variable}} under the pointer (null when none) and the one whose value is shown after resting on it. */
  const pointerVarRef = useRef<{ name: string; from: number } | null>(null);
  const [overVar, setOverVar] = useState(false);
  const [hoverVar, setHoverVar] = useState<HoverVar | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideHover = useCallback(() => {
    clearTimeout(hoverTimer.current);
    pointerVarRef.current = null;
    setOverVar(false);
    setHoverVar(null);
  }, []);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const keys = useMemo(() => resolvedKeys(variables), [variables]);
  const segments = useMemo(() => tokenizeTemplate(value), [value]);
  const highlight = !masked && segments.some((s) => s.varName !== undefined);
  const items = useMemo(() => (range ? suggestVariables(variables, range.query).slice(0, MAX_ITEMS) : []), [range, variables]);
  const unresolved = useMemo(() => unresolvedNames(value, keys), [value, keys]);
  const ghost = hintsOpen && !masked ? ghostText(value, hints[hintActive]) : '';
  const showMirror = highlight || ghost !== '';

  const syncScroll = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (input && mirror) mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && pendingCaret.current !== null && input.value === value) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    syncScroll();
  }, [value, showMirror, syncScroll]);

  const close = useCallback(() => {
    setRange(null);
    setHints([]);
  }, []);

  /** Re-evaluate the `{{` completion range from the caret. */
  const refresh = useCallback(() => {
    const input = inputRef.current;
    if (!input || document.activeElement !== input) return;
    const caret = input.selectionStart ?? 0;
    const next = input.selectionStart === input.selectionEnd ? completionRange(input.value, caret) : null;
    setRange((prev) => {
      if (!next) return null;
      if (prev && prev.from === next.from && prev.to === next.to && prev.query === next.query) return prev;
      if (!prev || prev.query !== next.query) setActive(0);
      return next;
    });
  }, []);

  /** Recompute typing suggestions. `open`: show them (after typing); otherwise only refresh an open list. */
  const updateHints = useCallback((open: boolean) => {
    const input = inputRef.current;
    const fn = suggestRef.current;
    if (!input || !fn || document.activeElement !== input) return;
    const end = input.value.length;
    if (input.selectionStart !== end || input.selectionEnd !== end || completionRange(input.value, end)) {
      setHints([]);
      return;
    }
    if (open) {
      setHints(fn(input.value));
      setHintActive(0);
      setHintChosen(false);
    } else {
      setHints((prev) => (prev.length ? fn(input.value) : prev));
    }
  }, []);

  // Position the variable popup under the `{{` being completed.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!range || !input) {
      setPos(null);
      return;
    }
    const rect = input.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(input).paddingLeft) || 0;
    const x = Math.min(rect.width, Math.max(0, padLeft + textWidth(input, input.value.slice(0, range.from)) - input.scrollLeft));
    const left = Math.max(4, Math.min(rect.left + x, window.innerWidth - POPUP_WIDTH - 4));
    setPos(placePopup(rect, left, POPUP_WIDTH));
  }, [range]);

  // The suggestion list spans the input.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!hintsOpen || !input) {
      setHintPos(null);
      return;
    }
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, POPUP_WIDTH), HINT_MAX_WIDTH, window.innerWidth - 8);
    setHintPos(placePopup(rect, Math.max(4, Math.min(rect.left, window.innerWidth - width - 4)), width));
  }, [hintsOpen, hints]);

  // Popups are fixed-positioned: close them when anything around the input scrolls or the view resizes.
  const anyOpen = !!range || hintsOpen;
  useEffect(() => {
    if (!anyOpen) return;
    const onScroll = (e: Event) => {
      if (e.target !== inputRef.current && !listRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [anyOpen, close]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, items, hintActive, hints]);

  const accept = (key: string) => {
    if (!range) return;
    const next = applyCompletion(value, range, key);
    pendingCaret.current = next.caret;
    setRange(null);
    onChange(next.text);
  };

  const acceptHint = (s: TextSuggestion) => {
    pendingCaret.current = s.value.length;
    onChange(s.value);
    // Keep going: after accepting "gst/" the next segment is suggested right away.
    requestAnimationFrame(() => updateHints(true));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (range) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (items.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const d = e.key === 'ArrowDown' ? 1 : -1;
          setActive((i) => (i + d + items.length) % items.length);
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && plain && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          accept(items[Math.min(active, items.length - 1)].key);
          return;
        }
      }
    } else if (hintsOpen) {
      const current = hints[Math.min(hintActive, hints.length - 1)];
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setHintActive((i) => (i + d + hints.length) % hints.length);
        setHintChosen(true);
        return;
      }
      const atEnd = e.currentTarget.selectionStart === value.length;
      if ((e.key === 'Tab' && plain && !e.shiftKey) || (e.key === 'ArrowRight' && plain && atEnd && ghost) || (e.key === 'Enter' && plain && hintChosen)) {
        e.preventDefault();
        e.stopPropagation();
        acceptHint(current);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setHints([]);
        return;
      }
    } else if (e.key === 'ArrowDown' && plain && suggestRef.current && e.currentTarget.selectionStart === value.length) {
      // Open the list on demand.
      const list = suggestRef.current(value);
      if (list.length) {
        e.preventDefault();
        setHints(list);
        setHintActive(0);
        setHintChosen(true);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const hint = unresolved.length
    ? `Unresolved: ${unresolved.map((n) => { const s = describeVar(n, variables).suggestion; return s ? `${n} (did you mean ${s}?)` : n; }).join(', ')}`
    : undefined;

  const onPointerMove = (e: MouseEvent<HTMLInputElement>) => {
    const input = inputRef.current;
    if (!input || masked || !highlight) return;
    const hit = varAt(input.value, charIndexAt(input, e.clientX));
    const prev = pointerVarRef.current;
    if (hit && prev && prev.name === hit.name && prev.from === hit.from) return;
    clearTimeout(hoverTimer.current);
    setHoverVar(null);
    pointerVarRef.current = hit && { name: hit.name, from: hit.from };
    setOverVar(!!hit);
    if (!hit) return;
    hoverTimer.current = setTimeout(() => {
      if (!inputRef.current || pointerVarRef.current?.from !== hit.from) return;
      const rect = input.getBoundingClientRect();
      const padLeft = parseFloat(getComputedStyle(input).paddingLeft) || 0;
      const x = rect.left + padLeft + textWidth(input, input.value.slice(0, hit.from)) - input.scrollLeft;
      const left = Math.max(4, Math.min(Math.max(rect.left, x), window.innerWidth - POPUP_WIDTH - 4));
      const below = rect.bottom + 90 <= window.innerHeight;
      setHoverVar({ name: hit.name, from: hit.from, left, ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }) });
    }, VAR_HOVER_MS);
  };
  const hovered = hoverVar && !range && !hintsOpen ? describeVar(hoverVar.name, variables) : null;

  return (
    <div className={cx('var-field relative min-w-0', className)}>
      {showMirror && (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div ref={mirrorRef} className={cx('var-mirror whitespace-pre', fieldClassName)}>
            {highlight ? (
              segments.map((s, i) =>
                s.varName !== undefined ? (
                  <span key={i} className={cx('rounded-md', isKnownVar(s.varName, keys) ? 'bg-var-known/15 text-var-known' : 'bg-error/15 text-error')}>
                    {s.text}
                  </span>
                ) : (
                  <span key={i}>{s.text}</span>
                ),
              )
            ) : (
              // The input draws the text itself; the mirror only positions the ghost after it.
              <span className="text-transparent">{value}</span>
            )}
            {ghost && <span className="var-ghost">{ghost}</span>}
          </div>
        </div>
      )}
      <input
        {...rest}
        ref={inputRef}
        type={masked ? 'password' : 'text'}
        // The native tooltip would cover the variable value tooltip.
        title={overVar ? undefined : (title ?? hint)}
        // The ghost suggestion sits where the placeholder would be; showing both overlaps them.
        placeholder={ghost ? undefined : placeholder}
        className={cx('relative block w-full min-w-0 bg-transparent', highlight && 'var-input-overlay', fieldClassName)}
        value={value}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={(!!range && items.length > 0) || hintsOpen}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          // Caret is only final after React applies the value; evaluate on the next frame.
          requestAnimationFrame(() => {
            refresh();
            updateHints(true);
          });
        }}
        onSelect={() => {
          syncScroll();
          refresh();
          updateHints(false);
        }}
        onScroll={() => {
          syncScroll();
          hideHover();
        }}
        onMouseMove={onPointerMove}
        onMouseLeave={hideHover}
        onMouseDown={hideHover}
        onKeyUp={syncScroll}
        onKeyDown={(e) => {
          hideHover();
          handleKeyDown(e);
        }}
        onBlur={(e) => {
          close();
          onBlur?.(e);
        }}
      />
      {range &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            className="var-suggest"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: POPUP_MAX_HEIGHT }}
            // Keep focus (and the caret) in the input while clicking a suggestion.
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-muted">
                {range.query ? (
                  <>
                    No variable named <span className="font-mono text-error">{range.query}</span>. Define it in Overview › Variables.
                  </>
                ) : (
                  'No variables defined. Add them in Overview › Variables or an environment.'
                )}
              </div>
            ) : (
              items.map((v, i) => (
                <div
                  key={v.key}
                  role="option"
                  aria-selected={i === active}
                  className="var-suggest-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => accept(v.key)}
                >
                  <span className={cx('shrink-0 font-mono text-[12px]', v.resolved ? 'text-var-known' : 'text-error')}>{v.key}</span>
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] opacity-70">
                    {v.secret ? (v.resolved ? '••••••' : 'no value') : v.source === 'dynamic' ? 'generated' : v.value}
                  </span>
                  <span className="shrink-0 text-[10px] opacity-60">{v.source}</span>
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
      {hovered &&
        hoverVar &&
        createPortal(
          <div role="tooltip" className="var-hover" style={{ left: hoverVar.left, top: hoverVar.top, bottom: hoverVar.bottom, maxWidth: HINT_MAX_WIDTH }}>
            <div className="flex items-baseline gap-2">
              <span className={cx('font-mono text-[12px] font-semibold', hovered.state === 'unresolved' ? 'text-error' : 'text-var-known')}>{hovered.name}</span>
              {hovered.source && <span className="text-[10.5px] opacity-65">{hovered.source}</span>}
            </div>
            <div className={cx('mt-0.5 break-all font-mono text-[12px]', hovered.state !== 'value' && 'italic opacity-75')}>{hovered.value}</div>
            {hovered.suggestion && (
              <div className="mt-1 text-[11.5px]">
                Did you mean <span className="font-mono text-var-known">{hovered.suggestion}</span>?
              </div>
            )}
          </div>,
          document.body,
        )}
      {hintsOpen &&
        hintPos &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            aria-label="Suggestions"
            className="var-suggest"
            style={{ left: hintPos.left, top: hintPos.top, bottom: hintPos.bottom, width: hintPos.width, maxHeight: POPUP_MAX_HEIGHT + 24 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {hints.map((s, i) => (
              <div
                key={s.value}
                role="option"
                aria-selected={i === hintActive}
                className="var-suggest-item"
                onMouseEnter={() => setHintActive(i)}
                onClick={() => acceptHint(s)}
              >
                <span className={cx('w-9 shrink-0 font-mono text-[10px] font-bold', s.method ? METHOD_TEXT[s.method] : 'font-normal opacity-60')}>
                  {s.method ? METHOD_SHORT[s.method] : KIND_LABEL[s.kind]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{s.label}</span>
                {s.detail && <span className="max-w-[40%] shrink-0 truncate text-[11px] opacity-65">{s.detail}</span>}
              </div>
            ))}
            <div className="var-suggest-foot">Tab accepts, ↑↓ chooses, Esc hides</div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export const VarInput = memo(VarInputInner);
