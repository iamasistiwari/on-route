// Pinned requests and folders. Pins are personal: they live in the sidebar's persisted UI state, never in YAML.
import type { SidebarItemRef } from '../../shared/protocol';
import { findFolder, type FolderNode, type TreeRow } from './tree';

/** Stable key for the pin list; `id` may itself contain ":" so only the first segment is the kind. */
export const pinKey = (kind: SidebarItemRef['kind'], id: string): string => `${kind}:${id}`;

export function parsePinKey(key: string): SidebarItemRef | null {
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (!id || (kind !== 'folder' && kind !== 'request')) return null;
  return { kind, id };
}

/** Pin when absent (newest last), unpin when present. */
export function togglePin(pins: readonly string[], key: string): string[] {
  return pins.includes(key) ? pins.filter((p) => p !== key) : [...pins, key];
}

/** Drops pins for items that no longer exist (deleted or renamed). Returns `pins` itself when all are live. */
export function prunePins(
  pins: readonly string[],
  folders: readonly { id: string }[],
  requests: readonly { id: string }[],
): readonly string[] {
  const live = { folder: new Set(folders.map((f) => f.id)), request: new Set(requests.map((r) => r.id)) };
  const kept = pins.filter((key) => {
    const ref = parsePinKey(key);
    return ref !== null && live[ref.kind].has(ref.id);
  });
  return kept.length === pins.length ? pins : kept;
}

/** Folder ids are paths: carry pins over when a folder moves. Returns `pins` itself when nothing matches. */
export function remapPins(pins: readonly string[], oldFolderId: string, newFolderId: string): readonly string[] {
  const prefix = `${oldFolderId}/`;
  let changed = false;
  const next = pins.map((key) => {
    const ref = parsePinKey(key);
    if (!ref) return key;
    const id =
      ref.kind === 'folder' && ref.id === oldFolderId
        ? newFolderId
        : ref.id.startsWith(prefix)
          ? newFolderId + ref.id.slice(oldFolderId.length)
          : ref.id;
    if (id === ref.id) return key;
    changed = true;
    return pinKey(ref.kind, id);
  });
  return changed ? next : pins;
}

/**
 * Rows for the "Pinned" section: flat (depth 0), in the order they were pinned. Folders render without a
 * twistie — the section is a shortcut list, expanding happens in the tree below.
 */
export function pinnedRows(root: FolderNode, pins: readonly string[]): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const key of pins) {
    const ref = parsePinKey(key);
    if (!ref) continue;
    if (ref.kind === 'folder') {
      const node = findFolder(root, ref.id);
      if (!node || node.id !== ref.id) continue;
      rows.push({
        kind: 'folder',
        id: node.id,
        name: node.name,
        depth: 0,
        parentId: node.id.slice(0, Math.max(0, node.id.lastIndexOf('/'))),
        count: node.count,
        expanded: false,
        hasChildren: false,
      });
    } else {
      const parent = findFolder(root, ref.id.slice(0, Math.max(0, ref.id.lastIndexOf('/'))));
      const r = parent?.requests.find((x) => x.id === ref.id);
      if (!r) continue;
      rows.push({ kind: 'request', id: r.id, name: r.name, depth: 0, parentId: r.folderId, method: r.method, url: r.url });
    }
  }
  return rows;
}
