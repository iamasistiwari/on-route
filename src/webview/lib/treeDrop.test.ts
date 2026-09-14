import { describe, expect, it } from 'vitest';
import type { FolderDef, RequestSummary } from '../../shared/model';
import { buildTree, dropPlacement, endPlacement, flattenTree, type DragItem, type TreeRow } from './tree';

const folder = (id: string, order?: number): FolderDef => ({ id, name: id.split('/').pop()!, auth: { type: 'inherit' }, variables: [], order });
const request = (id: string, order?: number): RequestSummary => ({
  id,
  folderId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
  name: id.split('/').pop()!,
  method: 'GET',
  url: `/${id}`,
  order,
});

const root = buildTree([folder('a'), folder('b'), folder('a/inner')], [request('a/one'), request('a/two'), request('a/three'), request('b/four'), request('top')]);
const rows = flattenTree(root, () => true);
const row = (kind: TreeRow['kind'], id: string) => rows.find((r) => r.kind === kind && r.id === id)!;
const drag = (kind: DragItem['kind'], id: string): DragItem => ({ kind, id, parentId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '' });

describe('dropPlacement', () => {
  it('reorders requests within a folder with a line above or below', () => {
    // Sorted by name: one, three, two.
    expect(dropPlacement(root, drag('request', 'a/two'), row('request', 'a/one'), 0.2)).toEqual({ folderId: 'a', before: 'a/one', line: 'before' });
    expect(dropPlacement(root, drag('request', 'a/one'), row('request', 'a/three'), 0.8)).toEqual({ folderId: 'a', before: 'a/two', line: 'after' });
    expect(dropPlacement(root, drag('request', 'a/one'), row('request', 'a/two'), 0.9)).toEqual({ folderId: 'a', before: null, line: 'after' });
  });

  it('ignores drops that would not change anything', () => {
    expect(dropPlacement(root, drag('request', 'a/one'), row('request', 'a/one'), 0.5)).toBeNull();
    expect(dropPlacement(root, drag('request', 'a/one'), row('request', 'a/three'), 0.1)).toBeNull();
    expect(dropPlacement(root, drag('request', 'a/one'), row('folder', 'a'), 0.5)).toBeNull();
  });

  it('moves requests between folders at a position, or into a folder at the end', () => {
    expect(dropPlacement(root, drag('request', 'top'), row('request', 'b/four'), 0.1)).toEqual({ folderId: 'b', before: 'b/four', line: 'before' });
    expect(dropPlacement(root, drag('request', 'top'), row('folder', 'a'), 0.9)).toEqual({ folderId: 'a', before: null });
  });

  it('reorders folders near the edges and nests them in the middle, never into themselves', () => {
    expect(dropPlacement(root, drag('folder', 'b'), row('folder', 'a'), 0.1)).toEqual({ folderId: '', before: 'a', line: 'before' });
    expect(dropPlacement(root, drag('folder', 'b'), row('folder', 'a'), 0.5)).toEqual({ folderId: 'a', before: null });
    expect(dropPlacement(root, drag('folder', 'a'), row('folder', 'a/inner'), 0.5)).toBeNull();
    expect(dropPlacement(root, drag('folder', 'a'), row('request', 'a/one'), 0.5)).toBeNull();
  });
});

describe('endPlacement', () => {
  it('reorders a top-level folder to the end when dropped below the rows', () => {
    expect(endPlacement(root, drag('folder', 'a'))).toEqual({ folderId: '', before: null, line: 'after' });
    expect(endPlacement(root, drag('folder', 'b'))).toBeNull();
    expect(endPlacement(root, drag('request', 'top'))).toBeNull();
  });

  it('moves nested items to the end of the top level', () => {
    expect(endPlacement(root, drag('request', 'a/one'))).toEqual({ folderId: '', before: null });
    expect(endPlacement(root, drag('folder', 'a/inner'))).toEqual({ folderId: '', before: null });
  });
});
