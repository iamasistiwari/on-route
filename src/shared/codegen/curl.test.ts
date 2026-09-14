import { describe, expect, it } from 'vitest';
import type { RequestDef, ResolvedRequest } from '../model';
import { parseCurl } from '../importers/curl';
import { toCurl } from './curl';

describe('toCurl', () => {
  it('simple GET omits -X', () => {
    expect(toCurl({ method: 'GET', url: 'https://example.com/a?b=1', headers: [], body: { type: 'none' } })).toBe(
      "curl 'https://example.com/a?b=1'",
    );
  });

  it('POST with JSON body omits -X, quotes single quotes', () => {
    const req: ResolvedRequest = {
      method: 'POST',
      url: 'https://api.example.com/users',
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer abc' },
      ],
      body: { type: 'text', content: '{"name":"O\'Brien"}', contentType: 'application/json' },
    };
    expect(toCurl(req)).toBe(
      [
        "curl 'https://api.example.com/users'",
        "  -H 'Content-Type: application/json'",
        "  -H 'Authorization: Bearer abc'",
        `  --data-raw '{"name":"O'\\''Brien"}'`,
      ].join(' \\\n'),
    );
  });

  it('single-line option', () => {
    expect(
      toCurl(
        { method: 'DELETE', url: 'https://x.io/u/1', headers: [{ key: 'X-Empty', value: '' }], body: { type: 'none' } },
        { multiline: false },
      ),
    ).toBe("curl -X DELETE 'https://x.io/u/1' -H 'X-Empty;'");
  });

  it('GET with body and HEAD keep -X', () => {
    expect(
      toCurl({ method: 'GET', url: 'http://h/', headers: [], body: { type: 'text', content: 'x' } }, { multiline: false }),
    ).toBe("curl -X GET 'http://h/' --data-raw 'x'");
    expect(toCurl({ method: 'HEAD', url: 'http://h/', headers: [], body: { type: 'none' } })).toBe(
      "curl -X HEAD 'http://h/'",
    );
    expect(toCurl({ method: 'POST', url: 'http://h/', headers: [], body: { type: 'none' } })).toBe(
      "curl -X POST 'http://h/'",
    );
  });

  it('urlencoded, form and binary bodies', () => {
    expect(
      toCurl({
        method: 'POST',
        url: 'http://h/login',
        headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
        body: { type: 'urlencoded', fields: [{ key: 'user', value: 'a b' }, { key: 'pw', value: 'p&w' }] },
      }),
    ).toBe(
      [
        "curl 'http://h/login'",
        "  -H 'Content-Type: application/x-www-form-urlencoded'",
        "  --data-urlencode 'user=a b'",
        "  --data-urlencode 'pw=p&w'",
      ].join(' \\\n'),
    );
    expect(
      toCurl({
        method: 'PUT',
        url: 'http://h/up',
        headers: [{ key: 'Content-Type', value: 'multipart/form-data' }],
        body: {
          type: 'form',
          fields: [
            { key: 'file', value: 'img/a b.png', kind: 'file' },
            { key: 'note', value: 'hi', kind: 'text' },
            { key: 'handle', value: '@me', kind: 'text' },
          ],
        },
      }),
    ).toBe(
      [
        "curl -X PUT 'http://h/up'",
        "  -F 'file=@img/a b.png'",
        "  -F 'note=hi'",
        "  --form-string 'handle=@me'",
      ].join(' \\\n'),
    );
    expect(toCurl({ method: 'POST', url: 'http://h/b', headers: [], body: { type: 'binary', filePath: 'data.bin' } })).toBe(
      "curl 'http://h/b' \\\n  --data-binary '@data.bin'",
    );
  });
});

// ---------------------------------------------------------------- round trip

/** Minimal local resolver (RequestDef without variables -> ResolvedRequest), mirroring the app's conventions. */
function resolveForTest(def: Omit<RequestDef, 'id'>): ResolvedRequest {
  const enabled = <T extends { enabled?: boolean }>(xs: T[]) => xs.filter((x) => x.enabled !== false);
  const qs = enabled(def.params)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&');
  const url = qs ? `${def.url}?${qs}` : def.url;
  const headers = enabled(def.headers).map(({ key, value }) => ({ key, value }));
  const hasHeader = (k: string) => headers.some((h) => h.key.toLowerCase() === k.toLowerCase());
  if (def.auth.type === 'bearer') headers.push({ key: 'Authorization', value: `Bearer ${def.auth.token}` });
  if (def.auth.type === 'basic') {
    headers.push({ key: 'Authorization', value: `Basic ${btoa(`${def.auth.username}:${def.auth.password}`)}` });
  }
  let body: ResolvedRequest['body'];
  switch (def.body.type) {
    case 'none':
      body = { type: 'none' };
      break;
    case 'json':
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: 'application/json' });
      body = { type: 'text', content: def.body.content, contentType: 'application/json' };
      break;
    case 'raw':
      body = { type: 'text', content: def.body.content, contentType: def.body.contentType };
      break;
    case 'urlencoded':
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
      body = { type: 'urlencoded', fields: enabled(def.body.fields).map(({ key, value }) => ({ key, value })) };
      break;
    case 'form':
      body = {
        type: 'form',
        fields: enabled(def.body.fields).map(({ key, value, kind }) => ({ key, value, kind: kind ?? 'text' })),
      };
      break;
    case 'binary':
      body = { type: 'binary', filePath: def.body.filePath };
      break;
  }
  return { method: def.method === 'WS' ? 'GET' : def.method, url, headers, body };
}

function semantics(r: ResolvedRequest) {
  const headers = r.headers.map((h) => `${h.key.toLowerCase()}: ${h.value}`).sort();
  let body: unknown = r.body;
  if (r.body.type === 'text') {
    let content: unknown = r.body.content;
    try {
      content = JSON.parse(r.body.content);
    } catch {
      /* not json */
    }
    body = { type: 'text', content };
  }
  return { method: r.method, url: r.url, headers, body };
}

const roundTrip: [string, ResolvedRequest][] = [
  ['GET with query', { method: 'GET', url: 'https://api.example.com/items?page=2&q=red%20shoes', headers: [{ key: 'Accept', value: 'application/json' }], body: { type: 'none' } }],
  ['DELETE with bearer', { method: 'DELETE', url: 'https://api.example.com/items/9', headers: [{ key: 'Authorization', value: 'Bearer t0k3n' }], body: { type: 'none' } }],
  ['HEAD', { method: 'HEAD', url: 'http://localhost:3000/health', headers: [], body: { type: 'none' } }],
  ['OPTIONS', { method: 'OPTIONS', url: 'http://localhost:3000/', headers: [{ key: 'Origin', value: 'http://a.test' }], body: { type: 'none' } }],
  [
    'POST JSON with tricky characters',
    {
      method: 'POST',
      url: 'https://api.example.com/notes',
      headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Req', value: 'it\'s "quoted" $HOME `x` \\n' }],
      body: { type: 'text', content: '{"text":"line1\\nline2 it\'s $5 `cmd` \\\\ done","n":[1,2]}', contentType: 'application/json' },
    },
  ],
  [
    'PUT raw text with newlines',
    {
      method: 'PUT',
      url: 'https://example.com/doc.txt',
      headers: [{ key: 'Content-Type', value: 'text/plain' }],
      body: { type: 'text', content: "hello\nworld 'single' \"double\"\n", contentType: 'text/plain' },
    },
  ],
  [
    'PATCH urlencoded',
    {
      method: 'PATCH',
      url: 'https://example.com/profile',
      headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }, { key: 'Authorization', value: `Basic ${btoa('me:p@ss:word')}` }],
      body: { type: 'urlencoded', fields: [{ key: 'display name', value: 'Jo & Co' }, { key: 'bio', value: '100% "real"' }] },
    },
  ],
  [
    'POST multipart form',
    {
      method: 'POST',
      url: 'https://example.com/upload',
      headers: [{ key: 'X-Empty', value: '' }],
      body: {
        type: 'form',
        fields: [
          { key: 'avatar', value: 'assets/me.png', kind: 'file' },
          { key: 'caption', value: "Me; at the beach, it's great", kind: 'text' },
        ],
      },
    },
  ],
  ['POST binary', { method: 'POST', url: 'https://example.com/raw', headers: [{ key: 'Content-Type', value: 'application/octet-stream' }], body: { type: 'binary', filePath: 'fixtures/data.bin' } }],
  ['PUT binary', { method: 'PUT', url: 'https://example.com/raw', headers: [], body: { type: 'binary', filePath: 'a.bin' } }],
];

describe('round trip parseCurl(toCurl(req))', () => {
  it.each(roundTrip)('%s', (_name, req) => {
    for (const multiline of [true, false]) {
      const back = resolveForTest(parseCurl(toCurl(req, { multiline })));
      expect(semantics(back)).toEqual(semantics(req));
    }
  });
});
