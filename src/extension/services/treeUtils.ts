import type { FolderDef, ProjectTree } from '../../shared/model';
import { parentId } from './resolve';

export function shortPath(url: string): string {
  let s = url.trim().replace(/^\{\{[^{}]+\}\}/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  if (!s) s = '/';
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

const normalizeName = (name: string) => name.trim().toLocaleLowerCase();

/**
 * Error message when another request (or folder) in the project already uses `name` (case-insensitive),
 * otherwise undefined. `excludeId` is the item being renamed.
 */
export function nameConflict(tree: ProjectTree | undefined, kind: 'request' | 'folder', name: string, excludeId?: string): string | undefined {
  if (!tree || !name.trim()) return undefined;
  const wanted = normalizeName(name);
  const items: { id: string; name: string }[] = kind === 'request' ? tree.requests : allFolders(tree);
  const clash = items.find((i) => i.id !== excludeId && normalizeName(i.name) === wanted);
  if (!clash) return undefined;
  return `A ${kind} named "${clash.name}" already exists${clash.id.includes('/') ? ` (${clash.id})` : ''}. Choose a different name.`;
}

/** `base`, else `base 2`, `base 3`… — the first name no other request / folder uses. */
export function uniqueName(tree: ProjectTree | undefined, kind: 'request' | 'folder', base: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!nameConflict(tree, kind, name)) return name;
  }
}

/** All folders incl. synthesized ones for directories without _folder.yaml. */
export function allFolders(tree: ProjectTree): FolderDef[] {
  const map = new Map(tree.folders.map((f) => [f.id, f]));
  const ensure = (id: string) => {
    while (id && !map.has(id)) {
      map.set(id, { id, name: id.slice(id.lastIndexOf('/') + 1), auth: { type: 'inherit' }, variables: [] });
      id = parentId(id);
    }
  };
  for (const f of tree.folders) ensure(parentId(f.id));
  for (const r of tree.requests) ensure(r.folderId);
  return [...map.values()];
}
