import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importPostman } from './postman';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../test/fixtures/postman', name), 'utf8')) as unknown;

describe('importPostman (v2.1 fixture)', () => {
  const result = importPostman(fixture('petstore.postman_collection.json'), [fixture('production.postman_environment.json')]);
  const byId = (id: string) => {
    const r = result.requests.find((x) => x.id === id);
    if (!r) throw new Error(`missing request ${id}; have ${result.requests.map((x) => x.id).join(', ')}`);
    return r;
  };

  it('maps project config', () => {
    expect(result.config).toEqual({
      version: 1,
      name: 'Petstore API',
      auth: { type: 'bearer', token: '{{token}}' },
      variables: [
        { key: 'baseUrl', value: 'https://petstore.example.com/v1' },
        { key: 'legacy', value: 'old', enabled: false },
      ],
      docs: 'Sample collection for the **Petstore**.',
    });
  });

  it('maps folders with nesting, auth and docs', () => {
    expect(result.folders).toEqual([
      {
        id: 'pets',
        name: 'Pets',
        auth: { type: 'apikey', key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' },
        variables: [],
        docs: 'Pet endpoints',
        order: 0,
      },
      { id: 'pets/admin', name: 'Admin', auth: { type: 'none' }, variables: [], order: 3 },
    ]);
  });

  it('assigns slug ids with nesting and de-duplication', () => {
    expect(result.requests.map((r) => r.id)).toEqual([
      'pets/list-pets',
      'pets/create-pet',
      'pets/upload-photo',
      'pets/admin/purge',
      'login',
      'login-2',
      'search-graphql',
      'notes',
    ]);
  });

  it('maps url object with query into params (stripped from url), headers, docs', () => {
    expect(byId('pets/list-pets')).toEqual({
      id: 'pets/list-pets',
      name: 'List Pets',
      method: 'GET',
      url: '{{baseUrl}}/pets',
      params: [
        { key: 'limit', value: '10' },
        { key: 'status', value: 'available', description: 'Filter' },
        { key: 'tag', value: 'dog', enabled: false },
      ],
      headers: [
        { key: 'Accept', value: 'application/json' },
        { key: 'X-Debug', value: '1', enabled: false },
      ],
      auth: { type: 'inherit' },
      body: { type: 'none' },
      docs: 'Returns all pets',
      order: 0,
    });
  });

  it('raw json body and string url', () => {
    const r = byId('pets/create-pet');
    expect(r.url).toBe('{{baseUrl}}/pets');
    expect(r.method).toBe('POST');
    expect(r.body).toEqual({ type: 'json', content: '{\n  "name": "Rex"\n}' });
  });

  it('formdata with file src and url rebuilt from parts', () => {
    const r = byId('pets/upload-photo');
    expect(r.url).toBe('https://petstore.example.com:8443/v1/pets/:petId/photo');
    expect(r.body).toEqual({
      type: 'form',
      fields: [
        { key: 'caption', value: 'cute', kind: 'text' },
        { key: 'photo', value: '/tmp/rex.png', kind: 'file' },
        { key: 'old', value: 'x', kind: 'text', enabled: false },
      ],
    });
  });

  it('unknown method => GET + warning', () => {
    expect(byId('pets/admin/purge').method).toBe('GET');
    expect(result.warnings.some((w) => w.includes('PURGE'))).toBe(true);
  });

  it('basic auth + urlencoded', () => {
    const r = byId('login');
    expect(r.auth).toEqual({ type: 'basic', username: 'admin', password: 's3cret' });
    expect(r.body).toEqual({
      type: 'urlencoded',
      fields: [
        { key: 'grant_type', value: 'password' },
        { key: 'scope', value: 'all', enabled: false },
      ],
    });
  });

  it('unsupported auth => inherit + warning; file body => binary', () => {
    const r = byId('login-2');
    expect(r.auth).toEqual({ type: 'inherit' });
    expect(r.body).toEqual({ type: 'binary', filePath: 'fixtures/data.bin' });
    expect(result.warnings.some((w) => w.includes('oauth2'))).toBe(true);
  });

  it('graphql => json body + warning', () => {
    const r = byId('search-graphql');
    expect(r.body.type).toBe('json');
    expect(JSON.parse((r.body as { content: string }).content)).toEqual({ query: 'query { pets { id } }', variables: { first: 5 } });
    expect(result.warnings.some((w) => /graphql/i.test(w))).toBe(true);
  });

  it('raw xml => raw with contentType; lowercase method normalised', () => {
    const r = byId('notes');
    expect(r.method).toBe('POST');
    expect(r.body).toEqual({ type: 'raw', content: '<note/>', contentType: 'application/xml' });
  });

  it('warns about scripts', () => {
    expect(result.warnings.some((w) => /script/i.test(w))).toBe(true);
  });

  it('maps environments with secrets and disabled values', () => {
    expect(result.environments).toEqual([
      {
        name: 'production-api',
        variables: [
          { key: 'baseUrl', value: 'https://petstore.example.com/v1' },
          { key: 'token', value: 'prod-token-value', secret: true },
          { key: 'debug', value: 'true', enabled: false },
        ],
      },
    ]);
  });
});

describe('importPostman (v2.0 fixture)', () => {
  const result = importPostman(fixture('legacy-v2.0.postman_collection.json'));

  it('handles string request, string headers and object-style auth params', () => {
    expect(result.config.name).toBe('Legacy v2.0');
    expect(result.config.auth).toEqual({ type: 'none' });
    expect(result.requests[0]).toMatchObject({ id: 'ping', method: 'GET', url: 'https://api.example.com/ping' });
    expect(result.requests[1]).toMatchObject({
      id: 'me',
      headers: [
        { key: 'Accept', value: 'application/json' },
        { key: 'X-Trace', value: 'abc' },
      ],
      auth: { type: 'bearer', token: 'tok-123' },
    });
  });
});

describe('importPostman errors', () => {
  it.each([null, 42, 'hello', [], {}, { info: {} }, { item: [] }])('rejects garbage %j', (input) => {
    expect(() => importPostman(input)).toThrow(/Postman collection/);
  });

  it('rejects v1 collections clearly', () => {
    expect(() => importPostman({ id: 'x', name: 'old', requests: [], order: [] })).toThrow(/v1/);
  });

  it('warns and skips invalid environments', () => {
    const r = importPostman({ info: { name: 'x' }, item: [] }, [{ nope: true }]);
    expect(r.environments).toEqual([]);
    expect(r.warnings[0]).toMatch(/Environment #1/);
  });

  it('url object without raw and query only', () => {
    const r = importPostman({
      info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'q', request: { method: 'GET', url: { host: ['{{baseUrl}}'], path: ['a', 'b'], query: [{ key: 'x', value: null }] } } }],
    });
    expect(r.requests[0].url).toBe('{{baseUrl}}/a/b');
    expect(r.requests[0].params).toEqual([{ key: 'x', value: '' }]);
  });
});
