import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GITIGNORE_ENV_COMMENT, ProjectStore, StorageError, slugify } from './projectStore';
import type { RequestDef } from '../../shared/model';

let root: string;
let store: ProjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'on-route-'));
  store = new ProjectStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const p = (...s: string[]) => path.join(root, '.on_route', ...s);
const read = (...s: string[]) => fs.readFile(p(...s), 'utf8');
const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(p(rel)), { recursive: true });
  await fs.writeFile(p(rel), text);
};

function fullRequest(id: string): RequestDef {
  return {
    id,
    name: 'Create User',
    method: 'POST',
    url: '{{baseUrl}}/users?x=1',
    params: [
      { key: 'x', value: '1' },
      { key: 'debug', value: 'true', enabled: false, description: 'toggle' },
    ],
    headers: [{ key: 'Accept', value: 'application/json' }],
    auth: { type: 'apikey', key: 'X-Key', value: '{{apiKey}}', in: 'header' },
    body: { type: 'json', content: '{\n  "name": "Ada",\n  "age": 36\n}\n' },
    docs: 'Creates a user.\n\nSecond paragraph.',
    order: 3,
  };
}

describe('slugify', () => {
  it.each([
    ['Get User by ID!', 'get-user-by-id'],
    ['  --Hello__World--  ', 'hello-world'],
    ['Crème brûlée', 'creme-brulee'],
    ['', 'untitled'],
    ['!!!', 'untitled'],
    ['users/../x', 'users-x'],
  ])('%s -> %s', (input, out) => expect(slugify(input)).toBe(out));
});

describe('init / exists', () => {
  it('creates layout and is idempotent', async () => {
    expect(await store.exists()).toBe(false);
    await store.init('My API');
    expect(await store.exists()).toBe(true);
    const cfg = JSON.parse(await read('on_route.json'));
    expect(cfg.name).toBe('My API');
    expect(cfg.version).toBe(1);
    expect(await read('.gitignore')).toBe(`*.local.yaml\n.history/\n${GITIGNORE_ENV_COMMENT}\nenvironments/dev.yaml\n`);
    expect((await fs.stat(p('requests'))).isDirectory()).toBe(true);
    expect(await read('environments', 'dev.yaml')).toContain('variables');

    await store.writeConfig({ ...cfg, name: 'Changed' });
    await store.init('Other');
    expect(JSON.parse(await read('on_route.json')).name).toBe('Changed');
    expect(await read('.gitignore')).toBe(`*.local.yaml\n.history/\n${GITIGNORE_ENV_COMMENT}\nenvironments/dev.yaml\n`);
    const tree = await store.load();
    expect(tree.errors).toEqual([]);
    expect(tree.environments).toEqual([{ name: 'dev', variables: [] }]);
    expect(tree.config.name).toBe('Changed');
  });

  it('dir getter', () => {
    expect(store.dir).toBe(path.join(root, '.on_route'));
  });
});

describe('load', () => {
  it('throws when not initialized', async () => {
    await expect(store.load()).rejects.toBeInstanceOf(StorageError);
  });

  it('missing on_route.json uses defaults and records error', async () => {
    await fs.mkdir(p('requests'), { recursive: true });
    const tree = await store.load();
    expect(tree.config.name).toBe(path.basename(root));
    expect(tree.config.variables[0].key).toBe('baseUrl');
    expect(tree.errors).toHaveLength(1);
    expect(tree.errors[0].file).toBe('.on_route/on_route.json');
  });

  it('invalid on_route.json records error', async () => {
    await store.init('x');
    await write('on_route.json', '{\n  "name": "x",\n  oops\n}');
    const tree = await store.load();
    expect(tree.config.name).toBe(path.basename(root));
    expect(tree.errors[0].file).toBe('.on_route/on_route.json');
    expect(tree.errors[0].line).toBe(3);
  });

  it('zod-invalid on_route.json records error', async () => {
    await store.init('x');
    await write('on_route.json', '{"version": 2, "name": "x"}');
    const tree = await store.load();
    expect(tree.errors[0].message).toMatch(/version/);
  });

  it('loads nested folders, requests, environments; skips bad files with line info', async () => {
    await store.init('x');
    const f = await store.createFolder('', 'Users');
    const g = await store.createFolder(f.id, 'Admin Stuff');
    await fs.mkdir(p('requests', 'plain'), { recursive: true });
    await store.createRequest('', 'Health');
    await store.createRequest(g.id, 'Ban User', { method: 'DELETE', url: '/ban', order: 2 });
    await write('requests/users/broken.yaml', 'name: Broken\nmethod: GET\nurl: [\n  a: :\n');
    await write('requests/users/invalid.yaml', 'name: Invalid\nmethod: FETCH\nurl: /x\n');
    await write('requests/plain/_folder.yaml', 'name: Plain\nauth:\n  type: magic\n');
    await write('requests/notes.txt', 'ignored');
    await write('environments/prod.yaml', 'variables:\n  - key: baseUrl\n    value: https://api.example.com\n');
    await write('environments/prod.local.yaml', 'variables:\n  - key: token\n    value: s3cret\n');
    await write('environments/bad.yaml', 'variables: 5\n');

    const tree = await store.load();
    expect(tree.folders.map((x) => [x.id, x.name]).sort()).toEqual([
      ['plain', 'plain'],
      ['users', 'Users'],
      ['users/admin-stuff', 'Admin Stuff'],
    ]);
    expect(tree.requests.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'health', folderId: '', name: 'Health', method: 'GET', url: '{{baseUrl}}/' },
      { id: 'users/admin-stuff/ban-user', folderId: 'users/admin-stuff', name: 'Ban User', method: 'DELETE', url: '/ban', order: 2 },
    ]);
    expect(tree.environments.map((e) => e.name)).toEqual(['dev', 'prod']);
    expect(tree.environments[1].variables).toEqual([{ key: 'baseUrl', value: 'https://api.example.com' }]);

    const byFile = Object.fromEntries(tree.errors.map((e) => [e.file, e]));
    expect(Object.keys(byFile).sort()).toEqual([
      '.on_route/environments/bad.yaml',
      '.on_route/requests/plain/_folder.yaml',
      '.on_route/requests/users/broken.yaml',
      '.on_route/requests/users/invalid.yaml',
    ]);
    expect(byFile['.on_route/requests/users/broken.yaml'].line).toBe(4);
    expect(byFile['.on_route/requests/users/invalid.yaml'].line).toBe(2);
    expect(byFile['.on_route/requests/users/invalid.yaml'].message).toMatch(/method/);
    expect(byFile['.on_route/requests/plain/_folder.yaml'].line).toBe(3);
    expect(byFile['.on_route/environments/bad.yaml'].line).toBe(1);
  });

  it('fills defaults for minimal files and coerces scalars', async () => {
    await store.init('x');
    await write('requests/min.yaml', 'url: /ping\nmethod: post\nheaders:\n  - key: X-Num\n    value: 42\n');
    const req = await store.readRequest('min');
    expect(req).toEqual({
      id: 'min',
      name: 'min',
      method: 'POST',
      url: '/ping',
      params: [],
      headers: [{ key: 'X-Num', value: '42' }],
      auth: { type: 'inherit' },
      body: { type: 'none' },
    });
    await write('requests/empty.yaml', '');
    expect((await store.readRequest('empty')).method).toBe('GET');
  });
});

describe('requests', () => {
  beforeEach(() => store.init('x'));

  it('round-trips a full request and writes clean YAML', async () => {
    const req = fullRequest('users/create-user');
    await store.writeRequest(req);
    expect(await store.readRequest(req.id)).toStrictEqual(req);
    const text = await read('requests', 'users', 'create-user.yaml');
    expect(text).toContain('content: |\n');
    expect(text).toContain('    {\n      "name": "Ada",');
    expect(text).toMatch(/docs: \|-?\n/);
    // key order
    const keys = text.split('\n').filter((l) => /^\w/.test(l)).map((l) => l.split(':')[0]);
    expect(keys).toEqual(['name', 'method', 'url', 'params', 'headers', 'auth', 'body', 'docs', 'order']);
  });

  it('omits defaults', async () => {
    const r = await store.createRequest('', 'Simple');
    const text = await read('requests', 'simple.yaml');
    expect(text).toBe('name: Simple\nmethod: GET\nurl: "{{baseUrl}}/"\n');
    expect(await store.readRequest(r.id)).toStrictEqual(r);
  });

  it('round-trips all body and auth variants', async () => {
    const variants: Array<Pick<RequestDef, 'auth' | 'body'>> = [
      { auth: { type: 'none' }, body: { type: 'raw', content: 'line1\nline2', contentType: 'text/plain' } },
      { auth: { type: 'bearer', token: 't' }, body: { type: 'urlencoded', fields: [{ key: 'a', value: '' }] } },
      {
        auth: { type: 'basic', username: 'u', password: 'p' },
        body: { type: 'form', fields: [{ key: 'f', value: 'a.png', kind: 'file' }, { key: 't', value: 'x', enabled: false }] },
      },
      { auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' }, body: { type: 'binary', filePath: 'data/x.bin' } },
      { auth: { type: 'inherit' }, body: { type: 'json', content: '' } },
      { auth: { type: 'inherit' }, body: { type: 'raw', content: '  leading spaces\n\ttab\ntrailing  \n\n' } },
    ];
    for (const [i, v] of variants.entries()) {
      const req: RequestDef = { ...fullRequest(`v${i}`), ...v, docs: undefined, order: undefined };
      delete req.docs;
      delete req.order;
      await store.writeRequest(req);
      expect(await store.readRequest(req.id)).toStrictEqual(req);
    }
  });

  it('readRequest throws StorageError with file and line', async () => {
    await write('requests/bad.yaml', 'name: x\nmethod: GET\n  url: - :\n');
    const err = await store.readRequest('bad').catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.file).toBe('.on_route/requests/bad.yaml');
    expect(err.line).toBeGreaterThan(0);
    await expect(store.readRequest('missing')).rejects.toBeInstanceOf(StorageError);
  });

  it('create picks unique slugs and applies init', async () => {
    const a = await store.createRequest('', 'Get User');
    const b = await store.createRequest('', 'Get User');
    const c = await store.createRequest('', 'get user!', { method: 'PUT', url: '/u' });
    expect([a.id, b.id, c.id]).toEqual(['get-user', 'get-user-2', 'get-user-3']);
    expect(c).toMatchObject({ name: 'get user!', method: 'PUT', url: '/u', auth: { type: 'inherit' } });
    const f = await store.createFolder('', 'Users');
    const d = await store.createRequest(f.id, 'Get User');
    expect(d.id).toBe('users/get-user');
  });

  it('rename changes name and file', async () => {
    const a = await store.createRequest('', 'Get User');
    await store.createRequest('', 'Fetch User');
    const r = await store.renameRequest(a.id, 'Fetch User');
    expect(r.id).toBe('fetch-user-2');
    expect(r.name).toBe('Fetch User');
    await expect(fs.access(p('requests', 'get-user.yaml'))).rejects.toThrow();
    expect(await store.readRequest('fetch-user-2')).toStrictEqual(r);
    // same slug: only name changes
    const s = await store.renameRequest(r.id, 'fetch user 2');
    expect(s.id).toBe('fetch-user-2');
    expect((await store.readRequest(s.id)).name).toBe('fetch user 2');
  });

  it('duplicate and delete', async () => {
    const f = await store.createFolder('', 'Users');
    const orig = { ...fullRequest(''), id: '' };
    const { id: _i, ...init } = orig;
    const a = await store.createRequest(f.id, 'Create User', init);
    const d = await store.duplicateRequest(a.id);
    expect(d.id).toBe('users/create-user-copy');
    expect(d.name).toBe('Create User copy');
    expect({ ...d, id: a.id, name: a.name }).toStrictEqual(a);
    await store.deleteRequest(a.id);
    await expect(store.readRequest(a.id)).rejects.toBeInstanceOf(StorageError);
    await expect(store.deleteRequest(a.id)).rejects.toBeInstanceOf(StorageError);
    expect((await store.load()).requests.map((r) => r.id)).toEqual(['users/create-user-copy']);
  });

  it('requestPath / requestIdFromPath', () => {
    const abs = store.requestPath('users/admin/get');
    expect(abs).toBe(path.join(root, '.on_route', 'requests', 'users', 'admin', 'get.yaml'));
    expect(store.requestIdFromPath(abs)).toBe('users/admin/get');
    expect(store.requestIdFromPath(p('requests', 'users', '_folder.yaml'))).toBeUndefined();
    expect(store.requestIdFromPath(p('environments', 'dev.yaml'))).toBeUndefined();
    expect(store.requestIdFromPath(p('requests', 'x.txt'))).toBeUndefined();
    expect(store.requestIdFromPath(p('requests', '.x.yaml.1.tmp'))).toBeUndefined();
    expect(store.requestIdFromPath(path.join(root, 'other.yaml'))).toBeUndefined();
  });

  it('rejects path traversal', async () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', '', 'a//b', '_folder', 'a/_folder']) {
      expect(() => store.requestPath(bad)).toThrow(StorageError);
    }
    await expect(store.readRequest('../../secret')).rejects.toBeInstanceOf(StorageError);
    await expect(store.writeRequest(fullRequest('../evil'))).rejects.toBeInstanceOf(StorageError);
    await expect(store.createRequest('..', 'x')).rejects.toBeInstanceOf(StorageError);
    await expect(store.createFolder('../..', 'x')).rejects.toBeInstanceOf(StorageError);
    await expect(store.deleteFolder('..')).rejects.toBeInstanceOf(StorageError);
    await expect(store.deleteFolder('')).rejects.toBeInstanceOf(StorageError);
    await expect(store.writeEnvironment({ name: '../x', variables: [] })).rejects.toBeInstanceOf(StorageError);
    await expect(store.readLocalOverrides('a/b')).rejects.toBeInstanceOf(StorageError);
    await expect(fs.access(path.join(root, 'evil.yaml'))).rejects.toThrow();
  });
});

describe('folders', () => {
  beforeEach(() => store.init('x'));

  it('create, write, round-trip via load', async () => {
    const f = await store.createFolder('', 'Users');
    expect(f).toEqual({ id: 'users', name: 'Users', auth: { type: 'inherit' }, variables: [] });
    expect(await read('requests', 'users', '_folder.yaml')).toBe('name: Users\n');
    const f2 = await store.createFolder('', 'users');
    expect(f2.id).toBe('users-2');
    const full = {
      ...f,
      auth: { type: 'bearer' as const, token: '{{t}}' },
      variables: [{ key: 'userId', value: '1', secret: true, description: 'd' }],
      docs: 'multi\nline',
      order: 1,
    };
    await store.writeFolder(full);
    const tree = await store.load();
    expect(tree.folders.find((x) => x.id === 'users')).toStrictEqual(full);
  });

  it('rename moves directory and children', async () => {
    const f = await store.createFolder('', 'Users');
    const sub = await store.createFolder(f.id, 'Admin');
    await store.createRequest(sub.id, 'Ban');
    const r = await store.renameFolder(f.id, 'People');
    expect(r).toMatchObject({ id: 'people', name: 'People' });
    const tree = await store.load();
    expect(tree.folders.map((x) => x.id).sort()).toEqual(['people', 'people/admin']);
    expect(tree.requests.map((x) => x.id)).toEqual(['people/admin/ban']);
    // folder without _folder.yaml can be renamed too
    await fs.mkdir(p('requests', 'raw'));
    const raw = await store.renameFolder('raw', 'Raw Stuff');
    expect(raw.id).toBe('raw-stuff');
    expect(await read('requests', 'raw-stuff', '_folder.yaml')).toBe('name: Raw Stuff\n');
    await expect(store.renameFolder('nope', 'x')).rejects.toBeInstanceOf(StorageError);
  });

  it('moveRequest moves into folder, top level, suffixes on conflict, no-op in place', async () => {
    const users = await store.createFolder('', 'Users');
    const a = await store.createRequest('', 'Get', { method: 'PUT' });
    await store.createRequest(users.id, 'Get');

    const moved = await store.moveRequest(a.id, users.id);
    expect(moved).toMatchObject({ id: 'users/get-2', name: 'Get', method: 'PUT' });
    expect(await fs.stat(p('requests', 'get.yaml')).catch(() => undefined)).toBeUndefined();
    expect((await store.readRequest('users/get-2')).method).toBe('PUT');

    const same = await store.moveRequest(moved.id, users.id);
    expect(same.id).toBe('users/get-2');

    const top = await store.moveRequest('users/get', '');
    expect(top.id).toBe('get');

    const deep = await store.moveRequest('get', 'new/nested');
    expect(deep.id).toBe('new/nested/get');
    const tree = await store.load();
    expect(tree.requests.map((r) => r.id).sort()).toEqual(['new/nested/get', 'users/get-2']);

    await expect(store.moveRequest('missing', users.id)).rejects.toBeInstanceOf(StorageError);
    await expect(store.moveRequest('users/get-2', '../x')).rejects.toBeInstanceOf(StorageError);
  });

  it('moveFolder moves subtree, suffixes, rejects self/descendant, no-op in place', async () => {
    const users = await store.createFolder('', 'Users');
    const admin = await store.createFolder(users.id, 'Admin');
    await store.createRequest(admin.id, 'Ban');
    const other = await store.createFolder('', 'Other');
    await store.createFolder(other.id, 'Admin');

    await expect(store.moveFolder(users.id, users.id)).rejects.toBeInstanceOf(StorageError);
    await expect(store.moveFolder(users.id, admin.id)).rejects.toBeInstanceOf(StorageError);
    await expect(store.moveFolder('nope', '')).rejects.toBeInstanceOf(StorageError);
    await expect(store.moveFolder(users.id, '../x')).rejects.toBeInstanceOf(StorageError);

    expect((await store.moveFolder(admin.id, users.id)).id).toBe('users/admin');

    const moved = await store.moveFolder(admin.id, other.id);
    expect(moved).toMatchObject({ id: 'other/admin-2', name: 'Admin' });
    let tree = await store.load();
    expect(tree.requests.map((r) => r.id)).toEqual(['other/admin-2/ban']);

    const top = await store.moveFolder(moved.id, '');
    expect(top.id).toBe('admin-2');
    tree = await store.load();
    expect(tree.folders.map((f) => f.id).sort()).toEqual(['admin-2', 'other', 'other/admin', 'users']);
    expect(tree.requests.map((r) => r.id)).toEqual(['admin-2/ban']);
  });

  it('delete is recursive', async () => {
    const f = await store.createFolder('', 'Users');
    await store.createFolder(f.id, 'Admin');
    await store.createRequest(f.id, 'Get');
    await store.deleteFolder(f.id);
    const tree = await store.load();
    expect(tree.folders).toEqual([]);
    expect(tree.requests).toEqual([]);
  });
});

describe('environments', () => {
  beforeEach(() => store.init('x'));

  it('blanks secrets, keeps local overrides separate', async () => {
    await store.writeEnvironment({
      name: 'prod',
      variables: [
        { key: 'baseUrl', value: 'https://x' },
        { key: 'token', value: 'real-secret', secret: true },
        { key: 'off', value: 'v', enabled: false },
      ],
    });
    const text = await read('environments', 'prod.yaml');
    expect(text).not.toContain('real-secret');
    const tree = await store.load();
    expect(tree.environments.find((e) => e.name === 'prod')?.variables).toStrictEqual([
      { key: 'baseUrl', value: 'https://x' },
      { key: 'token', value: '', secret: true },
      { key: 'off', value: 'v', enabled: false },
    ]);
    expect(await store.readLocalOverrides('prod')).toEqual([]);
    const local = [{ key: 'token', value: 'real-secret', secret: true }];
    await store.writeLocalOverrides('prod', local);
    expect(await store.readLocalOverrides('prod')).toStrictEqual(local);
    expect((await store.load()).environments.map((e) => e.name)).toEqual(['dev', 'prod']);
    await store.deleteEnvironment('prod');
    expect((await store.load()).environments.map((e) => e.name)).toEqual(['dev']);
  });

  it('invalid local overrides throw', async () => {
    await write('environments/dev.local.yaml', 'variables:\n  - value: no-key\n');
    const err = await store.readLocalOverrides('dev').catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.line).toBe(2);
  });

  it('multi-line variable values round-trip', async () => {
    const vars = [{ key: 'cert', value: '-----BEGIN-----\nabc\n-----END-----\n' }];
    await store.writeLocalOverrides('dev', vars);
    expect(await read('environments', 'dev.local.yaml')).toContain('value: |');
    expect(await store.readLocalOverrides('dev')).toStrictEqual(vars);
  });
});

describe('writeAll', () => {
  it('writes an import and overwrites existing', async () => {
    await store.init('x');
    await store.writeRequest({ ...fullRequest('api/users/list'), name: 'Old' });
    await store.writeAll({
      config: { version: 1, name: 'Imported', auth: { type: 'bearer', token: '{{t}}' }, variables: [], docs: 'hi' },
      folders: [
        { id: 'api/users', name: 'Users', auth: { type: 'inherit' }, variables: [] },
        { id: 'api', name: 'API', auth: { type: 'none' }, variables: [{ key: 'v', value: '1' }] },
      ],
      requests: [fullRequest('api/users/list'), fullRequest('root')],
      environments: [{ name: 'staging', variables: [{ key: 's', value: 'hidden', secret: true }] }],
    });
    const tree = await store.load();
    expect(tree.errors).toEqual([]);
    expect(tree.config).toStrictEqual({
      version: 1,
      name: 'Imported',
      auth: { type: 'bearer', token: '{{t}}' },
      variables: [],
      docs: 'hi',
    });
    expect(tree.folders.map((f) => [f.id, f.name])).toEqual([
      ['api', 'API'],
      ['api/users', 'Users'],
    ]);
    expect(tree.requests.map((r) => r.id).sort()).toEqual(['api/users/list', 'root']);
    expect(await store.readRequest('api/users/list')).toStrictEqual(fullRequest('api/users/list'));
    expect(tree.environments.find((e) => e.name === 'staging')?.variables[0].value).toBe('');
  });

  it('rejects bad ids before writing anything', async () => {
    await store.init('x');
    await expect(
      store.writeAll({ folders: [], requests: [fullRequest('ok'), fullRequest('../bad')], environments: [] }),
    ).rejects.toBeInstanceOf(StorageError);
    expect((await store.load()).requests).toEqual([]);
  });
});

describe('atomic writes', () => {
  it('leaves no temp files behind', async () => {
    await store.init('x');
    await store.createRequest('', 'A');
    await store.writeEnvironment({ name: 'dev', variables: [{ key: 'a', value: 'b' }] });
    const all = await fs.readdir(p(), { recursive: true });
    expect(all.filter((f) => String(f).endsWith('.tmp'))).toEqual([]);
  });
});

describe('locked variables and environment commit', () => {
  it('keeps locked project variables out of on_route.json and restores their order', async () => {
    await store.init('P');
    const variables = [
      { key: 'baseUrl', value: 'http://x' },
      { key: 'apiKey', value: 'k-123', secret: true },
      { key: 'region', value: 'eu' },
    ];
    await store.writeConfig({ version: 1, name: 'P', auth: { type: 'none' }, variables });
    const json = await read('on_route.json');
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('k-123');
    expect(await read('variables.local.yaml')).toContain('k-123');
    expect((await store.load()).config.variables).toEqual(variables);

    await store.writeConfig({ version: 1, name: 'P', auth: { type: 'none' }, variables: [variables[0]] });
    await expect(fs.access(p('variables.local.yaml'))).rejects.toThrow();
  });

  it('ignores environments that are not committed', async () => {
    await store.init('P');
    await store.writeEnvironment({ name: 'prod', variables: [{ key: 'baseUrl', value: 'https://api' }], commit: true });
    const { environments } = await store.load();
    expect(environments).toEqual([
      { name: 'dev', variables: [] },
      { name: 'prod', variables: [{ key: 'baseUrl', value: 'https://api' }], commit: true },
    ]);
    expect(await read('environments', 'prod.yaml')).toMatch(/^commit: true\n/);
    expect(await store.syncEnvironmentGitignore(environments)).toBe(false);

    expect(await store.syncEnvironmentGitignore([{ name: 'dev', commit: true }, { name: 'prod' }])).toBe(true);
    expect(await read('.gitignore')).toBe(`*.local.yaml\n.history/\n${GITIGNORE_ENV_COMMENT}\nenvironments/prod.yaml\n`);
    expect(await store.syncEnvironmentGitignore([{ name: 'dev', commit: true }, { name: 'prod', commit: true }])).toBe(true);
    expect(await read('.gitignore')).toBe('*.local.yaml\n.history/\n');
  });
});
