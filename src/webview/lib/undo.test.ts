import { describe, expect, it } from 'vitest';
import type { RequestDef } from '../../shared/model';
import { UndoStack, requestEditKey } from './undo';

describe('UndoStack', () => {
  it('groups quick edits of the same kind and undoes / redoes them as one step', () => {
    const s = new UndoStack<string>(200, 500);
    s.record('', 'url', 0);
    s.record('h', 'url', 100);
    s.record('ht', 'url', 200);
    s.record('htt', 'body', 300);
    expect(s.undo('http')).toBe('htt');
    expect(s.undo('htt')).toBe('');
    expect(s.undo('')).toBeUndefined();
    expect(s.redo('')).toBe('htt');
    expect(s.redo('htt')).toBe('http');
    expect(s.redo('http')).toBeUndefined();
  });

  it('starts a new step after a pause and drops redo on a new edit', () => {
    const s = new UndoStack<string>(200, 500);
    s.record('a', 'url', 0);
    s.record('ab', 'url', 2000);
    expect(s.undo('abc')).toBe('ab');
    s.record('ab', 'url', 3000);
    expect(s.redo('abx')).toBeUndefined();
    expect(s.undo('abx')).toBe('ab');
    expect(s.undo('ab')).toBe('a');
  });

  it('caps the history', () => {
    const s = new UndoStack<number>(2, 0);
    s.record(1, 'a', 0);
    s.record(2, 'b', 10);
    s.record(3, 'c', 20);
    expect(s.undo(4)).toBe(3);
    expect(s.undo(3)).toBe(2);
    expect(s.undo(2)).toBeUndefined();
  });
});

describe('requestEditKey', () => {
  const base: RequestDef = { id: 'a', name: 'A', method: 'GET', url: '/x', params: [], headers: [], auth: { type: 'inherit' }, body: { type: 'none' } };
  it('names the edited fields and ignores id, name and order', () => {
    expect(requestEditKey(base, { ...base, url: '/x?a=1', params: [{ key: 'a', value: '1' }] })).toBe('url');
    expect(requestEditKey(base, { ...base, headers: [{ key: 'A', value: '1' }] })).toBe('headers');
    expect(requestEditKey(base, { ...base, id: 'b', name: 'B', order: 2 })).toBe('');
  });
});

describe('UndoStack snapshot', () => {
  it('restores past and future steps in a new stack', () => {
    const a = new UndoStack<number>();
    a.record(1, 'x', 0);
    a.record(2, 'y', 10_000);
    expect(a.undo(3)).toBe(2);
    const b = new UndoStack<number>();
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.redo(2)).toBe(3);
    expect(b.undo(3)).toBe(2);
    expect(b.undo(2)).toBe(1);
    expect(b.undo(1)).toBeUndefined();
  });

  it('never groups a new edit with a restored step', () => {
    const a = new UndoStack<number>();
    a.record(1, 'x');
    const b = new UndoStack<number>();
    b.restore(a.snapshot());
    b.record(2, 'x');
    expect(b.undo(3)).toBe(2);
    expect(b.undo(2)).toBe(1);
  });
});
