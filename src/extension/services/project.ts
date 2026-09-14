// Central extension state: workspace folder, stores, cached tree, active environment, file watching.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProjectTree, RequestDef, Variable } from '../../shared/model';
import {
  DEFAULT_COLLAPSE_STRINGS_OVER,
  type RequestContext,
  type RequestLayout,
  type SuggestionData,
  type SuggestionRequest,
  type UserSettings,
} from '../../shared/protocol';
import { SHORTCUT_ACTIONS, normalizeCombo, normalizeShortcuts, type Shortcuts } from '../../shared/shortcuts';
import { HistoryStore } from '../history/historyStore';
import { ON_ROUTE_DIR, ProjectStore } from '../storage/projectStore';
import { buildResolution, prepareRequest, type PreparedRequest } from './resolve';
import { ScanService } from './scanService';

const ACTIVE_ENV_KEY = 'onRoute.activeEnvironment';
const REQUEST_LAYOUTS_KEY = 'onRoute.requestLayouts';
const UI_STATE_KEY = 'onRoute.uiState';
/** Longest tab id accepted in a saved layout. */
const MAX_TAB_ID = 20;
const DEBOUNCE_MS = 150;
const SELF_WRITE_WINDOW_MS = 1000;
const SUGGESTION_REQUEST_LIMIT = 1000;
const SUGGESTION_BODY_MAX_CHARS = 20_000;

export interface RequestFileEvent {
  id: string;
  deleted: boolean;
}

export class ProjectService implements vscode.Disposable {
  readonly folder: vscode.WorkspaceFolder | undefined;
  readonly store: ProjectStore | undefined;
  readonly history: HistoryStore | undefined;
  /** Endpoint scanning (manual, on init, periodic). */
  readonly scanner: ScanService;

  private _tree: ProjectTree | undefined;
  private _initialized = false;
  private _activeEnv: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly selfWrites = new Map<string, number>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private pendingFiles = new Set<string>();
  private reloading: Promise<void> | undefined;
  private reloadAgain = false;
  private suggestions: Promise<SuggestionData> | undefined;

  private readonly _onDidChangeTree = new vscode.EventEmitter<ProjectTree | undefined>();
  readonly onDidChangeTree = this._onDidChangeTree.event;
  private readonly _onDidChangeEnvironment = new vscode.EventEmitter<string | null>();
  readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;
  private readonly _onDidChangeRequestFile = new vscode.EventEmitter<RequestFileEvent>();
  readonly onDidChangeRequestFile = this._onDidChangeRequestFile.event;
  private readonly _onDidChangeHistory = new vscode.EventEmitter<void>();
  /** Fires after responses are recorded or history is cleared. */
  readonly onDidChangeHistory = this._onDidChangeHistory.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly output: vscode.OutputChannel,
  ) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.folder =
      folders.find((f) => f.uri.scheme === 'file' && fs.existsSync(path.join(f.uri.fsPath, ON_ROUTE_DIR))) ?? folders[0];

    this.disposables.push(this._onDidChangeTree, this._onDidChangeEnvironment, this._onDidChangeRequestFile, this._onDidChangeHistory);

    if (this.folder) {
      const root = this.folder.uri.fsPath;
      this.store = new ProjectStore(root);
      this.history = new HistoryStore(path.join(root, ON_ROUTE_DIR), this.historyLimit());

      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.folder, `{${ON_ROUTE_DIR},${ON_ROUTE_DIR}/**}`),
      );
      watcher.onDidCreate((u) => this.onFsEvent(u), undefined, this.disposables);
      watcher.onDidChange((u) => this.onFsEvent(u), undefined, this.disposables);
      watcher.onDidDelete((u) => this.onFsEvent(u), undefined, this.disposables);
      this.disposables.push(watcher);

      this.disposables.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('onRoute.historyLimit') && this.history) this.history.limit = this.historyLimit();
        }),
      );
    }
    this._activeEnv = context.workspaceState.get<string | null>(ACTIVE_ENV_KEY, null) ?? null;
    this.scanner = new ScanService(this);
    this.disposables.push(this.scanner);
  }

  get tree(): ProjectTree | undefined {
    return this._tree;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get workspaceRoot(): string | undefined {
    return this.folder?.uri.fsPath;
  }

  get activeEnvironment(): string | null {
    return this._activeEnv;
  }

  private historyLimit(): number {
    const n = vscode.workspace.getConfiguration('onRoute').get<number>('historyLimit', 20);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
  }

  notifyHistoryChanged(): void {
    this._onDidChangeHistory.fire();
  }

  log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  /** Reload the tree from disk. Concurrent calls coalesce. */
  reload(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      do {
        this.reloadAgain = false;
        await this.doReload();
      } while (this.reloadAgain);
    })().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  private async doReload(): Promise<void> {
    let tree: ProjectTree | undefined;
    let initialized = false;
    if (this.store) {
      try {
        initialized = await this.store.exists();
        if (initialized) tree = await this.store.load();
      } catch (e) {
        this.log(`Failed to load project: ${errorMessage(e)}`);
        tree = undefined;
      }
    }
    this._tree = tree;
    this.suggestions = undefined;
    this._initialized = initialized && !!tree;
    await vscode.commands.executeCommand('setContext', 'onRoute.initialized', this._initialized);

    // Validate active environment.
    const envs = tree?.environments.map((e) => e.name) ?? [];
    let env = this._activeEnv;
    if (tree) {
      if (env !== null && !envs.includes(env)) {
        env = envs[0] ?? null;
      } else if (env === null && this.context.workspaceState.get<string | null>(ACTIVE_ENV_KEY) === undefined) {
        // Never chosen: default to first env. An explicit "No environment" (stored null) is respected.
        env = envs[0] ?? null;
      }
    }
    this._onDidChangeTree.fire(tree);
    if (tree && env !== this._activeEnv) await this.setActiveEnvironment(env);
    if (tree && this.store) {
      this.markSelfWrite(this.store.gitignorePath);
      await this.store.syncEnvironmentGitignore(tree.environments).catch((e) => this.log(`Failed to update .gitignore: ${errorMessage(e)}`));
    }
  }

  async setActiveEnvironment(name: string | null): Promise<void> {
    if (name !== null && this._tree && !this._tree.environments.some((e) => e.name === name)) {
      throw new Error(`Environment "${name}" does not exist`);
    }
    const changed = name !== this._activeEnv;
    this._activeEnv = name;
    await this.context.workspaceState.update(ACTIVE_ENV_KEY, name);
    if (changed) this._onDidChangeEnvironment.fire(name);
  }

  async localOverrides(envName: string | null): Promise<Variable[]> {
    if (!envName || !this.store) return [];
    try {
      return await this.store.readLocalOverrides(envName);
    } catch (e) {
      this.log(`Failed to read local overrides for ${envName}: ${errorMessage(e)}`);
      return [];
    }
  }

  /** Pane split saved for a request (workspace storage, kept across restarts). */
  requestLayout(id: string): RequestLayout | undefined {
    return this.context.workspaceState.get<Record<string, RequestLayout>>(REQUEST_LAYOUTS_KEY, {})[id];
  }

  async setRequestLayout(id: string, layout: RequestLayout | undefined): Promise<void> {
    const all = { ...this.context.workspaceState.get<Record<string, RequestLayout>>(REQUEST_LAYOUTS_KEY, {}) };
    const tabId = (t: unknown) => (typeof t === 'string' && t.length > 0 && t.length <= MAX_TAB_ID ? t : undefined);
    if (layout) {
      all[id] = stripUndefinedKeys({
        ratio: Math.min(1, Math.max(0, layout.ratio)),
        requestHidden: layout.requestHidden ? true : undefined,
        tab: tabId(layout.tab),
        responseTab: tabId(layout.responseTab),
      });
    }
    else delete all[id];
    await this.context.workspaceState.update(REQUEST_LAYOUTS_KEY, all);
  }

  /** Saved view state of the sidebar or overview webview (per workspace). */
  uiState(view: 'sidebar' | 'overview'): unknown {
    return this.context.workspaceState.get<Record<string, unknown>>(UI_STATE_KEY, {})[view];
  }

  async setUiState(view: 'sidebar' | 'overview', state: unknown): Promise<void> {
    const all = { ...this.context.workspaceState.get<Record<string, unknown>>(UI_STATE_KEY, {}), [view]: state };
    await this.context.workspaceState.update(UI_STATE_KEY, all);
  }

  /** A request's saved layout follows it on rename / move; `to` undefined forgets it. */
  async moveRequestLayout(from: string, to: string | undefined): Promise<void> {
    const layout = this.requestLayout(from);
    if (!layout || from === to) return;
    await this.setRequestLayout(from, undefined);
    if (to) await this.setRequestLayout(to, layout);
  }

  async requestContext(request: RequestDef): Promise<RequestContext> {
    const tree = this._tree;
    const envs = tree?.environments.map((e) => e.name) ?? [];
    const responseFontSize = responseFontSizeSetting();
    if (!tree) {
      return {
        activeEnvironment: this._activeEnv,
        environments: envs,
        variableKeys: [],
        variables: [],
        responseFontSize,
        inheritedAuth: { type: 'none' },
        inheritedAuthSource: 'none',
        settings: userSettings(),
      };
    }
    const local = await this.localOverrides(this._activeEnv);
    const r = buildResolution(tree, request, this._activeEnv, local);
    return {
      activeEnvironment: this._activeEnv,
      environments: envs,
      variableKeys: r.variableKeys,
      variables: r.variables,
      responseFontSize,
      inheritedAuth: r.inheritedAuth,
      inheritedAuthSource: r.inheritedAuthSource,
      settings: userSettings(),
    };
  }

  /** URLs, params and bodies of every request, for editor suggestions. Cached until the next reload. */
  suggestionData(): Promise<SuggestionData> {
    this.suggestions ??= this.buildSuggestions();
    return this.suggestions;
  }

  private async buildSuggestions(): Promise<SuggestionData> {
    const tree = this._tree;
    const store = this.store;
    if (!tree || !store) return { requests: [] };
    const summaries = tree.requests.slice(0, SUGGESTION_REQUEST_LIMIT);
    const requests: SuggestionRequest[] = [];
    for (let i = 0; i < summaries.length; i += 32) {
      await Promise.all(
        summaries.slice(i, i + 32).map(async (s) => {
          try {
            const r = await store.readRequest(s.id);
            const body = (r.body.type === 'json' || r.body.type === 'raw') && r.body.content.length <= SUGGESTION_BODY_MAX_CHARS ? r.body : undefined;
            requests.push({
              id: r.id,
              folderId: s.folderId,
              name: r.name,
              method: r.method,
              url: r.url,
              paramKeys: r.params.map((p) => p.key).filter(Boolean),
              body: body && { type: body.type, content: body.content },
            });
          } catch {
            // Unreadable request files are reported elsewhere.
          }
        }),
      );
    }
    return { requests };
  }

  /** Resolve a request against the active environment. */
  async prepare(request: RequestDef, resolveVariables = true): Promise<PreparedRequest> {
    const tree = this._tree ?? (await this.loadTreeOrThrow());
    const local = await this.localOverrides(this._activeEnv);
    return prepareRequest(tree, request, this._activeEnv, local, resolveVariables);
  }

  private async loadTreeOrThrow(): Promise<ProjectTree> {
    await this.reload();
    if (!this._tree) throw new Error('On Route project is not initialized');
    return this._tree;
  }

  /** Record that the extension is about to write `absPath` so the watcher echo is ignored. */
  markSelfWrite(...absPaths: string[]): void {
    const now = Date.now();
    for (const p of absPaths) this.selfWrites.set(normalize(p), now);
  }

  private isSelfWrite(absPath: string): boolean {
    const key = normalize(absPath);
    const t = this.selfWrites.get(key);
    if (t === undefined) return false;
    if (Date.now() - t <= SELF_WRITE_WINDOW_MS) return true;
    this.selfWrites.delete(key);
    return false;
  }

  private onFsEvent(uri: vscode.Uri): void {
    const p = uri.fsPath;
    const rel = this.workspaceRoot ? path.relative(this.workspaceRoot, p).split(path.sep).join('/') : '';
    if (rel.startsWith(`${ON_ROUTE_DIR}/.history`)) return;
    if (this.isSelfWrite(p)) return;
    this.pendingFiles.add(p);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.debounceTimer = undefined;
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();
    await this.reload();
    if (!this.store) return;
    const ids = new Set<string>();
    for (const f of files) {
      let id: string | undefined;
      try {
        id = this.store.requestIdFromPath(f);
      } catch {
        id = undefined;
      }
      if (id) ids.add(id);
    }
    for (const id of ids) {
      let deleted = false;
      try {
        deleted = !fs.existsSync(this.store.requestPath(id));
      } catch {
        deleted = false;
      }
      this._onDidChangeRequestFile.fire({ id, deleted });
    }
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const d of this.disposables) d.dispose();
  }
}

function normalize(p: string): string {
  return path.resolve(p);
}

export const RESPONSE_FONT_SIZE_KEY = 'responseFontSize';

/** `onRoute.responseFontSize` clamped to a sane range; 0 = follow the editor font size. */
export function responseFontSizeSetting(): number {
  const n = vscode.workspace.getConfiguration('onRoute').get<number>(RESPONSE_FONT_SIZE_KEY, 0);
  return Number.isFinite(n) && n > 0 ? Math.min(32, Math.max(8, Math.round(n))) : 0;
}

const USER_SETTING_KEYS = [
  'autoSave',
  'autoSaveIntervalSeconds',
  'collapseLongStrings',
  'collapseStringsOver',
  'shortcuts',
] as const satisfies readonly (keyof UserSettings)[];

/** `onRoute.*` preferences; the auto save interval is 0 (immediately) or clamped to 5 s – 1 h. */
export function userSettings(): UserSettings {
  const cfg = vscode.workspace.getConfiguration('onRoute');
  const n = cfg.get<number>('autoSaveIntervalSeconds', 10);
  const over = cfg.get<number>('collapseStringsOver', DEFAULT_COLLAPSE_STRINGS_OVER);
  return {
    autoSave: cfg.get<boolean>('autoSave', false) === true,
    autoSaveIntervalSeconds: !Number.isFinite(n) ? 10 : n <= 0 ? 0 : Math.min(3600, Math.max(5, Math.round(n))),
    collapseLongStrings: cfg.get<boolean>('collapseLongStrings', true) !== false,
    collapseStringsOver: Number.isFinite(over) && over >= 1 ? Math.min(100_000, Math.round(over)) : DEFAULT_COLLAPSE_STRINGS_OVER,
    shortcuts: normalizeShortcuts(cfg.get('shortcuts')),
  };
}

export function affectsUserSettings(e: vscode.ConfigurationChangeEvent): boolean {
  return USER_SETTING_KEYS.some((k) => e.affectsConfiguration(`onRoute.${k}`));
}

/** Writes preferences to user (global) settings, so they apply in every workspace. */
export async function updateUserSettings(patch: Partial<UserSettings>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('onRoute');
  for (const key of USER_SETTING_KEYS) {
    let value: unknown = patch[key];
    if (value === undefined) continue;
    if (key === 'shortcuts') {
      // Only customized entries are written, so changed defaults reach users who never touched them.
      const custom = Object.fromEntries(
        SHORTCUT_ACTIONS.flatMap((a) => {
          const combo = normalizeCombo((value as Shortcuts)[a.id] ?? '');
          return combo && combo !== a.default ? [[a.id, combo]] : [];
        }),
      );
      value = Object.keys(custom).length ? custom : undefined;
    }
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Context keys `onRoute.customShortcut.<action>`: VS Code's own keybindings for the default combos are
 * turned off for actions the user changed (the webviews handle custom combos).
 */
export async function syncShortcutContexts(): Promise<void> {
  const shortcuts = userSettings().shortcuts;
  await Promise.all(
    SHORTCUT_ACTIONS.map((a) => vscode.commands.executeCommand('setContext', `onRoute.customShortcut.${a.id}`, shortcuts[a.id] !== a.default)),
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stripUndefinedKeys<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
