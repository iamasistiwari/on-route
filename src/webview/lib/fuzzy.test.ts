import { describe, expect, it } from 'vitest';
import { closestMatch, editDistance, isTypoOf } from './fuzzy';

describe('editDistance', () => {
  it('counts edits, with a swap of neighbours as one', () => {
    expect(editDistance('health', 'health')).toBe(0);
    expect(editDistance('helth', 'health')).toBe(1);
    expect(editDistance('haelth', 'health')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('stops early once above the limit', () => {
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBe(2);
  });
});

describe('isTypoOf', () => {
  it('accepts small typos of whole words and word starts', () => {
    expect(isTypoOf('uesrs', 'users')).toBe(true);
    expect(isTypoOf('atuh', 'authorization')).toBe(true);
    expect(isTypoOf('contcat', 'contact')).toBe(true);
  });

  it('is strict for short tokens and far words', () => {
    expect(isTypoOf('gte', 'get')).toBe(false);
    expect(isTypoOf('login', 'users')).toBe(false);
  });
});

describe('closestMatch', () => {
  it('picks the nearest candidate within the budget', () => {
    expect(closestMatch('baseUlr', ['apiVersion', 'baseUrl', 'userId'])).toBe('baseUrl');
    expect(closestMatch('tokne', ['token', 'tokens'])).toBe('token');
    expect(closestMatch('xyz', ['xya'])).toBeUndefined();
    expect(closestMatch('password', ['baseUrl'])).toBeUndefined();
  });
});
