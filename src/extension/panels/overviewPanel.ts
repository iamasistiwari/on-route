import * as vscode from 'vscode';
import type { HistoryEntry, Variable } from '../../shared/model';
import { SIDEBAR_COMMANDS, type ExtensionMessage, type OverviewState, type WebviewMessage } from '../../shared/protocol';
import { affectsUserSettings, errorMessage, updateUserSettings, userSettings, type ProjectService } from '../services/project';
import { gitTrackedFiles, gitUntrack } from '../services/git';
import { nameConflict, uniqueName } from '../services/treeUtils';
import { ON_ROUTE_DIR } from '../storage/projectStore';
import { getWebviewHtml, webviewOptions } from './webviewHtml';

const ENV_NAME_RE = /^[\w.-]+$/;
/** Response bodies sent to the history page are capped; the request editor has the full body. */
const HISTORY_PREVIEW_CHARS = 64 * 1024;

function previewEntry(e: HistoryEntry): HistoryEntry {
  const res = e.response;
  if (!res || res.body.length <= HISTORY_PREVIEW_CHARS) return e;
  const body = res.bodyEncoding === 'base64' ? '' : res.body.slice(0, HISTORY_PREVIEW_CHARS);
  return { ...e, response: { ...res, body, truncated: true } };
}

/** Saved overview state, with `page` taking precedence when the overview is opened on a page. */
function overviewUiState(saved: unknown, page: string | undefined): unknown {
  if (!page) return saved;
  return { ...(saved && typeof saved === 'object' ? saved : {}), page };
}

export class OverviewPanel implements vscode.Disposable {
  private static current: OverviewPanel | undefined;

  /** `page` opens that page (e.g. "settings"). */
  static open(service: ProjectService, extensionUri: vscode.Uri, page?: string): OverviewPanel {
    if (OverviewPanel.current) {
      OverviewPanel.current.panel.reveal();
      if (page) OverviewPanel.current.post({ type: 'showPage', page });
      return OverviewPanel.current;
    }
    OverviewPanel.current = new OverviewPanel(service, extensionUri, page);
    return OverviewPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly service: ProjectService,
    extensionUri: vscode.Uri,
    page?: string,
  ) {
    this.panel = vscode.window.createWebviewPanel('onRoute.overview', 'On Route Overview', vscode.ViewColumn.Active, webviewOptions(extensionUri));
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = getWebviewHtml(this.panel.webview, extensionUri, { view: 'overview', uiState: overviewUiState(service.uiState('overview'), page) });
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m), undefined, this.disposables);
    this.disposables.push(
      service.onDidChangeTree(() => void this.postState()),
      service.onDidChangeEnvironment(() => void this.postState()),
      service.onDidChangeHistory(() => void this.postHistory()),
      service.scanner.onDidChangeStatus(() => void this.postState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsUserSettings(e)) void this.postState();
      }),
    );
  }

  private async postHistory(): Promise<void> {
    try {
      const [entries, bytes] = await Promise.all([this.service.history?.listAll() ?? [], this.service.history?.diskBytes() ?? 0]);
      this.post({ type: 'allHistory', entries: entries.map(previewEntry), bytes });
    } catch (e) {
      this.service.log(`Failed to read history: ${errorMessage(e)}`);
    }
  }

  private post(msg: ExtensionMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  private get store() {
    const s = this.service.store;
    if (!s) throw new Error('No workspace folder open');
    return s;
  }

  private async postState(): Promise<void> {
    const tree = this.service.tree;
    if (!tree) return;
    const localOverrides: Record<string, Variable[]> = {};
    await Promise.all(
      tree.environments.map(async (e) => {
        localOverrides[e.name] = await this.service.localOverrides(e.name);
      }),
    );
    const envFile = (name: string) => `${ON_ROUTE_DIR}/environments/${name}.yaml`;
    const root = this.service.workspaceRoot;
    const tracked = root ? await gitTrackedFiles(root, tree.environments.map((e) => envFile(e.name))) : new Set<string>();
    const trackedEnvironments = tree.environments.filter((e) => tracked.has(envFile(e.name))).map((e) => e.name);
    const state: OverviewState = {
      trackedEnvironments, tree, activeEnvironment: this.service.activeEnvironment, localOverrides, scan: this.service.scanner.status, settings: userSettings() };
    this.post({ type: 'overview', state });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'persistUiState':
          await this.service.setUiState('overview', msg.state);
          break;
        case 'ready':
          if (!this.service.tree) await this.service.reload();
          await this.postState();
          break;
        case 'openRequest':
          await vscode.commands.executeCommand('onRoute.openRequest', msg.id, msg.historyId);
          break;
        case 'runCommand':
          if (SIDEBAR_COMMANDS.includes(msg.command)) await vscode.commands.executeCommand(`onRoute.${msg.command}`, msg.item);
          break;
        case 'listAllHistory':
          await this.postHistory();
          break;
        case 'focusFilter':
          await vscode.commands.executeCommand('onRoute.focusFilter');
          break;
        case 'clearAllHistory': {
          const ok = await vscode.window.showWarningMessage(
            'Clear all history?',
            { modal: true, detail: 'Stored responses for every request in this workspace will be removed.' },
            'Clear',
          );
          if (ok !== 'Clear') return;
          await this.service.history?.clearAll();
          this.service.notifyHistoryChanged();
          break;
        }
        case 'newRequest': {
          const name = (
            await vscode.window.showInputBox({
              prompt: 'Request name',
              value: uniqueName(this.service.tree, 'request', 'New Request'),
              validateInput: (text) => nameConflict(this.service.tree, 'request', text),
            })
          )?.trim();
          if (!name) return;
          const conflict = nameConflict(this.service.tree, 'request', name);
          if (conflict) throw new Error(conflict);
          const req = await this.store.createRequest(msg.folderId, name);
          await this.service.reload();
          await vscode.commands.executeCommand('onRoute.openRequest', req.id);
          break;
        }
        case 'setActiveEnvironment':
          await this.service.setActiveEnvironment(msg.name);
          break;
        case 'updateSettings':
          await updateUserSettings(msg.settings);
          break;
        case 'saveConfig':
          await this.store.writeConfig(msg.config);
          await this.service.reload();
          break;
        case 'saveFolder':
          await this.store.writeFolder(msg.folder);
          await this.service.reload();
          break;
        case 'saveEnvironment':
          await this.store.writeEnvironment(msg.environment);
          await this.store.writeLocalOverrides(msg.environment.name, msg.localOverrides);
          await this.service.reload();
          await this.postState(); // local overrides may change without a tree change
          break;
        case 'createEnvironment': {
          const name = msg.name.trim();
          if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid environment name "${name}". Use letters, digits, "_", "." or "-".`);
          if (this.service.tree?.environments.some((e) => e.name === name)) throw new Error(`Environment "${name}" already exists.`);
          await this.store.writeEnvironment({ name, variables: [] });
          await this.service.reload();
          break;
        }
        case 'untrackEnvironment': {
          const root = this.service.workspaceRoot;
          if (!root || !ENV_NAME_RE.test(msg.name)) return;
          const file = `${ON_ROUTE_DIR}/environments/${msg.name}.yaml`;
          const ok = await vscode.window.showWarningMessage(
            `Stop tracking ${file} in git?`,
            { modal: true, detail: 'Runs "git rm --cached". The file stays on disk; your next commit removes it from the repository.' },
            'Stop tracking',
          );
          if (ok !== 'Stop tracking') return;
          await gitUntrack(root, file);
          await this.postState();
          break;
        }
        case 'deleteEnvironment': {
          const ok = await vscode.window.showWarningMessage(
            `Delete environment "${msg.name}"?`,
            { modal: true, detail: 'The environment file and its local overrides will be removed.' },
            'Delete',
          );
          if (ok !== 'Delete') return;
          await this.store.deleteEnvironment(msg.name);
          if (this.service.activeEnvironment === msg.name) await this.service.setActiveEnvironment(null);
          await this.service.reload();
          break;
        }
        default:
          break;
      }
    } catch (e) {
      const message = errorMessage(e);
      this.service.log(`Overview (${msg.type}) failed: ${message}`);
      this.post({ type: 'error', message });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (OverviewPanel.current === this) OverviewPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
