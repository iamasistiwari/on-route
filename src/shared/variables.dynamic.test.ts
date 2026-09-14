import { describe, expect, it } from 'vitest';
import { newRequest } from './model';
import { resolveRequest, resolveString } from './variables';

describe('dynamic variable opt-out', () => {
  it('substitutes dynamic vars by default', () => {
    expect(resolveString('{{$uuid}}', {}).value).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps dynamic placeholders when dynamic=false', () => {
    const { value, missing } = resolveString('id={{$uuid}}&t={{ $timestamp }}', {}, { dynamic: false });
    expect(value).toBe('id={{$uuid}}&t={{ $timestamp }}');
    expect(missing).toEqual([]);
  });

  it('resolveRequest passes the flag through', () => {
    const req = { ...newRequest('x', 'x'), url: 'http://h/{{$uuid}}' };
    const out = resolveRequest(req, { vars: {}, auth: { type: 'none' }, dynamic: false });
    expect(out.request.url).toBe('http://h/{{$uuid}}');
  });
});
