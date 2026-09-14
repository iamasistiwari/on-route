// Resolution pipeline glue: ProjectTree + RequestDef -> variables/auth/ResolvedRequest.
// Pure: MUST NOT import `vscode` (unit-tested with vitest).
import { effectiveAuth, type AuthLayer } from '../../shared/auth';
import type { AuthConfig, FolderDef, ProjectTree, RequestDef, ResolvedRequest, Variable } from '../../shared/model';
import type { VariableInfo } from '../../shared/protocol';
import { isEnabled } from '../../shared/model';
import { buildVariableMap, resolveRequest, type VariableScope } from '../../shared/variables';

export interface Resolution {
  /** Flat variable map (empty when variables are not resolved). */
  vars: Record<string, string>;
  /** Scopes lowest precedence first. */
  scopes: VariableScope[];
  /** Effective auth for the request (inheritance resolved). */
  auth: AuthConfig;
  authSource: string;
  /** Effective auth of the parent chain (folders + project), ignoring the request's own auth. */
  inheritedAuth: AuthConfig;
  inheritedAuthSource: string;
  /** All variable keys visible to the request, sorted. */
  variableKeys: string[];
  /** Visible variables with their winning scope, sorted by key. Secret values are blanked. */
  variables: VariableInfo[];
}

/** Per-key view of the merged scopes (same precedence rules as buildVariableMap). */
export function describeVariables(scopes: VariableScope[], vars: Record<string, string>): VariableInfo[] {
  const map = new Map<string, VariableInfo>();
  for (const scope of scopes) {
    for (const v of scope.variables) {
      if (!v.key || !isEnabled(v)) continue;
      const prev = map.get(v.key);
      const secret = !!v.secret || !!prev?.secret;
      // An empty secret does not override a lower scope's value, only marks the key as secret.
      const source = v.secret && (v.value ?? '') === '' && prev ? prev.source : scope.name;
      map.set(v.key, { key: v.key, value: '', source, secret, resolved: false });
    }
  }
  const out = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const info of out) {
    info.resolved = Object.prototype.hasOwnProperty.call(vars, info.key);
    if (!info.secret) info.value = vars[info.key] ?? '';
  }
  return out;
}

/** "a/b/x" -> "a/b"; "x" -> "". */
export function parentId(id: string): string {
  const i = id.lastIndexOf('/');
  return i < 0 ? '' : id.slice(0, i);
}

/** Folder ids from outermost to innermost for a folder id: "a/b" -> ["a", "a/b"]. */
export function folderChainIds(folderId: string): string[] {
  if (!folderId) return [];
  const parts = folderId.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Folder chain (outer -> inner) for a request id. Folders without a FolderDef are synthesized. */
export function folderChain(tree: ProjectTree, requestId: string): FolderDef[] {
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  return folderChainIds(parentId(requestId)).map(
    (id) =>
      byId.get(id) ?? {
        id,
        name: id.slice(id.lastIndexOf('/') + 1),
        auth: { type: 'inherit' },
        variables: [],
      },
  );
}

export function buildResolution(
  tree: ProjectTree,
  request: RequestDef,
  activeEnv: string | null,
  localOverrides: Variable[],
): Resolution {
  const chain = folderChain(tree, request.id);
  const scopes: VariableScope[] = [{ name: 'project', variables: tree.config.variables ?? [] }];
  for (const f of chain) scopes.push({ name: `folder ${f.name}`, variables: f.variables ?? [] });
  const env = activeEnv ? tree.environments.find((e) => e.name === activeEnv) : undefined;
  if (env) {
    scopes.push({ name: `environment ${env.name}`, variables: env.variables ?? [] });
    scopes.push({ name: 'local', variables: localOverrides ?? [] });
  }

  const vars = buildVariableMap(scopes);

  const parentLayers: AuthLayer[] = [
    ...[...chain].reverse().map((f) => ({ source: `folder ${f.name}`, auth: f.auth })),
    { source: 'project', auth: tree.config.auth },
  ];
  const eff = effectiveAuth([{ source: 'request', auth: request.auth }, ...parentLayers]);
  const inherited = effectiveAuth(parentLayers);

  const keys = new Set<string>();
  for (const s of scopes) for (const v of s.variables) if (v.key && isEnabled(v)) keys.add(v.key);

  return {
    vars,
    scopes,
    auth: eff.auth,
    authSource: eff.source,
    inheritedAuth: inherited.auth,
    inheritedAuthSource: inherited.source,
    variableKeys: [...keys].sort(),
    variables: describeVariables(scopes, vars),
  };
}

export interface PreparedRequest {
  request: ResolvedRequest;
  missing: string[];
  resolution: Resolution;
}

/**
 * Full pipeline. With resolveVariables=false (code export with placeholders) the variable map is
 * empty so `{{placeholders}}` stay, but the auth structure is still applied.
 */
export function prepareRequest(
  tree: ProjectTree,
  request: RequestDef,
  activeEnv: string | null,
  localOverrides: Variable[],
  resolveVariables = true,
): PreparedRequest {
  const resolution = buildResolution(tree, request, activeEnv, localOverrides);
  const vars = resolveVariables ? resolution.vars : {};
  const { request: resolved, missing } = resolveRequest(request, {
    vars,
    auth: resolution.auth,
    dynamic: resolveVariables,
  });
  return { request: resolved, missing: resolveVariables ? missing : [], resolution };
}
