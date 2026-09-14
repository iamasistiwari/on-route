// OWNER: agent "storage". Pure Node (fs/promises), NO `vscode` import, so it is unit-testable.
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  defaultProjectConfig,
  newRequest,
  type Environment,
  type FolderDef,
  type LoadError,
  type ProjectConfig,
  type ProjectTree,
  type RequestDef,
  type RequestSummary,
  type Variable,
} from '../../shared/model';
import {
  configFileSchema,
  configFromFile,
  environmentFileSchema,
  folderFileSchema,
  folderFromFile,
  localVariablesFileSchema,
  requestFileSchema,
  requestFromFile,
  scanStateFileSchema,
  serializeConfig,
  serializeEnvironment,
  serializeFolder,
  serializeRequest,
  serializeVariable,
  stripUndefined,
} from './schema';
import { atomicWrite, parseJson, parseYaml, pathExists, readText, stringifyYaml } from './yamlio';

export const ON_ROUTE_DIR = '.on_route';

export class StorageError extends Error {
  constructor(message: string, readonly file?: string, readonly line?: number) {
    super(message);
  }
}

const FOLDER_FILE = '_folder.yaml';
const CONFIG_FILE = 'on_route.json';
const SCAN_STATE_FILE = 'scan.json';
const LOCAL_VARIABLES_FILE = 'variables.local.yaml';
/** Heads the .gitignore lines On Route manages for environments that are not committed. */
export const GITIGNORE_ENV_COMMENT = '# Environments not committed (Overview > Environments > Commit to git)';
const GITIGNORE = '*.local.yaml\n.history/\n';

const toPosix = (p: string) => p.split(path.sep).join('/');
const parentOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
const joinId = (parent: string, slug: string) => (parent ? `${parent}/${slug}` : slug);

function assertId(id: string, kind: string, allowEmpty = false): void {
  if (typeof id !== 'string') throw new StorageError(`Invalid ${kind} id`);
  if (id === '') {
    if (allowEmpty) return;
    throw new StorageError(`Invalid ${kind} id: empty`);
  }
  if (id.includes('\\') || id.includes('\0') || id.startsWith('/') || path.isAbsolute(id) || /^[a-zA-Z]:/.test(id)) {
    throw new StorageError(`Invalid ${kind} id: ${id}`);
  }
  for (const seg of id.split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || seg.startsWith('.')) {
      throw new StorageError(`Invalid ${kind} id: ${id}`);
    }
  }
}

function assertRequestId(id: string): void {
  assertId(id, 'request');
  if (`${id.split('/').pop()}.yaml` === FOLDER_FILE) throw new StorageError(`Invalid request id: ${id}`);
}

function assertEnvName(name: string): void {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.') ||
    /[\\/\0]/.test(name) ||
    name.endsWith('.local')
  ) {
    throw new StorageError(`Invalid environment name: ${name}`);
  }
}

/**
 * Reads/writes the .on_route directory of one workspace folder.
 *
 * Layout:
 *   .on_route/on_route.json
 *   .on_route/.gitignore                      (written by init: "*.local.yaml\n.history/\n")
 *   .on_route/environments/<name>.yaml        { variables: Variable[] }
 *   .on_route/environments/<name>.local.yaml  { variables: Variable[] }  (gitignored)
 *   .on_route/requests/<folder...>/_folder.yaml
 *   .on_route/requests/<folder...>/<slug>.yaml
 *
 * YAML written with the `yaml` package, stable key order (name, method, url, params, headers, auth,
 * body, docs, order), empty arrays/defaults omitted, multi-line strings as block scalars (|).
 * Parsed files are validated with zod; missing optional fields filled with defaults.
 * All writes are atomic (write tmp file then rename).
 */
export class ProjectStore {
  constructor(readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ON_ROUTE_DIR);
  }

  private get requestsDir(): string {
    return path.join(this.dir, 'requests');
  }

  private get envDir(): string {
    return path.join(this.dir, 'environments');
  }

  private rel(abs: string): string {
    return toPosix(path.relative(this.workspaceRoot, abs));
  }

  private folderDir(id: string): string {
    assertId(id, 'folder', true);
    return id ? path.join(this.requestsDir, ...id.split('/')) : this.requestsDir;
  }

  private envPath(name: string, local = false): string {
    assertEnvName(name);
    return path.join(this.envDir, `${name}${local ? '.local' : ''}.yaml`);
  }

  async exists(): Promise<boolean> {
    try {
      return (await fs.stat(this.dir)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Create dir, on_route.json (defaultProjectConfig), .gitignore, environments/dev.yaml (empty vars), requests/. Idempotent. */
  async init(name: string): Promise<void> {
    await fs.mkdir(this.requestsDir, { recursive: true });
    await fs.mkdir(this.envDir, { recursive: true });
    const cfg = path.join(this.dir, CONFIG_FILE);
    if (!(await pathExists(cfg))) await this.writeConfig(defaultProjectConfig(name));
    const gi = path.join(this.dir, '.gitignore');
    const existing = await readText(gi);
    if (existing === undefined) {
      await atomicWrite(gi, GITIGNORE);
    } else {
      const lines = existing.split(/\r?\n/).map((l) => l.trim());
      const missing = GITIGNORE.trim().split('\n').filter((l) => !lines.includes(l));
      if (missing.length) {
        await atomicWrite(gi, `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${missing.join('\n')}\n`);
      }
    }
    const envFiles = (await fs.readdir(this.envDir)).filter((f) => f.endsWith('.yaml'));
    if (envFiles.length === 0) await this.writeEnvironment({ name: 'dev', variables: [] });
    await this.syncEnvironmentGitignore(await this.environmentCommitFlags());
  }

  private async environmentCommitFlags(): Promise<{ name: string; commit?: boolean }[]> {
    const out: { name: string; commit?: boolean }[] = [];
    for (const f of (await fs.readdir(this.envDir).catch(() => [] as string[])).sort()) {
      if (!f.endsWith('.yaml') || f.endsWith('.local.yaml') || f.startsWith('.')) continue;
      const r = parseYaml((await readText(path.join(this.envDir, f))) ?? '', environmentFileSchema);
      out.push({ name: f.slice(0, -'.yaml'.length), commit: r.ok ? r.data.commit : undefined });
    }
    return out;
  }

  /**
   * Lists `environments/<name>.yaml` in .on_route/.gitignore for every environment that is not committed and
   * removes the lines of committed ones. Returns whether the file changed.
   */
  async syncEnvironmentGitignore(envs: readonly { name: string; commit?: boolean }[]): Promise<boolean> {
    const file = path.join(this.dir, '.gitignore');
    const text = (await readText(file)) ?? GITIGNORE;
    const managed = (line: string) => line.trim() === GITIGNORE_ENV_COMMENT || /^environments\/[^/]+\.yaml$/.test(line.trim());
    const kept = text.split(/\r?\n/).filter((l) => !managed(l));
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    const ignored = envs.filter((e) => !e.commit).map((e) => `environments/${e.name}.yaml`).sort();
    const next = `${[...kept, ...(ignored.length ? [GITIGNORE_ENV_COMMENT, ...ignored] : [])].join('\n')}\n`;
    if (next === text) return false;
    await atomicWrite(file, next);
    return true;
  }

  get gitignorePath(): string {
    return path.join(this.dir, '.gitignore');
  }

  /** Load everything except full request bodies. Per-file errors go to tree.errors; never throws for bad files. */
  async load(): Promise<ProjectTree> {
    if (!(await this.exists())) throw new StorageError('On Route project not initialized', this.rel(this.dir));
    const errors: LoadError[] = [];
    const defaultName = path.basename(path.resolve(this.workspaceRoot));

    // Config
    let config = defaultProjectConfig(defaultName);
    const cfgPath = path.join(this.dir, CONFIG_FILE);
    const cfgText = await readText(cfgPath);
    if (cfgText === undefined) {
      errors.push({ file: this.rel(cfgPath), message: `${CONFIG_FILE} not found; using defaults` });
    } else {
      const r = parseJson(cfgText, configFileSchema);
      if (r.ok) config = configFromFile(defaultName, r.data);
      else errors.push(stripUndefined({ file: this.rel(cfgPath), message: r.message, line: r.line }));
    }
    const localVarsPath = path.join(this.dir, LOCAL_VARIABLES_FILE);
    const localVarsText = await readText(localVarsPath);
    if (localVarsText !== undefined) {
      const r = parseYaml(localVarsText, localVariablesFileSchema);
      if (r.ok) config = { ...config, variables: mergeLockedVariables(config.variables, r.data.variables) };
      else errors.push(stripUndefined({ file: this.rel(localVarsPath), message: r.message, line: r.line }));
    }

    // Requests + folders
    const folders: FolderDef[] = [];
    const requests: RequestSummary[] = [];
    const walk = async (dirAbs: string, folderId: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push({ file: this.rel(dirAbs), message: (e as Error).message });
        }
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const abs = path.join(dirAbs, ent.name);
        if (ent.isDirectory()) {
          const id = joinId(folderId, ent.name);
          const fPath = path.join(abs, FOLDER_FILE);
          const text = await readText(fPath).catch(() => undefined);
          let folder: FolderDef = folderFromFile(id, folderFileSchema.parse({}));
          if (text !== undefined) {
            const r = parseYaml(text, folderFileSchema);
            if (r.ok) folder = folderFromFile(id, r.data);
            else errors.push(stripUndefined({ file: this.rel(fPath), message: r.message, line: r.line }));
          }
          folders.push(folder);
          await walk(abs, id);
        } else if (ent.isFile() && ent.name.endsWith('.yaml') && ent.name !== FOLDER_FILE) {
          const id = joinId(folderId, ent.name.slice(0, -'.yaml'.length));
          try {
            const text = await fs.readFile(abs, 'utf8');
            const r = parseYaml(text, requestFileSchema);
            if (!r.ok) {
              errors.push(stripUndefined({ file: this.rel(abs), message: r.message, line: r.line }));
              continue;
            }
            const req = requestFromFile(id, r.data);
            requests.push(
              stripUndefined({ id, folderId, name: req.name, method: req.method, url: req.url, order: req.order }),
            );
          } catch (e) {
            errors.push({ file: this.rel(abs), message: (e as Error).message });
          }
        }
      }
    };
    await walk(this.requestsDir, '');

    // Environments
    const environments: Environment[] = [];
    let envEntries: string[] = [];
    try {
      envEntries = (await fs.readdir(this.envDir)).sort();
    } catch {
      /* no environments dir */
    }
    for (const f of envEntries) {
      if (!f.endsWith('.yaml') || f.endsWith('.local.yaml') || f.startsWith('.')) continue;
      const abs = path.join(this.envDir, f);
      try {
        const r = parseYaml(await fs.readFile(abs, 'utf8'), environmentFileSchema);
        if (r.ok) {
          environments.push(
            stripUndefined({ name: f.slice(0, -'.yaml'.length), variables: r.data.variables.map((v) => stripUndefined(v)), commit: r.data.commit }),
          );
        } else {
          errors.push(stripUndefined({ file: this.rel(abs), message: r.message, line: r.line }));
        }
      } catch (e) {
        errors.push({ file: this.rel(abs), message: (e as Error).message });
      }
    }

    return { config, folders, requests, environments, errors };
  }

  async readRequest(id: string): Promise<RequestDef> {
    const file = this.requestPath(id);
    const text = await readText(file);
    if (text === undefined) throw new StorageError(`Request not found: ${id}`, this.rel(file));
    const r = parseYaml(text, requestFileSchema);
    if (!r.ok) throw new StorageError(r.message, this.rel(file), r.line);
    return requestFromFile(id, r.data);
  }

  async writeRequest(req: RequestDef): Promise<void> {
    await atomicWrite(this.requestPath(req.id), stringifyYaml(serializeRequest(req)));
  }

  /**
   * Slugify name (or use `opts.slug` as given, e.g. case-preserving), pick unique id in folder, write file.
   * Fields in `init` override newRequest defaults.
   */
  async createRequest(
    folderId: string,
    name: string,
    init?: Partial<Omit<RequestDef, 'id'>>,
    opts?: { slug?: string },
  ): Promise<RequestDef> {
    const dirAbs = this.folderDir(folderId);
    const slug = await this.uniqueSlug(dirAbs, opts?.slug || slugify(name));
    const id = joinId(folderId, slug);
    const req: RequestDef = stripUndefined({ ...newRequest(id, name), ...stripUndefined(init ?? {}), id });
    if (init?.name === undefined) req.name = name;
    await this.writeRequest(req);
    return req;
  }

  /** Changes `name` field and renames the file to the new slug (unique). Returns updated request. */
  async renameRequest(id: string, newName: string): Promise<RequestDef> {
    const req = await this.readRequest(id);
    const folderId = parentOf(id);
    const oldSlug = id.split('/').pop()!;
    const base = slugify(newName);
    const slug = base === oldSlug ? oldSlug : await this.uniqueSlug(this.folderDir(folderId), base, oldSlug);
    const updated: RequestDef = { ...req, id: joinId(folderId, slug), name: newName };
    await this.writeRequest(updated);
    if (updated.id !== id) await fs.rm(this.requestPath(id), { force: true });
    return updated;
  }

  /**
   * Moves a request file into `targetFolderId` ("" = top level), keeping its slug when free (else -2, -3…).
   * No-op when already there. Creates the target directory if missing. Returns the request with its new id.
   */
  async moveRequest(id: string, targetFolderId: string): Promise<RequestDef> {
    const req = await this.readRequest(id);
    const targetAbs = this.folderDir(targetFolderId);
    if (parentOf(id) === targetFolderId) return req;
    const slug = id.split('/').pop()!;
    await fs.mkdir(targetAbs, { recursive: true });
    const newSlug = await this.uniqueSlug(targetAbs, slug);
    const newId = joinId(targetFolderId, newSlug);
    await fs.rename(this.requestPath(id), this.requestPath(newId));
    return { ...req, id: newId };
  }

  /** `name` defaults to "<name> copy". */
  async duplicateRequest(id: string, name?: string): Promise<RequestDef> {
    const { id: _old, ...rest } = await this.readRequest(id);
    name ??= `${rest.name} copy`;
    return this.createRequest(parentOf(id), name, { ...structuredClone(rest), name });
  }

  async deleteRequest(id: string): Promise<void> {
    const file = this.requestPath(id);
    try {
      await fs.unlink(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageError(`Request not found: ${id}`, this.rel(file));
      throw e;
    }
  }

  /** parentId "" = top level. Creates dir + _folder.yaml with name. `opts.slug` overrides the slugified name. */
  async createFolder(parentId: string, name: string, opts?: { slug?: string }): Promise<FolderDef> {
    const parentAbs = this.folderDir(parentId);
    const slug = await this.uniqueSlug(parentAbs, opts?.slug || slugify(name));
    const folder: FolderDef = { id: joinId(parentId, slug), name, auth: { type: 'inherit' }, variables: [] };
    await this.writeFolder(folder);
    return folder;
  }

  async writeFolder(folder: FolderDef): Promise<void> {
    assertId(folder.id, 'folder');
    await atomicWrite(path.join(this.folderDir(folder.id), FOLDER_FILE), stringifyYaml(serializeFolder(folder)));
  }

  private async readFolder(id: string): Promise<FolderDef> {
    assertId(id, 'folder');
    const dirAbs = this.folderDir(id);
    const st = await fs.stat(dirAbs).catch(() => undefined);
    if (!st?.isDirectory()) throw new StorageError(`Folder not found: ${id}`, this.rel(dirAbs));
    const fPath = path.join(dirAbs, FOLDER_FILE);
    const text = await readText(fPath);
    if (text === undefined) return folderFromFile(id, folderFileSchema.parse({}));
    const r = parseYaml(text, folderFileSchema);
    if (!r.ok) throw new StorageError(r.message, this.rel(fPath), r.line);
    return folderFromFile(id, r.data);
  }

  /** Updates _folder.yaml name and renames directory to new slug. */
  async renameFolder(id: string, newName: string): Promise<FolderDef> {
    const folder = await this.readFolder(id);
    const parentId = parentOf(id);
    const oldSlug = id.split('/').pop()!;
    const base = slugify(newName);
    const slug = base === oldSlug ? oldSlug : await this.uniqueSlug(this.folderDir(parentId), base, oldSlug);
    const newId = joinId(parentId, slug);
    if (newId !== id) await fs.rename(this.folderDir(id), this.folderDir(newId));
    const updated: FolderDef = { ...folder, id: newId, name: newName };
    await this.writeFolder(updated);
    return updated;
  }

  /**
   * Moves a folder directory under `targetParentId` ("" = top level). Rejects moving into itself or a
   * descendant. Keeps the slug when free (else -2, -3…). No-op when already there.
   */
  async moveFolder(id: string, targetParentId: string): Promise<FolderDef> {
    const folder = await this.readFolder(id);
    const targetAbs = this.folderDir(targetParentId);
    if (targetParentId === id || targetParentId.startsWith(`${id}/`)) {
      throw new StorageError(`Cannot move folder "${id}" into itself or one of its subfolders`);
    }
    if (parentOf(id) === targetParentId) return folder;
    await fs.mkdir(targetAbs, { recursive: true });
    const slug = await this.uniqueSlug(targetAbs, id.split('/').pop()!);
    const newId = joinId(targetParentId, slug);
    await fs.rename(this.folderDir(id), this.folderDir(newId));
    return { ...folder, id: newId };
  }

  /** Recursive delete. */
  async deleteFolder(id: string): Promise<void> {
    assertId(id, 'folder');
    await fs.rm(this.folderDir(id), { recursive: true, force: true });
  }

  /**
   * Unlocked variables go to on_route.json (committed); locked ones (`secret`) to variables.local.yaml
   * (gitignored), remembering their position so load() restores the original order.
   */
  async writeConfig(config: ProjectConfig): Promise<void> {
    const committed = config.variables.filter((v) => !v.secret);
    const locked = config.variables.map((v, position) => ({ v, position })).filter(({ v }) => v.secret);
    await atomicWrite(path.join(this.dir, CONFIG_FILE), JSON.stringify(serializeConfig({ ...config, variables: committed }), null, 2) + '\n');
    const localPath = path.join(this.dir, LOCAL_VARIABLES_FILE);
    if (locked.length) {
      await atomicWrite(localPath, stringifyYaml({ variables: locked.map(({ v, position }) => ({ ...serializeVariable(v), position })) }));
    } else {
      await fs.rm(localPath, { force: true });
    }
  }

  /** Writes environments/<name>.yaml. Secret variables are written with value "". */
  async writeEnvironment(env: Environment): Promise<void> {
    await atomicWrite(this.envPath(env.name), stringifyYaml(serializeEnvironment(env, true)));
  }

  async deleteEnvironment(name: string): Promise<void> {
    await fs.rm(this.envPath(name), { force: true });
  }

  /** environments/<name>.local.yaml; [] if missing. */
  async readLocalOverrides(envName: string): Promise<Variable[]> {
    const file = this.envPath(envName, true);
    const text = await readText(file);
    if (text === undefined) return [];
    const r = parseYaml(text, environmentFileSchema);
    if (!r.ok) throw new StorageError(r.message, this.rel(file), r.line);
    return r.data.variables.map((v) => stripUndefined(v));
  }

  async writeLocalOverrides(envName: string, vars: Variable[]): Promise<void> {
    await atomicWrite(this.envPath(envName, true), stringifyYaml(serializeEnvironment({ variables: vars }, false)));
  }

  /** Bulk write (used by Postman import). Existing files with same ids are overwritten. */
  async writeAll(data: {
    config?: ProjectConfig;
    folders: FolderDef[];
    requests: RequestDef[];
    environments: Environment[];
  }): Promise<void> {
    // Validate everything up front so a bad id doesn't leave a half-written import.
    for (const f of data.folders) assertId(f.id, 'folder');
    for (const r of data.requests) assertRequestId(r.id);
    for (const e of data.environments) assertEnvName(e.name);
    await fs.mkdir(this.requestsDir, { recursive: true });
    if (data.config) await this.writeConfig(data.config);
    const folders = [...data.folders].sort((a, b) => a.id.split('/').length - b.id.split('/').length);
    for (const f of folders) await this.writeFolder(f);
    for (const r of data.requests) await this.writeRequest(r);
    for (const e of data.environments) await this.writeEnvironment(e);
  }

  get configPath(): string {
    return path.join(this.dir, CONFIG_FILE);
  }

  get scanStatePath(): string {
    return path.join(this.dir, SCAN_STATE_FILE);
  }

  /** Endpoint keys handled by earlier scans; undefined when no scan ran yet (or the file is unreadable). */
  async readScanState(): Promise<{ known: string[] } | undefined> {
    const text = await readText(this.scanStatePath);
    if (text === undefined) return undefined;
    const r = parseJson(text, scanStateFileSchema);
    return r.ok ? { known: r.data.known } : undefined;
  }

  async writeScanState(state: { known: string[] }): Promise<void> {
    const known = [...new Set(state.known)].sort();
    await atomicWrite(this.scanStatePath, JSON.stringify({ version: 1, known }, null, 2) + '\n');
  }

  /** Absolute path of a request file (for "Reveal in explorer", file watcher matching). */
  requestPath(id: string): string {
    assertRequestId(id);
    return path.join(this.requestsDir, ...id.split('/')) + '.yaml';
  }

  /** Inverse of requestPath; undefined if path is not a request file. */
  requestIdFromPath(absPath: string): string | undefined {
    const rel = path.relative(this.requestsDir, path.resolve(absPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    if (!rel.endsWith('.yaml') || path.basename(rel) === FOLDER_FILE) return undefined;
    const id = toPosix(rel.slice(0, -'.yaml'.length));
    try {
      assertRequestId(id);
    } catch {
      return undefined;
    }
    return id;
  }

  /** Returns `base`, `base-2`, `base-3`, ... not taken by a file `<slug>.yaml` or directory `<slug>` in dirAbs. */
  private async uniqueSlug(dirAbs: string, base: string, exclude?: string): Promise<string> {
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      if (slug === exclude) return slug;
      const taken =
        (await pathExists(path.join(dirAbs, `${slug}.yaml`))) || (await pathExists(path.join(dirAbs, slug)));
      if (!taken) return slug;
    }
  }
}

/** Puts locked variables (from variables.local.yaml) back into the committed list at their saved positions. */
export function mergeLockedVariables(committed: Variable[], locked: (Variable & { position?: number })[]): Variable[] {
  const out = committed.map((v) => ({ ...v }));
  const sorted = [...locked].sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  for (const { position, ...rest } of sorted) {
    const v = stripUndefined({ ...rest, secret: true });
    const existing = out.findIndex((c) => c.key === v.key);
    if (existing >= 0) out[existing] = { ...out[existing], ...v };
    else out.splice(Math.min(position ?? out.length, out.length), 0, v);
  }
  return out;
}

/** "Get User by ID!" -> "get-user-by-id". Empty -> "untitled". */
export function slugify(name: string): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug || 'untitled';
}
