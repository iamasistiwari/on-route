import { describe, expect, it } from 'vitest';
import type { FolderDef, RequestSummary } from '../../shared/model';
import { buildTree, parentFolderId } from './tree';
import { parsePinKey, pinKey, pinnedRows, prunePins, remapPins, togglePin } from './pins';

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

describe('pinKey / parsePinKey', () => {
  it('round-trips both kinds, including ids with colons', () => {
    expect(pinKey('request', 'a/b')).toBe('request:a/b');
    expect(parsePinKey('folder:a/b')).toEqual({ kind: 'folder', id: 'a/b' });
    expect(parsePinKey(pinKey('request', 'odd:id'))).toEqual({ kind: 'request', id: 'odd:id' });
  });

  it('rejects malformed keys', () => {
    expect(parsePinKey('bogus:a')).toBeNull();
    expect(parsePinKey('folder:')).toBeNull();
    expect(parsePinKey('request')).toBeNull();
  });
});

describe('togglePin', () => {
  it('appends when absent and removes when present', () => {
    expect(togglePin([], 'request:a')).toEqual(['request:a']);
    expect(togglePin(['request:a'], 'folder:b')).toEqual(['request:a', 'folder:b']);
    expect(togglePin(['request:a', 'folder:b'], 'request:a')).toEqual(['folder:b']);
  });
});

describe('prunePins', () => {
  const folders = [folder('auth')];
  const requests = [req('auth/login'), req('ping')];

  it('drops pins whose item is gone', () => {
    expect(prunePins(['request:ping', 'request:deleted', 'folder:auth', 'folder:gone'], folders, requests)).toEqual([
      'request:ping',
      'folder:auth',
    ]);
  });

  it('returns the same array when nothing is stale', () => {
    const pins = ['request:ping', 'folder:auth'];
    expect(prunePins(pins, folders, requests)).toBe(pins);
  });
});

describe('remapPins', () => {
  it('rewrites a moved folder and everything under it', () => {
    const pins = ['folder:a', 'request:a/x', 'folder:a/sub', 'request:other'];
    expect(remapPins(pins, 'a', 'b/a')).toEqual(['folder:b/a', 'request:b/a/x', 'folder:b/a/sub', 'request:other']);
  });

  it('returns the same array when nothing matches', () => {
    const pins = ['request:other'];
    expect(remapPins(pins, 'a', 'b/a')).toBe(pins);
  });
});

describe('pinnedRows', () => {
  const root = buildTree([folder('auth'), folder('auth/admin')], [req('auth/login'), req('ping')]);

  it('returns flat depth-0 rows in pin order, skipping unknown ids', () => {
    const rows = pinnedRows(root, ['request:auth/login', 'folder:auth', 'request:missing']);
    expect(rows).toEqual([
      { kind: 'request', id: 'auth/login', name: 'login', depth: 0, parentId: 'auth', method: 'GET', url: '/auth/login' },
      { kind: 'folder', id: 'auth', name: 'auth', depth: 0, parentId: '', count: 1, expanded: false, hasChildren: false },
    ]);
  });

  it('is empty without pins', () => {
    expect(pinnedRows(root, [])).toEqual([]);
  });
});
