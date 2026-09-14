import { describe, expect, it } from 'vitest';
import type { FolderDef, RequestSummary } from '../../shared/model';
import { ancestorFolderIds, buildTree, canDrop, filterTree, flattenTree, fuzzyMatch, matchScore, parentFolderId, rowInFolder } from './tree';

const folder = (id: string, extra: Partial<FolderDef> = {}): FolderDef => ({
  id,
  name: id.split('/').pop()!,
  auth: { type: 'inherit' },
  variables: [],
  ...extra,
});
const req = (id: string, extra: Partial<RequestSummary> = {}): RequestSummary => ({
  id,
  folderId: parentFolderId(id),
  name: id.split('/').pop()!,
  method: 'GET',
  url: `/${id}`,
  ...extra,
});

describe('parentFolderId / ancestorFolderIds', () => {
  it('derives parents', () => {
    expect(parentFolderId('a/b/c')).toBe('a/b');
    expect(parentFolderId('a')).toBe('');
    expect(ancestorFolderIds('a/b/c')).toEqual(['a', 'a/b']);
    expect(ancestorFolderIds('a/b/c', true)).toEqual(['a', 'a/b', 'a/b/c']);
    expect(ancestorFolderIds('')).toEqual([]);
  });
});

describe('buildTree', () => {
  it('sorts folders and requests by order then name and counts descendants', () => {
    const root = buildTree(
      [folder('zeta'), folder('alpha', { order: 5 }), folder('beta', { order: 1 })],
      [req('zeta/b'), req('zeta/a'), req('zeta/c', { order: 0 }), req('top')],
    );
    expect(root.folders.map((f) => f.id)).toEqual(['beta', 'alpha', 'zeta']);
    expect(root.folders[2].requests.map((r) => r.id)).toEqual(['zeta/c', 'zeta/a', 'zeta/b']);
    expect(root.count).toBe(4);
    expect(root.folders[2].count).toBe(3);
  });

  it('creates implicit parent folders', () => {
    const root = buildTree([], [req('x/y/z')]);
    expect(root.folders[0].id).toBe('x');
    expect(root.folders[0].folders[0].id).toBe('x/y');
    expect(root.folders[0].count).toBe(1);
  });
});

describe('filterTree', () => {
  const root = buildTree([folder('users'), folder('auth')], [req('users/list', { name: 'List users' }), req('auth/login', { method: 'POST' })]);

  it('matches method, name, url and prunes empty folders', () => {
    const f = filterTree(root, 'post')!;
    expect(f.folders.map((x) => x.id)).toEqual(['auth']);
    expect(filterTree(root, 'lst usr')!.folders[0].requests[0].id).toBe('users/list');
  });

  it('returns the node untouched without a query', () => {
    expect(filterTree(root, '')).toBe(root);
  });

  it('fuzzy matches subsequences', () => {
    expect(fuzzyMatch('gtusr', 'GET users')).toBe(true);
    expect(fuzzyMatch('xyz', 'GET users')).toBe(false);
    // Small typos of whole words (4+ characters).
    expect(fuzzyMatch('uesrs', 'GET List users /users')).toBe(true);
    expect(fuzzyMatch('helht', 'GET Health check /health')).toBe(true);
    expect(fuzzyMatch('ordr', 'GET users')).toBe(false);
  });
});

describe('search ranking', () => {
  const root = buildTree(
    [folder('dark-web'), folder('financial'), folder('gst')],
    [
      req('dark-web/domain-search', { method: 'POST', url: '{{baseUrl}}/api/v1/domain-search' }),
      req('financial/account-validation', { method: 'POST', url: '{{baseUrl}}/api/v1/account-validation' }),
      req('financial/pan-info', { method: 'POST', url: '{{baseUrl}}/api/v1/pan-info' }),
      req('financial/pan-basic', { method: 'POST', url: '{{baseUrl}}/api/v1/pan-basic' }),
      req('gst/company-name-to-cin', { method: 'POST', url: '{{baseUrl}}/api/v1/company/cin' }),
      req('gst/lookup', { method: 'POST', url: '{{baseUrl}}/api/v1/gst/pan-basic-lookup' }),
    ],
  );
  const ids = (f: ReturnType<typeof filterTree>) => flattenTree(f!, () => true).filter((r) => r.kind === 'request').map((r) => r.id);

  it('ranks the exact name first, then URL path matches, and drops fuzzy noise', () => {
    expect(ids(filterTree(root, 'pan-basic'))).toEqual(['financial/pan-basic', 'gst/lookup']);
  });

  it('orders by name before URL', () => {
    const r = { method: 'POST' as const, name: 'lookup', url: '/api/pan' };
    expect(matchScore('pan', { ...r, name: 'pan' })).toBeGreaterThan(matchScore('pan', { ...r, name: 'pan-info' }));
    expect(matchScore('pan', { ...r, name: 'pan-info' })).toBeGreaterThan(matchScore('pan', r));
    expect(matchScore('pan', r)).toBeGreaterThan(matchScore('pn', r));
  });

  it('falls back to fuzzy matches when nothing matches directly', () => {
    expect(ids(filterTree(root, 'pnbasc'))).toContain('financial/pan-basic');
  });
});

describe('flattenTree', () => {
  const root = buildTree([folder('a'), folder('a/b')], [req('a/b/deep'), req('a/r1'), req('top')]);

  it('lists folders first and only recurses into expanded folders', () => {
    expect(flattenTree(root, () => false).map((r) => r.id)).toEqual(['a', 'top']);
    const all = flattenTree(root, () => true);
    expect(all.map((r) => `${r.depth}:${r.id}`)).toEqual(['0:a', '1:a/b', '2:a/b/deep', '1:a/r1', '0:top']);
    expect(all[0]).toMatchObject({ kind: 'folder', expanded: true, count: 2, hasChildren: true });
  });
});

describe('canDrop', () => {
  it('rejects dropping into the current parent', () => {
    expect(canDrop({ kind: 'request', id: 'a/r', parentId: 'a' }, 'a')).toBe(false);
    expect(canDrop({ kind: 'request', id: 'r', parentId: '' }, '')).toBe(false);
  });

  it('rejects dropping a folder into itself or a descendant', () => {
    const item = { kind: 'folder' as const, id: 'a', parentId: '' };
    expect(canDrop(item, 'a')).toBe(false);
    expect(canDrop(item, 'a/b')).toBe(false);
    expect(canDrop(item, 'ab')).toBe(true);
  });

  it('allows other moves, including to top level', () => {
    expect(canDrop({ kind: 'request', id: 'a/r', parentId: 'a' }, 'b')).toBe(true);
    expect(canDrop({ kind: 'folder', id: 'a/b', parentId: 'a' }, '')).toBe(true);
  });
});

describe('rowInFolder', () => {
  it('matches the folder row and its descendants', () => {
    expect(rowInFolder({ kind: 'folder', id: 'a', parentId: '' }, 'a')).toBe(true);
    expect(rowInFolder({ kind: 'request', id: 'a/b/r', parentId: 'a/b' }, 'a')).toBe(true);
    expect(rowInFolder({ kind: 'folder', id: 'ab', parentId: '' }, 'a')).toBe(false);
    expect(rowInFolder({ kind: 'request', id: 'r', parentId: '' }, 'a')).toBe(false);
  });
});
