import { describe, expect, it } from 'vitest';
import type { SuggestionRequest } from '../../shared/protocol';
import { ghostText, jsonKeyCorpus, suggestBodies, suggestUrl } from './suggest';

const req = (id: string, method: SuggestionRequest['method'], url: string, extra: Partial<SuggestionRequest> = {}): SuggestionRequest => ({
  id,
  folderId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
  name: id.slice(id.lastIndexOf('/') + 1),
  method,
  url,
  paramKeys: [],
  ...extra,
});

const requests: SuggestionRequest[] = [
  req('gst/gst-to-contact', 'POST', '{{baseUrl}}/api/v1/gst/gst-to-contact', { body: { type: 'json', content: '{\n  "gstin": "22AAAAA0000A1Z5",\n  "consent": true\n}' } }),
  req('gst/gst-to-pan', 'POST', '{{baseUrl}}/api/v1/gst/gst-to-pan', { body: { type: 'json', content: '{ "gstin": "", "consent": true }' } }),
  req('users/list-users', 'GET', '{{baseUrl}}/api/v1/users', { paramKeys: ['page', 'role'] }),
  req('users/create-user', 'POST', '{{baseUrl}}/api/v1/users', { body: { type: 'json', content: '{ "name": "Ada", "email": "ada@example.com", "role": "admin" }' } }),
  req('health', 'GET', '{{baseUrl}}/health'),
];

const values = (text: string, ctx: Partial<Parameters<typeof suggestUrl>[1]> = {}) => suggestUrl(text, { requests, ...ctx }).map((s) => s.value);

describe('suggestUrl', () => {
  it('offers base URL variables for an empty bar', () => {
    expect(values('', { variableKeys: ['token', 'baseUrl'] })[0]).toBe('{{baseUrl}}/');
  });

  it('completes the next path segment, then whole endpoints', () => {
    expect(values('{{baseUrl}}/api/v1/g')).toEqual([
      '{{baseUrl}}/api/v1/gst/',
      '{{baseUrl}}/api/v1/gst/gst-to-pan',
      '{{baseUrl}}/api/v1/gst/gst-to-contact',
    ]);
    const s = suggestUrl('{{baseUrl}}/api/v1/g', { requests });
    expect(ghostText('{{baseUrl}}/api/v1/g', s[0])).toBe('st/');
    expect(s[1]).toMatchObject({ kind: 'endpoint', method: 'POST', detail: 'gst-to-pan' });
  });

  it('ranks endpoints from the same folder first and skips the request itself', () => {
    const s = suggestUrl('{{baseUrl}}/', { requests, folderId: 'users', currentId: 'users/list-users' });
    const endpoints = s.filter((x) => x.kind === 'endpoint');
    expect(endpoints[0]).toMatchObject({ value: '{{baseUrl}}/api/v1/users', detail: 'create-user' });
    expect(endpoints.map((x) => x.detail)).not.toContain('list-users');
  });

  it('falls back to common words and the folder name', () => {
    expect(values('{{baseUrl}}/api/v1/ord', { folderId: 'orders' })).toEqual(['{{baseUrl}}/api/v1/orders']);
    expect(suggestUrl('{{baseUrl}}/api/v1/ord', { requests, folderId: 'orders' })[0]).toEqual({ value: '{{baseUrl}}/api/v1/orders', label: 'orders', kind: 'word' });
    expect(values('{{baseUrl}}/api/v1/lo')).toEqual(['{{baseUrl}}/api/v1/login', '{{baseUrl}}/api/v1/logout', '{{baseUrl}}/api/v1/logs']);
  });

  it('suggests query params from the project first and skips ones already present', () => {
    const s = values('{{baseUrl}}/api/v1/users?page=2&');
    expect(s[0]).toBe('{{baseUrl}}/api/v1/users?page=2&role=');
    expect(s).not.toContain('{{baseUrl}}/api/v1/users?page=2&page=');
    expect(values('{{baseUrl}}/api/v1/users?li')).toEqual(['{{baseUrl}}/api/v1/users?limit=']);
    expect(values('{{baseUrl}}/api/v1/users?page=')).toEqual([]);
  });

  it('suggests hosts while typing a scheme', () => {
    expect(values('http://lo')).toEqual(['http://localhost:3000/', 'http://localhost:8080/']);
  });
});

describe('body suggestions', () => {
  it('starts from bodies in the same folder first, skipping empty and duplicate bodies', () => {
    const s = suggestBodies(requests, { id: 'gst/new', folderId: 'gst', method: 'POST', url: '{{baseUrl}}/api/v1/gst/' });
    expect(s.map((b) => b.name)).toEqual(['gst-to-contact', 'gst-to-pan', 'create-user']);
    expect(s[0].sameFolder).toBe(true);
  });

  it('collects keys and typical values, same folder first, then common keys', () => {
    const keys = jsonKeyCorpus(requests, { id: 'gst/new', folderId: 'gst' });
    expect(keys.slice(0, 2).map((k) => k.key)).toEqual(['consent', 'gstin']);
    expect(keys.find((k) => k.key === 'consent')).toEqual({ key: 'consent', values: ['true'], source: 'folder' });
    expect(keys.find((k) => k.key === 'email')).toMatchObject({ values: ['"ada@example.com"'], source: 'project' });
    expect(keys.find((k) => k.key === 'password')).toMatchObject({ values: ['""'], source: 'common' });
  });
});
