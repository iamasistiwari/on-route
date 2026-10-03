import { describe, expect, it } from 'vitest';
import { authRow } from './InheritedAuthRows';

describe('authRow', () => {
  it('apikey header lands in headers, not params', () => {
    const auth = { type: 'apikey', key: 'api-key', value: 's3cret', in: 'header' } as const;
    expect(authRow(auth, 'header')).toEqual({ key: 'api-key', value: 's3cret', secret: true });
    expect(authRow(auth, 'query')).toBeNull();
  });
  it('apikey query lands in params', () => {
    const auth = { type: 'apikey', key: 'k', value: 'v', in: 'query' } as const;
    expect(authRow(auth, 'query')?.key).toBe('k');
    expect(authRow(auth, 'header')).toBeNull();
  });
  it('bearer and basic become Authorization', () => {
    expect(authRow({ type: 'bearer', token: 't' }, 'header')?.value).toBe('Bearer t');
    expect(authRow({ type: 'basic', username: 'a', password: 'b' }, 'header')?.value).toBe('Basic YTpi');
    expect(authRow({ type: 'basic', username: '{{u}}', password: 'b' }, 'header')?.value).toBe('Basic base64({{u}}:b)');
  });
  it('none/inherit add nothing', () => {
    expect(authRow({ type: 'none' }, 'header')).toBeNull();
    expect(authRow({ type: 'inherit' }, 'header')).toBeNull();
  });
});
