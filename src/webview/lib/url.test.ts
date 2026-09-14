import { describe, expect, it } from 'vitest';
import { applyUrlEdit, buildUrl, mergeParams, parseQueryString, splitUrl, urlTextMatches } from './url';

describe('splitUrl / parseQueryString', () => {
  it('splits base and query', () => {
    expect(splitUrl('{{baseUrl}}/users?page=2&q={{term}}')).toEqual({
      base: '{{baseUrl}}/users',
      query: [
        { key: 'page', value: '2' },
        { key: 'q', value: '{{term}}' },
      ],
      hasQuery: true,
    });
  });
  it('handles no query, flags and values containing =', () => {
    expect(splitUrl('http://x')).toEqual({ base: 'http://x', query: [], hasQuery: false });
    expect(parseQueryString('flag&a=b=c&&')).toEqual([
      { key: 'flag', value: '' },
      { key: 'a', value: 'b=c' },
    ]);
  });
  it('keeps encoding verbatim', () => {
    expect(parseQueryString('q=hello%20world')).toEqual([{ key: 'q', value: 'hello%20world' }]);
  });
});

describe('buildUrl', () => {
  it('appends only enabled params', () => {
    expect(
      buildUrl('http://x/a', [
        { key: 'a', value: '1' },
        { key: 'b', value: '2', enabled: false },
        { key: 'c', value: '' },
      ]),
    ).toBe('http://x/a?a=1&c');
  });
  it('uses & when url already has a query', () => {
    expect(buildUrl('http://x?z=1', [{ key: 'a', value: '1' }])).toBe('http://x?z=1&a=1');
  });
  it('returns url when no params', () => {
    expect(buildUrl('http://x', [])).toBe('http://x');
  });
});

describe('mergeParams', () => {
  it('keeps disabled rows and descriptions in place', () => {
    const existing = [
      { key: 'a', value: '1', description: 'first' },
      { key: 'off', value: 'x', enabled: false },
      { key: 'b', value: '2' },
    ];
    expect(mergeParams(existing, [{ key: 'a', value: '9' }, { key: 'b', value: '2' }, { key: 'c', value: '3' }])).toEqual([
      { key: 'a', value: '9', description: 'first' },
      { key: 'off', value: 'x', enabled: false },
      { key: 'b', value: '2' },
      { key: 'c', value: '3' },
    ]);
  });
  it('drops surplus enabled rows', () => {
    expect(mergeParams([{ key: 'a', value: '1' }, { key: 'b', value: '2' }], [{ key: 'a', value: '1' }])).toEqual([
      { key: 'a', value: '1' },
    ]);
  });
});

describe('applyUrlEdit / urlTextMatches', () => {
  it('round-trips', () => {
    const cur = { url: 'http://x', params: [{ key: 'k', value: 'v', enabled: false }] };
    const next = applyUrlEdit(cur, 'http://x/y?a=1');
    expect(next).toEqual({ url: 'http://x/y', params: [{ key: 'k', value: 'v', enabled: false }, { key: 'a', value: '1' }] });
    expect(buildUrl(next.url, next.params)).toBe('http://x/y?a=1');
  });
  it('treats partially typed text as matching', () => {
    expect(urlTextMatches('http://x?', 'http://x', [])).toBe(true);
    expect(urlTextMatches('http://x?a=', 'http://x', [{ key: 'a', value: '' }])).toBe(true);
    expect(urlTextMatches('http://x?a=1', 'http://x', [{ key: 'a', value: '2' }])).toBe(false);
  });
});
