import { describe, expect, it } from 'vitest';
import {
  authLabel,
  bodyLanguage,
  countEnabled,
  formatDuration,
  formatElapsed,
  formatJson,
  formatSize,
  prettyJson,
  relativeTime,
  statusClass,
  statusPhrase,
} from './format';
import { bulkToRows, rowsToBulk } from './kv';
import { mergeScopes, tokenizeTemplate } from './vars';
import { deepEqual } from './equal';

describe('formatSize', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [200 * 1024, '200 KB'],
    [5 * 1024 * 1024, '5 MB'],
    [-1, '0 B'],
  ])('%d -> %s', (n, s) => expect(formatSize(n)).toBe(s));
});

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [123.6, '124 ms'],
    [1000, '1 s'],
    [1234, '1.23 s'],
    [1500, '1.5 s'],
    [65_000, '1m 5s'],
  ])('%d -> %s', (n, s) => expect(formatDuration(n)).toBe(s));
  it('elapsed', () => expect(formatElapsed(420)).toBe('0.4 s'));
});

describe('statusClass', () => {
  it('classifies', () => {
    expect(statusClass(101)).toBe('info');
    expect(statusClass(204)).toBe('success');
    expect(statusClass(302)).toBe('redirect');
    expect(statusClass(404)).toBe('client-error');
    expect(statusClass(503)).toBe('server-error');
    expect(statusClass(0)).toBe('unknown');
  });
});

describe('statusPhrase', () => {
  it('falls back to the standard phrase when the server sends none', () => {
    expect(statusPhrase(400)).toBe('Bad Request');
    expect(statusPhrase(404, '')).toBe('Not Found');
    expect(statusPhrase(200, '   ')).toBe('OK');
  });
  it('prefers the server phrase', () => {
    expect(statusPhrase(499, 'Client Closed Request')).toBe('Client Closed Request');
  });
  it('falls back to the class for unknown codes', () => {
    expect(statusPhrase(499)).toBe('Client Error');
    expect(statusPhrase(599)).toBe('Server Error');
    expect(statusPhrase(0)).toBe('');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it.each([
    [now - 5_000, 'just now'],
    [now - 5 * 60_000, '5m ago'],
    [now - 3 * 3_600_000, '3h ago'],
    [now - 2 * 86_400_000, '2d ago'],
  ])('%d -> %s', (ts, s) => expect(relativeTime(ts, now)).toBe(s));
});

describe('bodyLanguage / images', () => {
  it('uses content type then sniffs', () => {
    expect(bodyLanguage('application/json; charset=utf-8')).toBe('json');
    expect(bodyLanguage('application/problem+json')).toBe('json');
    expect(bodyLanguage('text/html')).toBe('html');
    expect(bodyLanguage('application/xml')).toBe('xml');
    expect(bodyLanguage('text/plain', '{}')).toBe('text');
    expect(bodyLanguage(undefined, '  [1,2]')).toBe('json');
    expect(bodyLanguage(undefined, '<!DOCTYPE html>')).toBe('html');
    expect(bodyLanguage(undefined, 'hello')).toBe('text');
  });
});

describe('json formatting', () => {
  it('prettyJson', () => {
    expect(prettyJson('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', ok: true });
    expect(prettyJson('nope')).toEqual({ text: 'nope', ok: false });
  });
  it('formatJson keeps unquoted and quoted variables', () => {
    expect(formatJson('{"id":{{userId}},"name":"{{name}}"}')).toBe('{\n  "id": {{userId}},\n  "name": "{{name}}"\n}');
    expect(formatJson('{"a":')).toBeNull();
  });
  it('formatJson cleans up messy pasted JSON', () => {
    const messy = '{\n\t\t"a" :   1 ,   // note\n  "b":[1,2,],\n /* c */ "c": "x\ty",\n}';
    expect(formatJson(messy)).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": "x y"\n}');
    expect(formatJson('{"url": "http://x.test/a"}')).toBe('{\n  "url": "http://x.test/a"\n}');
  });
});

describe('misc', () => {
  it('countEnabled ignores disabled and empty keys', () => {
    expect(countEnabled([{ key: 'a' }, { key: '', enabled: true }, { key: 'b', enabled: false }])).toBe(1);
  });
  it('authLabel', () => {
    expect(authLabel({ type: 'apikey', key: 'k', value: 'v', in: 'header' })).toBe('API key (header)');
  });
  it('bulk edit round-trip keeps metadata', () => {
    const rows = [
      { key: 'a', value: 'x: y', description: 'd' },
      { key: 'b', value: '2', enabled: false },
    ];
    const text = rowsToBulk(rows);
    expect(text).toBe('a: x: y\n//b: 2');
    expect(bulkToRows(text, rows)).toEqual(rows);
  });
  it('tokenizeTemplate', () => {
    expect(tokenizeTemplate('{{ baseUrl }}/u/{{id}}')).toEqual([
      { text: '{{ baseUrl }}', varName: 'baseUrl' },
      { text: '/u/' },
      { text: '{{id}}', varName: 'id' },
    ]);
  });
  it('mergeScopes precedence and secrets', () => {
    const merged = mergeScopes([
      { name: 'project', variables: [{ key: 'baseUrl', value: 'a' }, { key: 'token', value: 'p' }] },
      { name: 'environment', variables: [{ key: 'baseUrl', value: 'b' }, { key: 'token', value: '', secret: true }] },
      { name: 'local', variables: [{ key: 'baseUrl', value: 'c', enabled: false }] },
    ]);
    expect(merged).toEqual([
      { key: 'baseUrl', value: 'b', source: 'environment', secret: false },
      { key: 'token', value: 'p', source: 'project', secret: true },
    ]);
  });
  it('deepEqual ignores undefined props', () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual([{ a: 1 }], [{ a: 2 }])).toBe(false);
  });
});
