// Decides which scanned endpoints become new request files, where they go and what they are named.
import type { BodyConfig, FolderDef, HttpMethod, RequestDef, RequestSummary } from '../../shared/model';
import { canonicalPath, endpointKey, pathFromUrl, requestSlug, routeGroup } from './paths';
import type { ScannedRoute } from './types';

export interface PlannedRequest {
  key: string;
  /** File name without extension, case preserved. */
  slug: string;
  request: Omit<RequestDef, 'id'>;
}

export interface PlannedGroup {
  /** Existing folder id ("" = top level), or null when `newFolder` has to be created at the top level. */
  folderId: string | null;
  newFolder?: string;
  requests: PlannedRequest[];
}

export interface ScanPlan {
  groups: PlannedGroup[];
  /** Every endpoint key seen so far (previous scans + this one), sorted. */
  known: string[];
  added: number;
}

const BODY_METHODS = new Set<HttpMethod>(['POST', 'PUT', 'PATCH']);
/** A router group only gets its own folder when it has at least this many endpoints. */
const MIN_GROUP_SIZE = 2;

/**
 * Only endpoints never seen before are planned: not in `known` (so requests the user deleted stay
 * deleted) and not matching the method + path of an existing request (so renamed, moved or hand-made
 * requests are left alone). Existing files are never touched.
 */
export function planScan(
  routes: readonly ScannedRoute[],
  tree: { folders: readonly FolderDef[]; requests: readonly RequestSummary[] },
  known: readonly string[],
): ScanPlan {
  const knownSet = new Set(known);
  const taken = new Set(tree.requests.map((r) => endpointKey(r.method, pathFromUrl(r.url))));

  const groupSize = new Map<string, number>();
  const methodsByPath = new Map<string, Set<HttpMethod>>();
  for (const r of routes) {
    const g = routeGroup(r.path);
    if (g) groupSize.set(g, (groupSize.get(g) ?? 0) + 1);
    const c = canonicalPath(r.path);
    methodsByPath.set(c, (methodsByPath.get(c) ?? new Set()).add(r.method));
  }

  // Where the user keeps each group today: the most common folder of its existing requests.
  const votes = new Map<string, Map<string, number>>();
  for (const r of tree.requests) {
    const g = r.folderId ? routeGroup(pathFromUrl(r.url)) : '';
    if (!g) continue;
    const v = votes.get(g) ?? new Map<string, number>();
    v.set(r.folderId, (v.get(r.folderId) ?? 0) + 1);
    votes.set(g, v);
  }
  const topFolders = tree.folders.filter((f) => !f.id.includes('/'));

  const groups = new Map<string, PlannedGroup>();
  let added = 0;
  for (const route of routes) {
    const key = endpointKey(route.method, route.path);
    if (knownSet.has(key) || taken.has(key)) continue;
    taken.add(key);

    const g = routeGroup(route.path);
    let folderId: string | null = '';
    let newFolder: string | undefined;
    if (g && (groupSize.get(g) ?? 0) >= MIN_GROUP_SIZE) {
      const voted = [...(votes.get(g) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      const lower = g.toLowerCase();
      const existing = topFolders.find((f) => f.id.toLowerCase() === lower || f.name.toLowerCase() === lower);
      if (voted) folderId = voted;
      else if (existing) folderId = existing.id;
      else {
        folderId = null;
        newFolder = g;
      }
    }

    let slug = requestSlug(route.path);
    if (route.method !== 'GET' && (methodsByPath.get(canonicalPath(route.path))?.size ?? 0) > 1) slug += `-${route.method.toLowerCase()}`;
    const body: BodyConfig = BODY_METHODS.has(route.method) ? { type: 'json', content: '{}' } : { type: 'none' };

    const groupKey = folderId === null ? `new:${newFolder}` : `id:${folderId}`;
    const group = groups.get(groupKey) ?? { folderId, newFolder, requests: [] };
    group.requests.push({
      key,
      slug,
      request: {
        name: slug,
        method: route.method,
        url: `{{baseUrl}}${route.path}`,
        params: [],
        headers: [],
        auth: { type: 'inherit' },
        body,
        docs: `Found in ${route.file}:${route.line} (${route.framework}).`,
      },
    });
    groups.set(groupKey, group);
    added++;
  }

  const allKeys = new Set([...known, ...routes.map((r) => endpointKey(r.method, r.path))]);
  return { groups: [...groups.values()], known: [...allKeys].sort(), added };
}
