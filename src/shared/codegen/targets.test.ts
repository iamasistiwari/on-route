import { describe, expect, it } from 'vitest';
import type { ResolvedRequest } from '../model';
import { CODE_TARGETS } from '../protocol';
import { generators } from './index';
import { splitUrl } from './common';

const json: ResolvedRequest = {
  method: 'POST',
  url: 'https://api.example.com/v1/users?x=1',
  headers: [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'X-Info', value: '{"a":"it\'s $HOME \\\\ `x`"}' },
  ],
  body: { type: 'text', content: '{"name":"Jo","ok":true,"n":null,"tags":["a"]}', contentType: 'application/json' },
};

const shapes: Record<string, ResolvedRequest> = {
  json,
  get: { method: 'GET', url: 'http://localhost:3000/health', headers: [], body: { type: 'none' } },
  urlencoded: {
    method: 'PUT',
    url: 'https://x.io/form',
    headers: [],
    body: { type: 'urlencoded', fields: [{ key: 'a b', value: 'c&d' }, { key: 'a b', value: 'e' }] },
  },
  form: {
    method: 'POST',
    url: 'https://x.io/upload',
    headers: [{ key: 'Content-Type', value: 'multipart/form-data' }],
    body: {
      type: 'form',
      fields: [
        { key: 'title', value: 'hello "world"', kind: 'text' },
        { key: 'file', value: 'files/pic.png', kind: 'file' },
      ],
    },
  },
  binary: { method: 'PATCH', url: 'https://x.io/bin', headers: [{ key: 'Content-Type', value: 'image/png' }], body: { type: 'binary', filePath: 'a.png' } },
};

describe('code generators', () => {
  it('has a generator for every target', () => {
    for (const t of CODE_TARGETS) expect(typeof generators[t.id]).toBe('function');
  });

  for (const t of CODE_TARGETS) {
    it(`${t.id} handles every body shape`, () => {
      for (const req of Object.values(shapes)) {
        const out = generators[t.id](req);
        expect(out.length).toBeGreaterThan(0);
        expect(out).toContain(t.id === 'http' || t.id === 'python-http' ? splitUrl(req.url).host : req.url);
      }
    });
  }

  it('pretty-prints JSON bodies', () => {
    expect(generators.go(json)).toContain('`{\n  "name": "Jo",\n  "ok": true,');
    expect(generators['python-requests'](json)).toContain('payload = {\n    "name": "Jo",\n    "ok": True,\n    "n": None,');
    expect(generators.http(json)).toBe(
      [
        'POST /v1/users?x=1 HTTP/1.1',
        'Host: api.example.com',
        'Content-Type: application/json',
        `X-Info: {"a":"it's $HOME \\\\ \`x\`"}`,
        '',
        '{\n  "name": "Jo",\n  "ok": true,\n  "n": null,\n  "tags": [\n    "a"\n  ]\n}',
      ].join('\n'),
    );
  });

  it('escapes $ in Kotlin raw strings', () => {
    const out = generators['kotlin-okhttp']({ ...json, headers: [], body: { type: 'text', content: "a $x 'b'\nc", contentType: 'text/plain' } });
    expect(out).toContain('val body = """\n    a ${\'$\'}x \'b\'\n    c\n""".trimIndent()');
  });

  it('keeps non-JSON text as-is', () => {
    const out = generators['php-curl']({ ...json, headers: [], body: { type: 'text', content: "a 'b'", contentType: 'text/plain' } });
    expect(out).toContain("CURLOPT_POSTFIELDS => 'a \\'b\\''");
  });

  it('splitUrl tolerates unresolved variables', () => {
    expect(splitUrl('{{baseUrl}}/users/{{id}}?q=1#frag')).toEqual({ scheme: 'https', host: '{{baseUrl}}', path: '/users/{{id}}?q=1' });
    expect(splitUrl('http://h:8080')).toEqual({ scheme: 'http', host: 'h:8080', path: '/' });
  });
});
