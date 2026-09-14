import { describe, expect, it } from 'vitest';
import { appendOrder, byOrder, orderUpdates, placeBefore } from './order';

describe('order', () => {
  it('sorts ordered items first, then by name', () => {
    const items = [{ name: 'b' }, { name: 'z', order: 1 }, { name: 'a' }, { name: 'y', order: 0 }];
    expect(items.sort(byOrder).map((i) => i.name)).toEqual(['y', 'z', 'a', 'b']);
  });

  it('places an id before another or at the end', () => {
    expect(placeBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(placeBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
    expect(placeBefore(['a', 'b'], 'x', 'b')).toEqual(['a', 'x', 'b']);
    expect(placeBefore(['a', 'b'], 'x', 'missing')).toEqual(['a', 'b', 'x']);
  });

  it('numbers an unordered folder and only rewrites changed entries afterwards', () => {
    const unordered = [
      { id: 'f/a', name: 'a' },
      { id: 'f/b', name: 'b' },
      { id: 'f/c', name: 'c' },
    ];
    expect(orderUpdates(unordered, 'f/c', 'f/a')).toEqual([
      { id: 'f/c', order: 0 },
      { id: 'f/a', order: 1 },
      { id: 'f/b', order: 2 },
    ]);
    const ordered = [
      { id: 'f/c', name: 'c', order: 0 },
      { id: 'f/a', name: 'a', order: 1 },
      { id: 'f/b', name: 'b', order: 2 },
    ];
    expect(orderUpdates(ordered, 'f/b', 'f/a')).toEqual([
      { id: 'f/b', order: 1 },
      { id: 'f/a', order: 2 },
    ]);
    expect(orderUpdates(ordered, 'f/a', 'f/b')).toEqual([]);
  });

  it('appends after arranged folders only', () => {
    expect(appendOrder([])).toBeUndefined();
    expect(appendOrder([{ order: 0 }, {}])).toBeUndefined();
    expect(appendOrder([{ order: 0 }, { order: 4 }])).toBe(5);
  });
});
