import { describe, expect, it } from 'vitest';
import { toAxios } from './axios';
import { generators } from './index';

describe('toAxios', () => {
  it('GET without headers or data', () => {
    expect(toAxios({ method: 'GET', url: 'https://example.com/a?b=1', headers: [], body: { type: 'none' } })).toBe(
      `import axios from 'axios';

const response = await axios.request({
  method: 'get',
  url: 'https://example.com/a?b=1',
});

console.log(response.data);
`,
    );
  });

  it('POST JSON body as object literal, header keys quoted only when needed', () => {
    expect(
      toAxios({
        method: 'POST',
        url: 'https://api.example.com/users',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: "Bearer it's" },
        ],
        body: {
          type: 'text',
          content: '{"name":"Jo","tags":["a"],"nested":{"ok":true,"n":null},"my-key":1,"empty":{},"list":[]}',
          contentType: 'application/json',
        },
      }),
    ).toBe(
      `import axios from 'axios';

const response = await axios.request({
  method: 'post',
  url: 'https://api.example.com/users',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer it\\'s',
  },
  data: {
    name: 'Jo',
    tags: [
      'a',
    ],
    nested: {
      ok: true,
      n: null,
    },
    'my-key': 1,
    empty: {},
    list: [],
  },
});

console.log(response.data);
`,
    );
  });

  it('non-JSON text body is an escaped string', () => {
    const out = toAxios({
      method: 'PUT',
      url: 'http://h/x',
      headers: [{ key: 'Content-Type', value: 'text/plain' }],
      body: { type: 'text', content: "line1\nit's \\ done", contentType: 'text/plain' },
    });
    expect(out).toContain(`  data: 'line1\\nit\\'s \\\\ done',\n`);
    // the emitted literal evaluates back to the original
    const literal = /data: (.*),\n/.exec(out)![1];
    expect(new Function(`return ${literal}`)()).toBe("line1\nit's \\ done");
  });

  it('big integers fall back to string to avoid precision loss', () => {
    const out = toAxios({
      method: 'POST',
      url: 'http://h/',
      headers: [],
      body: { type: 'text', content: '{"id":12345678901234567890}', contentType: 'application/json' },
    });
    expect(out).toContain(`data: '{"id":12345678901234567890}',`);
  });

  it('urlencoded => URLSearchParams', () => {
    expect(
      toAxios({
        method: 'POST',
        url: 'https://auth.example.com/token',
        headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
        body: { type: 'urlencoded', fields: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'scope', value: 'a b' }] },
      }),
    ).toBe(
      `import axios from 'axios';

const data = new URLSearchParams();
data.append('grant_type', 'client_credentials');
data.append('scope', 'a b');

const response = await axios.request({
  method: 'post',
  url: 'https://auth.example.com/token',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  data,
});

console.log(response.data);
`,
    );
  });

  it('form with file => form-data + fs.createReadStream, drops boundary-less multipart header', () => {
    expect(
      toAxios({
        method: 'POST',
        url: 'https://example.com/upload',
        headers: [{ key: 'Content-Type', value: 'multipart/form-data' }],
        body: {
          type: 'form',
          fields: [
            { key: 'avatar', value: 'assets/me.png', kind: 'file' },
            { key: 'caption', value: 'hi', kind: 'text' },
          ],
        },
      }),
    ).toBe(
      `import axios from 'axios';
import FormData from 'form-data'; // npm install form-data (Node.js)
import fs from 'node:fs';

const data = new FormData();
data.append('avatar', fs.createReadStream('assets/me.png'));
data.append('caption', 'hi');

const response = await axios.request({
  method: 'post',
  url: 'https://example.com/upload',
  data,
});

console.log(response.data);
`,
    );
  });

  it('binary => fs.createReadStream', () => {
    expect(toAxios({ method: 'PUT', url: 'http://h/b', headers: [], body: { type: 'binary', filePath: 'x.bin' } })).toBe(
      `import axios from 'axios';
import fs from 'node:fs';

const response = await axios.request({
  method: 'put',
  url: 'http://h/b',
  data: fs.createReadStream('x.bin'),
});

console.log(response.data);
`,
    );
  });

  it('generators map exposes both targets', () => {
    const req = { method: 'GET' as const, url: 'http://h/', headers: [], body: { type: 'none' as const } };
    expect(generators.curl(req)).toBe("curl 'http://h/'");
    expect(generators.axios(req)).toContain("url: 'http://h/'");
  });
});
