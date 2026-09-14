// Pure helpers for the request tree (sidebar + overview endpoints).
import type { FolderDef, RequestMethod, RequestSummary } from '../../shared/model';
import { isTypoOf, typoBudget } from './fuzzy';
import { byOrder, placeBefore } from '../../shared/order';

export { byOrder };

export interface FolderNode {
  id: string;
  name: string;
  def?: FolderDef;
  folders: FolderNode[];
  requests: RequestSummary[];
  order?: number;
  /** Total requests in this folder and all descendants. */
  count: number;
}


/** "a/b/c" -> "a/b"; "a" -> "". */
export function parentFolderId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? '' : id.slice(0, slash);
}

/** All ancestor folder ids of a folder id, outermost first ("a/b/c" -> ["a", "a/b"]). Includes the id itself when `inclusive`. */
export function ancestorFolderIds(id: string, inclusive = false): string[] {
  if (!id) return [];
  const parts = id.split('/');
  const out: string[] = [];
  for (let i = 1; i <= parts.length - (inclusive ? 0 : 1); i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function buildTree(folders: FolderDef[], requests: RequestSummary[]): FolderNode {
  const root: FolderNode = { id: '', name: '', folders: [], requests: [], count: 0 };
  const map = new Map<string, FolderNode>([['', root]]);
  const ensure = (id: string): FolderNode => {
    const existing = map.get(id);
    if (existing) return existing;
    const parent = ensure(parentFolderId(id));
    const node: FolderNode = { id, name: id.slice(id.lastIndexOf('/') + 1), folders: [], requests: [], count: 0 };
    parent.folders.push(node);
    map.set(id, node);
    return node;
  };
  for (const f of folders) {
    const node = ensure(f.id);
    node.def = f;
    node.name = f.name || node.name;
    node.order = f.order;
  }
  for (const r of requests) ensure(r.folderId).requests.push(r);
  const finish = (n: FolderNode): number => {
    n.folders.sort(byOrder);
    n.requests.sort(byOrder);
    n.count = n.requests.length + n.folders.reduce((s, f) => s + finish(f), 0);
    return n.count;
  };
  finish(root);
  return root;
}

/**
 * Every query token must appear in the haystack: as a substring, as a subsequence, or (4+ characters) as a
 * small typo of one of its words ("uesrs" finds "users").
 */
export function fuzzyMatch(query: string, haystack: string): boolean {
  const h = haystack.toLowerCase();
  let words: string[] | undefined;
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => {
      if (h.includes(tok)) return true;
      let i = 0;
      for (const c of h) if (c === tok[i] && ++i === tok.length) return true;
      if (typoBudget(tok.length) === 0) return false;
      words ??= h.split(/[^a-z0-9]+/).filter(Boolean);
      return words.some((w) => isTypoOf(tok, w));
    });
}

export function requestMatches(query: string, r: Pick<RequestSummary, 'method' | 'name' | 'url'>): boolean {
  return fuzzyMatch(query, `${r.method} ${r.name} ${r.url}`);
}

/** Scores at or above this are "real" hits (name or URL text); below are fuzzy fallbacks. */
export const STRONG_MATCH = 50;

/** URL without a leading {{baseUrl}}-style variable or scheme/host: what the user thinks of as the path. */
function urlPath(url: string): string {
  return url
    .replace(/^\{\{[^}]*\}\}/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .toLowerCase();
}

/**
 * How well a request matches the query (0 = no match). Name first, then the URL path, then fuzzy:
 * exact name > name prefix > name contains > every word in the name > path ends with / contains
 * > every word anywhere > fuzzy name > fuzzy path > fuzzy anything.
 */
export function matchScore(query: string, r: Pick<RequestSummary, 'method' | 'name' | 'url'>): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = r.name.toLowerCase();
  const path = urlPath(r.url);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  if (name.includes(q)) return 80;
  if (tokens.every((t) => name.includes(t))) return 70;
  if (path.endsWith(`/${q}`)) return 65;
  if (path.includes(q)) return 60;
  const all = `${r.method} ${r.name} ${r.url}`.toLowerCase();
  if (tokens.every((t) => all.includes(t))) return STRONG_MATCH;
  if (fuzzyMatch(q, r.name)) return 30;
  if (fuzzyMatch(q, path)) return 20;
  if (fuzzyMatch(q, all)) return 10;
  return 0;
}

/**
 * Keeps requests matching the query and the folders containing them, best matches first (requests by score,
 * folders by their best request; ties keep tree order). When anything matches by name or URL, fuzzy-only
 * matches are dropped so "pan-basic" doesn't drown in every name sharing its letters.
 * Returns null when nothing matches (root: empty node).
 */
export function filterTree(node: FolderNode, query: string): FolderNode | null {
  if (!query) return node;
  const scores = new Map<string, number>();
  const score = (n: FolderNode) => {
    for (const r of n.requests) scores.set(r.id, matchScore(query, r));
    n.folders.forEach(score);
  };
  score(node);
  const min = Math.max(0, ...scores.values()) >= STRONG_MATCH ? STRONG_MATCH : 1;
  const keep = (n: FolderNode): { node: FolderNode; best: number } | null => {
    const requests = n.requests
      .map((r) => ({ r, s: scores.get(r.id) ?? 0 }))
      .filter((x) => x.s >= min)
      .sort((a, b) => b.s - a.s);
    const folders = n.folders
      .map(keep)
      .filter((f): f is { node: FolderNode; best: number } => f !== null)
      .sort((a, b) => b.best - a.best);
    if (n.id !== '' && requests.length === 0 && folders.length === 0) return null;
    const best = Math.max(0, ...requests.map((x) => x.s), ...folders.map((f) => f.best));
    return { node: { ...n, requests: requests.map((x) => x.r), folders: folders.map((f) => f.node) }, best };
  };
  return keep(node)?.node ?? null;
}

export type TreeRow =
  | { kind: 'folder'; id: string; name: string; depth: number; parentId: string; count: number; expanded: boolean; hasChildren: boolean }
  | { kind: 'request'; id: string; name: string; depth: number; parentId: string; method: RequestMethod; url: string };

/** Visible rows in display order: folders first, then requests, recursing into expanded folders. */
export function flattenTree(root: FolderNode, isExpanded: (folderId: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: FolderNode, depth: number) => {
    for (const f of node.folders) {
      const expanded = isExpanded(f.id);
      rows.push({
        kind: 'folder',
        id: f.id,
        name: f.name,
        depth,
        parentId: node.id,
        count: f.count,
        expanded,
        hasChildren: f.folders.length + f.requests.length > 0,
      });
      if (expanded) walk(f, depth + 1);
    }
    for (const r of node.requests) {
      rows.push({ kind: 'request', id: r.id, name: r.name, depth, parentId: node.id, method: r.method, url: r.url });
    }
  };
  walk(root, 0);
  return rows;
}

export interface DragItem {
  kind: 'folder' | 'request';
  id: string;
  /** Folder currently containing the item ("" = top level). */
  parentId: string;
}

/** Whether `item` may be moved into `targetFolderId` ("" = top level). */
export function canDrop(item: DragItem, targetFolderId: string): boolean {
  if (targetFolderId === item.parentId) return false;
  if (item.kind === 'folder' && (targetFolderId === item.id || targetFolderId.startsWith(`${item.id}/`))) return false;
  return true;
}

/** True when a row lies inside the drop target block (the target folder itself or anything under it). */
export function rowInFolder(row: Pick<TreeRow, 'kind' | 'id' | 'parentId'>, folderId: string): boolean {
  if (folderId === '') return true;
  const path = row.kind === 'folder' ? row.id : row.parentId;
  return path === folderId || path.startsWith(`${folderId}/`);
}

export function findFolder(root: FolderNode, id: string): FolderNode | undefined {
  if (root.id === id) return root;
  const child = root.folders.find((f) => id === f.id || id.startsWith(`${f.id}/`));
  return child && findFolder(child, id);
}

export interface DropPlacement {
  /** Folder the item ends up in ("" = top level). */
  folderId: string;
  /** Sibling of the same kind to place the item before; null = at the end. */
  before: string | null;
  /** Insertion line on the hovered row; undefined = dropping into a folder. */
  line?: 'before' | 'after';
}

/**
 * Dropping on the empty space below the rows: to the end of the top level. For an item already at the top
 * level this reorders it to the end of its kind (folders before requests); null when it is already last.
 */
export function endPlacement(root: FolderNode, item: DragItem): DropPlacement | null {
  if (item.parentId !== '') return { folderId: '', before: null };
  const ids = item.kind === 'request' ? root.requests.map((r) => r.id) : root.folders.map((f) => f.id);
  if (ids[ids.length - 1] === item.id) return null;
  return { folderId: '', before: null, line: 'after' };
}

/**
 * Where `item` lands when dropped on `row` at vertical position `ratio` (0 = top edge, 1 = bottom edge).
 * Request on request: line above / below. Folder on folder: line near the edges, into it in the middle.
 * Anything else drops into the row's folder. Null when invalid or when nothing would change.
 */
export function dropPlacement(root: FolderNode, item: DragItem, row: TreeRow, ratio: number): DropPlacement | null {
  if (row.kind === item.kind && row.id === item.id) return null;
  if (item.kind === 'folder') {
    const under = (id: string) => id === item.id || id.startsWith(`${item.id}/`);
    if ((row.kind === 'folder' && under(row.id)) || under(row.parentId)) return null;
  }
  let line: DropPlacement['line'];
  if (item.kind === 'request' && row.kind === 'request') line = ratio < 0.5 ? 'before' : 'after';
  else if (item.kind === 'folder' && row.kind === 'folder') line = ratio < 0.3 ? 'before' : ratio > 0.7 && !row.expanded ? 'after' : undefined;

  if (!line) {
    const folderId = row.kind === 'folder' ? row.id : row.parentId;
    return canDrop(item, folderId) ? { folderId, before: null } : null;
  }
  const folderId = row.parentId;
  const node = findFolder(root, folderId);
  const ids = node ? (item.kind === 'request' ? node.requests.map((r) => r.id) : node.folders.map((f) => f.id)) : [];
  const before = line === 'before' ? row.id : (ids[ids.indexOf(row.id) + 1] ?? null);
  if (folderId === item.parentId) {
    const next = placeBefore(ids, item.id, before);
    if (next.every((id, i) => id === ids[i])) return null;
  }
  return { folderId, before, line };
}
