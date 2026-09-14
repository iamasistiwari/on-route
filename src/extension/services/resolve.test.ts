import { describe, expect, it } from 'vitest';
import type { ProjectTree, RequestDef } from '../../shared/model';
import { newRequest } from '../../shared/model';
import { buildResolution, folderChainIds, prepareRequest } from './resolve';

function tree(): ProjectTree {
  return {
    config: {
      version: 1,
      name: 'p',
      auth: { type: 'bearer', token: 'project-token' },
      variables: [
        { key: 'baseUrl', value: 'http://project' },
        { key: 'a', value: 'project' },
        { key: 'onlyProject', value: '1' },
      ],
    },
    folders: [
      { id: 'users', name: 'Users', auth: { type: 'inherit' }, variables: [{ key: 'a', value: 'users' }, { key: 'b', value: 'users' }] },
      {
        id: 'users/admin',
        name: 'Admin',
        auth: { type: 'basic', username: '{{user}}', password: 'pw' },
        variables: [{ key: 'b', value: 'admin' }, { key: 'user', value: 'root' }],
      },
    ],
    requests: [],
    environments: [
      { name: 'dev', variables: [{ key: 'baseUrl', value: 'http://dev' }, { key: 'secret', value: '', secret: true }] },
      { name: 'prod', variables: [{ key: 'baseUrl', value: 'http://prod' }] },
    ],
    errors: [],
  };
}

function req(id: string, patch: Partial<RequestDef> = {}): RequestDef {
  return { ...newRequest(id, 'r'), ...patch };
}

describe('folderChainIds', () => {
  it('builds outer->inner ids', () => {
    expect(folderChainIds('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(folderChainIds('')).toEqual([]);
  });
});

describe('buildResolution variables', () => {
  it('applies project < folders outer->inner precedence', () => {
    const r = buildResolution(tree(), req('users/admin/x'), null, []);
    expect(r.vars.a).toBe('users');
    expect(r.vars.b).toBe('admin');
    expect(r.vars.baseUrl).toBe('http://project');
    expect(r.scopes.map((s) => s.name)).toEqual(['project', 'folder Users', 'folder Admin']);
  });

  it('environment overrides folders and local overrides environment', () => {
    const r = buildResolution(tree(), req('users/x'), 'dev', [
      { key: 'a', value: 'local' },
      { key: 'secret', value: 's3cr3t' },
    ]);
    expect(r.vars.baseUrl).toBe('http://dev');
    expect(r.vars.a).toBe('local');
    expect(r.vars.secret).toBe('s3cr3t');
    expect(r.scopes.map((s) => s.name)).toEqual(['project', 'folder Users', 'environment dev', 'local']);
    expect(r.variableKeys).toContain('onlyProject');
    expect(r.variableKeys).toContain('secret');
    // Secret values are never exposed to the webview, even when resolved locally.
    expect(r.variables.find((v) => v.key === 'secret')).toMatchObject({ secret: true, resolved: true, value: '' });
    expect(r.variables.find((v) => v.key === 'onlyProject')).toMatchObject({ value: '1', source: 'project', resolved: true });
    // Without a local value the secret is listed but does not resolve.
    const noLocal = buildResolution(tree(), req('users/x'), 'dev', []);
    expect(noLocal.variables.find((v) => v.key === 'secret')).toMatchObject({ secret: true, resolved: false });
  });

  it('ignores unknown environment', () => {
    const r = buildResolution(tree(), req('x'), 'nope', [{ key: 'a', value: 'local' }]);
    expect(r.vars.a).toBe('project');
  });

  it('synthesizes folders without FolderDef', () => {
    const r = buildResolution(tree(), req('ghost/deep/x'), null, []);
    expect(r.scopes.map((s) => s.name)).toEqual(['project', 'folder ghost', 'folder deep']);
  });
});

describe('auth inheritance', () => {
  it('request auth wins', () => {
    const r = buildResolution(tree(), req('users/admin/x', { auth: { type: 'none' } }), null, []);
    expect(r.auth).toEqual({ type: 'none' });
    expect(r.authSource).toBe('request');
    expect(r.inheritedAuthSource).toBe('folder Admin');
  });

  it('inner folder beats project', () => {
    const r = buildResolution(tree(), req('users/admin/x'), null, []);
    expect(r.authSource).toBe('folder Admin');
    expect(r.auth.type).toBe('basic');
  });

  it('falls back to project through inheriting folders', () => {
    const r = buildResolution(tree(), req('users/x'), null, []);
    expect(r.authSource).toBe('project');
    expect(r.inheritedAuthSource).toBe('project');
  });

  it('none when everything inherits', () => {
    const t = tree();
    t.config.auth = { type: 'inherit' };
    const r = buildResolution(t, req('x'), null, []);
    expect(r.authSource).toBe('none');
    expect(r.auth).toEqual({ type: 'none' });
  });
});

describe('prepareRequest', () => {
  it('resolves url and applies bearer auth', () => {
    const p = prepareRequest(tree(), req('users/x', { url: '{{baseUrl}}/users/{{missingVar}}' }), 'prod', []);
    expect(p.request.url).toBe('http://prod/users/{{missingVar}}');
    expect(p.missing).toEqual(['missingVar']);
    expect(p.request.headers).toContainEqual({ key: 'Authorization', value: 'Bearer project-token' });
  });

  it('keeps placeholders when resolveVariables=false but applies auth', () => {
    const p = prepareRequest(tree(), req('users/admin/x', { url: '{{baseUrl}}/a' }), 'prod', [], false);
    expect(p.request.url).toBe('{{baseUrl}}/a');
    expect(p.missing).toEqual([]);
    const auth = p.request.headers.find((h) => h.key === 'Authorization');
    expect(auth?.value.startsWith('Basic ')).toBe(true);
  });
});
