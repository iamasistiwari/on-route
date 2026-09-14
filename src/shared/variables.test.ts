import { describe, expect, it } from 'vitest';
import type { RequestDef } from './model';
import { buildVariableMap, resolveRequest, resolveString } from './variables';

describe('buildVariableMap', () => {
  it('applies precedence project < folders < environment < local', () => {
    const map = buildVariableMap([
      { name: 'project', variables: [{ key: 'a', value: 'project' }, { key: 'b', value: 'project' }, { key: 'p', value: '1' }] },
      { name: 'folder users', variables: [{ key: 'a', value: 'outer' }, { key: 'b', value: 'outer' }] },
      { name: 'folder users/admin', variables: [{ key: 'b', value: 'inner' }, { key: 'c', value: 'inner' }] },
      { name: 'environment dev', variables: [{ key: 'c', value: 'env' }, { key: 'd', value: 'env' }] },
      { name: 'local', variables: [{ key: 'd', value: 'local' }] },
    ]);
    expect(map).toEqual({ a: 'outer', b: 'inner', c: 'env', d: 'local', p: '1' });
  });

  it('skips disabled variables', () => {
    const map = buildVariableMap([
      { name: 'project', variables: [{ key: 'a', value: 'base' }] },
      { name: 'env', variables: [{ key: 'a', value: 'off', enabled: false }, { key: 'z', value: 'z', enabled: false }] },
    ]);
    expect(map).toEqual({ a: 'base' });
  });

  it('empty secret does not override; non-empty secret does', () => {
    const map = buildVariableMap([
      { name: 'project', variables: [{ key: 'token', value: 'fallback' }, { key: 'pw', value: 'x' }] },
      { name: 'env', variables: [{ key: 'token', value: '', secret: true }, { key: 'pw', value: '', secret: true }] },
      { name: 'local', variables: [{ key: 'pw', value: 'real', secret: true }] },
    ]);
    expect(map).toEqual({ token: 'fallback', pw: 'real' });
  });

  it('empty non-secret value does override', () => {
    expect(buildVariableMap([
      { name: 'p', variables: [{ key: 'a', value: 'x' }] },
      { name: 'e', variables: [{ key: 'a', value: '' }] },
    ])).toEqual({ a: '' });
  });
});

describe('resolveString', () => {
  it('substitutes, allowing whitespace in braces', () => {
    expect(resolveString('{{a}}-{{ b }}-{{  a  }}', { a: '1', b: '2' })).toEqual({ value: '1-2-1', missing: [] });
  });

  it('leaves unknowns and reports them deduped', () => {
    const r = resolveString('{{x}}/{{ x }}/{{y}}/{{ok}}', { ok: 'yes' });
    expect(r.value).toBe('{{x}}/{{ x }}/{{y}}/yes');
    expect(r.missing).toEqual(['x', 'y']);
  });

  it('dynamic variables have the right format', () => {
    const r = resolveString('{{$uuid}}|{{$timestamp}}|{{$isoTimestamp}}|{{$randomInt}}', {});
    const [uuid, ts, iso, rnd] = r.value.split('|');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number(ts)).toBeGreaterThan(1_700_000_000);
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
    expect(ts).toMatch(/^\d+$/);
    expect(new Date(iso).toISOString()).toBe(iso);
    expect(Number(rnd)).toBeGreaterThanOrEqual(0);
    expect(Number(rnd)).toBeLessThanOrEqual(1000);
    expect(Number.isInteger(Number(rnd))).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('each $uuid occurrence is fresh', () => {
    const [a, b] = resolveString('{{$uuid}} {{$uuid}}', {}).value.split(' ');
    expect(a).not.toBe(b);
  });

  it('unknown dynamic var is missing', () => {
    expect(resolveString('{{$nope}}', {})).toEqual({ value: '{{$nope}}', missing: ['$nope'] });
  });

  it('resolves nested references up to 3 levels', () => {
    const vars = { baseUrl: '{{scheme}}://{{host}}', host: '{{sub}}.example.com', sub: '{{env}}', env: 'dev', scheme: 'https' };
    expect(resolveString('{{baseUrl}}/x', vars).value).toBe('https://dev.example.com/x');
  });

  it('stops beyond 3 levels of nesting', () => {
    // top-level substitution + 3 nested levels; the 4th nested reference stays verbatim
    const vars = { l1: '{{l2}}', l2: '{{l3}}', l3: '{{l4}}', l4: '{{l5}}', l5: 'deep' };
    expect(resolveString('{{l1}}', vars).value).toBe('{{l5}}');
  });

  it('nested missing variables are reported', () => {
    expect(resolveString('{{a}}', { a: '{{b}}' })).toEqual({ value: '{{b}}', missing: ['b'] });
  });

  it('cycles terminate', () => {
    const r = resolveString('{{a}}', { a: '{{b}}', b: '{{a}}' });
    expect(r.value).toMatch(/^\{\{[ab]\}\}$/);
    const self = resolveString('{{a}}', { a: 'x{{a}}' });
    expect(self.value).toBe('xxxx{{a}}');
  });

  it('handles empty input', () => {
    expect(resolveString('', {})).toEqual({ value: '', missing: [] });
  });
});

const req = (over: Partial<RequestDef> = {}): RequestDef => ({
  id: 'r',
  name: 'r',
  method: 'GET',
  url: '{{baseUrl}}/users',
  params: [],
  headers: [],
  auth: { type: 'inherit' },
  body: { type: 'none' },
  ...over,
});

describe('resolveRequest', () => {
  const vars = { baseUrl: 'https://api.test', id: '42', token: 'tok', user: 'bob', q: 'a b', hname: 'X-Trace' };

  it('full pipeline: url, params, headers, auth, content-type, disabled rows', () => {
    const { request, missing } = resolveRequest(
      req({
        method: 'POST',
        url: '{{baseUrl}}/users/{{id}}?fixed=1',
        params: [
          { key: 'search', value: '{{q}}' },
          { key: 'off', value: 'x', enabled: false },
          { key: 'raw', value: '{{unknown}}' },
        ],
        headers: [
          { key: '{{hname}}', value: '{{id}}' },
          { key: 'X-Off', value: '1', enabled: false },
        ],
        body: { type: 'json', content: '{"id": {{id}}}' },
      }),
      { vars, auth: { type: 'bearer', token: '{{token}}' } },
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.test/users/42?fixed=1&search=a%20b&raw={{unknown}}');
    expect(request.headers).toEqual([
      { key: 'X-Trace', value: '42' },
      { key: 'Content-Type', value: 'application/json' },
      { key: 'Authorization', value: 'Bearer tok' },
    ]);
    expect(request.body).toEqual({ type: 'text', content: '{"id": 42}', contentType: 'application/json' });
    expect(missing).toEqual(['unknown']);
  });

  it('adds ? when url has no query', () => {
    const { request } = resolveRequest(req({ params: [{ key: 'a', value: '1' }, { key: 'b', value: '' }] }), {
      vars,
      auth: { type: 'none' },
    });
    expect(request.url).toBe('https://api.test/users?a=1&b');
  });

  it('user Content-Type is kept', () => {
    const { request } = resolveRequest(
      req({ headers: [{ key: 'content-type', value: 'application/vnd.api+json' }], body: { type: 'json', content: '{}' } }),
      { vars, auth: { type: 'none' } },
    );
    expect(request.headers).toEqual([{ key: 'content-type', value: 'application/vnd.api+json' }]);
  });

  it('disabled user Content-Type does not block inference', () => {
    const { request } = resolveRequest(
      req({ headers: [{ key: 'Content-Type', value: 'text/plain', enabled: false }], body: { type: 'urlencoded', fields: [] } }),
      { vars, auth: { type: 'none' } },
    );
    expect(request.headers).toEqual([{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  });

  it('raw with and without contentType', () => {
    const withCt = resolveRequest(req({ body: { type: 'raw', content: '<a>{{id}}</a>', contentType: 'application/xml' } }), {
      vars,
      auth: { type: 'none' },
    }).request;
    expect(withCt.headers).toEqual([{ key: 'Content-Type', value: 'application/xml' }]);
    expect(withCt.body).toEqual({ type: 'text', content: '<a>42</a>', contentType: 'application/xml' });
    const noCt = resolveRequest(req({ body: { type: 'raw', content: 'hi' } }), { vars, auth: { type: 'none' } }).request;
    expect(noCt.headers).toEqual([]);
    expect(noCt.body).toEqual({ type: 'text', content: 'hi' });
  });

  it('urlencoded fields resolved, disabled dropped', () => {
    const { request } = resolveRequest(
      req({
        body: {
          type: 'urlencoded',
          fields: [
            { key: 'user', value: '{{user}}' },
            { key: 'x', value: 'y', enabled: false },
          ],
        },
      }),
      { vars, auth: { type: 'none' } },
    );
    expect(request.body).toEqual({ type: 'urlencoded', fields: [{ key: 'user', value: 'bob' }] });
  });

  it('form: no inferred content-type, kind defaults to text, file path resolved', () => {
    const { request } = resolveRequest(
      req({
        body: {
          type: 'form',
          fields: [
            { key: 'name', value: '{{user}}' },
            { key: 'avatar', value: 'files/{{id}}.png', kind: 'file' },
            { key: 'gone', value: '1', enabled: false },
          ],
        },
      }),
      { vars, auth: { type: 'none' } },
    );
    expect(request.headers).toEqual([]);
    expect(request.body).toEqual({
      type: 'form',
      fields: [
        { key: 'name', value: 'bob', kind: 'text' },
        { key: 'avatar', value: 'files/42.png', kind: 'file' },
      ],
    });
  });

  it('binary file path resolved', () => {
    const { request } = resolveRequest(req({ body: { type: 'binary', filePath: '{{id}}.bin' } }), { vars, auth: { type: 'none' } });
    expect(request.body).toEqual({ type: 'binary', filePath: '42.bin' });
  });

  it('auth fields resolved before apply; basic and apikey query', () => {
    const basic = resolveRequest(req(), { vars, auth: { type: 'basic', username: '{{user}}', password: '{{pw}}' } });
    expect(basic.missing).toEqual(['pw']);
    expect(basic.request.headers[0].value).toBe(`Basic ${btoa('bob:{{pw}}')}`);

    const q = resolveRequest(req({ params: [{ key: 'a', value: '1' }] }), {
      vars,
      auth: { type: 'apikey', key: 'key', value: '{{token}}', in: 'query' },
    });
    expect(q.request.url).toBe('https://api.test/users?a=1&key=tok');
  });

  it('dedupes missing across the whole request', () => {
    const { missing } = resolveRequest(
      req({ url: '{{nope}}/x', headers: [{ key: 'A', value: '{{nope}}' }], body: { type: 'raw', content: '{{other}}' } }),
      { vars: {}, auth: { type: 'bearer', token: '{{nope}}' } },
    );
    expect(missing.sort()).toEqual(['nope', 'other']);
  });
});
