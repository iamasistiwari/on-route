import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, comboFromEvent, comboLabel, matchesCombo, normalizeCombo, normalizeShortcuts } from './shortcuts';

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}, code?: string) => ({
  key: k,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe('normalizeCombo', () => {
  it('orders modifiers and normalizes key case', () => {
    expect(normalizeCombo('shift+mod+s')).toBe('Mod+Shift+S');
    expect(normalizeCombo('Alt+enter')).toBe('Alt+Enter');
    expect(normalizeCombo('F5')).toBe('F5');
  });

  it('rejects plain typing keys, lone modifiers and unknown modifiers', () => {
    expect(normalizeCombo('S')).toBeNull();
    expect(normalizeCombo('Shift+S')).toBeNull();
    expect(normalizeCombo('Mod+Shift')).toBeNull();
    expect(normalizeCombo('Hyper+S')).toBeNull();
    expect(normalizeCombo('')).toBeNull();
  });
});

describe('comboFromEvent', () => {
  it('maps Cmd to Mod on macOS and Ctrl to Mod elsewhere', () => {
    expect(comboFromEvent(key('Enter', { meta: true }), true)).toBe('Mod+Enter');
    expect(comboFromEvent(key('Enter', { ctrl: true }), false)).toBe('Mod+Enter');
    expect(comboFromEvent(key('Enter', { ctrl: true }), true)).toBe('Ctrl+Enter');
  });

  it('uses the physical key when Option changes the typed character', () => {
    expect(comboFromEvent(key('´', { meta: true, alt: true }, 'KeyE'), true)).toBe('Mod+Alt+E');
  });

  it('ignores lone modifiers and plain typing', () => {
    expect(comboFromEvent(key('Meta', { meta: true }), true)).toBeNull();
    expect(comboFromEvent(key('a', {}, 'KeyA'), true)).toBeNull();
  });

  it('matches stored combos', () => {
    expect(matchesCombo(DEFAULT_SHORTCUTS.save, key('s', { meta: true }, 'KeyS'), true)).toBe(true);
    expect(matchesCombo(DEFAULT_SHORTCUTS.save, key('s', { meta: true, shift: true }, 'KeyS'), true)).toBe(false);
  });
});

describe('normalizeShortcuts / comboLabel', () => {
  it('fills defaults and drops invalid entries', () => {
    expect(normalizeShortcuts({ send: 'mod+shift+enter', save: 'S', bogus: 'Mod+X' })).toEqual({
      ...DEFAULT_SHORTCUTS,
      send: 'Mod+Shift+Enter',
    });
    expect(normalizeShortcuts(undefined)).toEqual(DEFAULT_SHORTCUTS);
  });

  it('labels combos per platform', () => {
    expect(comboLabel('Mod+Alt+E', true)).toBe('⌘⌥E');
    expect(comboLabel('Mod+Alt+E', false)).toBe('Ctrl+Alt+E');
    expect(comboLabel('Mod+Enter', false)).toBe('Ctrl+Enter');
  });
});
