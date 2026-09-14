import { describe, expect, it } from 'vitest';
import { appendQueryParam, applyAuth, effectiveAuth } from './auth';
import type { ResolvedRequest } from './model';

const base = (): ResolvedRequest => ({ method: 'GET', url: 'https://x.test/a', headers: [], body: { type: 'none' } });

describe('effectiveAuth', () => {
  it('request auth wins', () => {
    const r = effectiveAuth([
      { source: 'request', auth: { type: 'bearer', token: 't' } },
      { source: 'project', auth: { type: 'basic', username: 'u', password: 'p' } },
    ]);
    expect(r).toEqual({ auth: { type: 'bearer', token: 't' }, source: 'request' });
  });

  it('skips inherit and undefined through the folder chain', () => {
    const r = effectiveAuth([
      { source: 'request', auth: { type: 'inherit' } },
      { source: 'folder users/admin', auth: undefined },
      { source: 'folder users', auth: { type: 'apikey', key: 'k', value: 'v', in: 'header' } },
      { source: 'project', auth: { type: 'bearer', token: 'p' } },
    ]);
    expect(r.source).toBe('folder users');
    expect(r.auth.type).toBe('apikey');
  });

  it('explicit none stops inheritance', () => {
    const r = effectiveAuth([
      { source: 'request', auth: { type: 'none' } },
      { source: 'project', auth: { type: 'bearer', token: 'p' } },
    ]);
    expect(r).toEqual({ auth: { type: 'none' }, source: 'request' });
  });

  it('all inherit => none/none', () => {
    expect(effectiveAuth([{ source: 'request', auth: { type: 'inherit' } }])).toEqual({ auth: { type: 'none' }, source: 'none' });
    expect(effectiveAuth([])).toEqual({ auth: { type: 'none' }, source: 'none' });
  });
});

describe('applyAuth', () => {
  it('bearer', () => {
    const r = applyAuth(base(), { type: 'bearer', token: 'abc' });
    expect(r.headers).toEqual([{ key: 'Authorization', value: 'Bearer abc' }]);
  });

  it('does not mutate input', () => {
    const req = base();
    applyAuth(req, { type: 'bearer', token: 'abc' });
    expect(req.headers).toEqual([]);
  });

  it('basic ascii', () => {
    const r = applyAuth(base(), { type: 'basic', username: 'user', password: 'pass' });
    expect(r.headers[0].value).toBe('Basic dXNlcjpwYXNz');
  });

  it('basic utf-8', () => {
    const r = applyAuth(base(), { type: 'basic', username: 'jösé', password: 'пароль✓' });
    const expected = Buffer.from('jösé:пароль✓', 'utf8').toString('base64');
    expect(r.headers[0].value).toBe(`Basic ${expected}`);
  });

  it('user Authorization header wins (case-insensitive)', () => {
    const req = { ...base(), headers: [{ key: 'authorization', value: 'Custom x' }] };
    expect(applyAuth(req, { type: 'bearer', token: 'abc' }).headers).toEqual([{ key: 'authorization', value: 'Custom x' }]);
    expect(applyAuth(req, { type: 'basic', username: 'a', password: 'b' }).headers).toHaveLength(1);
  });

  it('apikey header', () => {
    const r = applyAuth(base(), { type: 'apikey', key: 'X-Api-Key', value: 'k1', in: 'header' });
    expect(r.headers).toEqual([{ key: 'X-Api-Key', value: 'k1' }]);
    const user = { ...base(), headers: [{ key: 'x-api-key', value: 'mine' }] };
    expect(applyAuth(user, { type: 'apikey', key: 'X-Api-Key', value: 'k1', in: 'header' }).headers).toEqual([
      { key: 'x-api-key', value: 'mine' },
    ]);
  });

  it('apikey query appends, encodes, respects existing query and fragment', () => {
    expect(applyAuth(base(), { type: 'apikey', key: 'api key', value: 'a&b=c', in: 'query' }).url).toBe(
      'https://x.test/a?api%20key=a%26b%3Dc',
    );
    const withQ = { ...base(), url: 'https://x.test/a?x=1#frag' };
    expect(applyAuth(withQ, { type: 'apikey', key: 'k', value: 'v', in: 'query' }).url).toBe('https://x.test/a?x=1&k=v#frag');
    const already = { ...base(), url: 'https://x.test/a?k=mine' };
    expect(applyAuth(already, { type: 'apikey', key: 'k', value: 'v', in: 'query' }).url).toBe('https://x.test/a?k=mine');
  });

  it('none/inherit leave request unchanged', () => {
    expect(applyAuth(base(), { type: 'none' })).toEqual(base());
    expect(applyAuth(base(), { type: 'inherit' })).toEqual(base());
  });
});

describe('appendQueryParam', () => {
  it('handles trailing ? and &', () => {
    expect(appendQueryParam('http://a/?', 'k', 'v')).toBe('http://a/?k=v');
    expect(appendQueryParam('http://a/?x=1&', 'k', 'v')).toBe('http://a/?x=1&k=v');
  });
  it('does not double-encode and keeps placeholders readable', () => {
    expect(appendQueryParam('http://a', 'q', 'hello%20world')).toBe('http://a?q=hello%20world');
    expect(appendQueryParam('http://a', 'q', '{{term}} x')).toBe('http://a?q={{term}}%20x');
    expect(appendQueryParam('http://a', 'p', '100%')).toBe('http://a?p=100%25');
  });
});
