// Customizable keyboard shortcuts, shared by the extension host (settings, context keys) and the webviews.
// A combo is written as "Mod+Alt+Shift+Key": Mod is Cmd on macOS and Ctrl elsewhere; "Ctrl" is only used on
// macOS for the real Control key.

export const SHORTCUT_ACTIONS = [
  { id: 'send', label: 'Send request', description: 'In a request editor', default: 'Mod+Enter' },
  { id: 'save', label: 'Save request', description: 'In a request editor', default: 'Mod+S' },
  { id: 'focusFilter', label: 'Search endpoints', description: 'Focus the filter in the sidebar', default: 'Mod+F' },
  { id: 'selectEnvironment', label: 'Select environment', description: 'Pick the active environment', default: 'Mod+Alt+E' },
  { id: 'toggleRequestPane', label: 'Show / hide request pane', description: 'In a request editor, to see only the response', default: 'Mod+Alt+Enter' },
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]['id'];
export type Shortcuts = Record<ShortcutAction, string>;

export const DEFAULT_SHORTCUTS = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, a.default])) as Shortcuts;

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
const NAMED_KEYS: Record<string, string> = { ' ': 'Space', Esc: 'Escape', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };

/** Canonical form of a combo string (modifier order, key case), or null when it is not a usable shortcut. */
export function normalizeCombo(combo: string): string | null {
  if (typeof combo !== 'string') return null;
  const parts = combo.split('+').map((p) => p.trim());
  // "Mod++" (the plus key) splits into trailing empty parts.
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+');
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set<string>();
  for (const p of parts) {
    const m = MODIFIERS.find((x) => x.toLowerCase() === p.toLowerCase());
    if (!m) return null;
    mods.add(m);
  }
  const k = key.length === 1 ? key.toUpperCase() : (NAMED_KEYS[key] ?? key[0].toUpperCase() + key.slice(1));
  if (MODIFIERS.some((m) => m.toLowerCase() === k.toLowerCase()) || ['Meta', 'Control', 'Alt', 'Shift'].includes(k)) return null;
  // Plain keys (or Shift+key) would break typing; function keys are fine alone.
  if (!mods.has('Mod') && !mods.has('Ctrl') && !mods.has('Alt') && !/^F\d{1,2}$/.test(k)) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), k].join('+');
}

/** Settings value -> full shortcut map; missing or invalid entries fall back to the defaults. */
export function normalizeShortcuts(raw: unknown): Shortcuts {
  const out = { ...DEFAULT_SHORTCUTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const a of SHORTCUT_ACTIONS) {
    const v = (raw as Record<string, unknown>)[a.id];
    const combo = typeof v === 'string' ? normalizeCombo(v) : null;
    if (combo) out[a.id] = combo;
  }
  return out;
}

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The combo a key press stands for, or null for a lone modifier / plain typing key. */
export function comboFromEvent(e: KeyLike, isMac: boolean): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key) && !/^(Key|Digit)/.test(e.code ?? '')) return null;
  // Option / Shift change e.key on macOS ("⌥E" types "´"): use the physical letter or digit instead.
  const physical = /^Key([A-Z])$/.exec(e.code ?? '')?.[1] ?? /^Digit(\d)$/.exec(e.code ?? '')?.[1];
  const key = physical ?? e.key;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (!isMac && e.metaKey) return null;
  return normalizeCombo([...parts, key === '+' ? '+' : key].join('+').replace(/\+\+$/, '++'));
}

export function matchesCombo(combo: string, e: KeyLike, isMac: boolean): boolean {
  const pressed = comboFromEvent(e, isMac);
  return pressed !== null && pressed === normalizeCombo(combo);
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const KEY_LABELS: Record<string, string> = { Enter: 'Enter', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };

/** "Mod+Alt+E" -> "⌘⌥E" on macOS, "Ctrl+Alt+E" elsewhere. */
export function comboLabel(combo: string, isMac: boolean): string {
  const parts = (normalizeCombo(combo) ?? combo).split('+');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.splice(-2, 2, '+');
  const key = parts.pop() ?? '';
  const k = KEY_LABELS[key] ?? key;
  if (isMac) return parts.map((p) => MAC_SYMBOLS[p] ?? p).join('') + k;
  return [...parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)), k].join('+');
}
