// Sidebar (`onRoute.explorer`) as a WebviewView rendering the React endpoints tree.
import * as vscode from 'vscode';
import { orderUpdates } from '../../shared/order';
import { SIDEBAR_COMMANDS, type ExtensionMessage, type SidebarItemRef, type SidebarState, type WebviewMessage } from '../../shared/protocol';
import { getWebviewHtml, webviewOptions } from '../panels/webviewHtml';
import { RequestPanel } from '../panels/requestPanel';
import { affectsUserSettings, errorMessage, userSettings, type ProjectService } from '../services/project';
import { parentId } from '../services/resolve';

export const SIDEBAR_VIEW_ID = 'onRoute.explorer';

/**
 * Move a request or folder into `targetFolderId` ("" = top level), keeping history and open editors
 * attached to the moved files. Moving a folder into itself / a descendant is silently ignored. With `before`
 * (a sibling id, or null for the end) the item is also positioned among its new siblings.
 */
export async function moveItem(service: ProjectService, item: SidebarItemRef, targetFolderId: string, before?: string | null): Promise<void> {
  const store = service.store;
  if (!store) throw new Error('No workspace folder open');
  const renameHistory = (from: string, to: string) =>
    service.history?.rename(from, to).catch((e) => service.log(`history rename: ${errorMessage(e)}`));

  let newId: string;
  if (item.kind === 'request') {
    const oldId = item.id;
    service.markSelfWrite(store.requestPath(oldId));
    const moved = await store.moveRequest(oldId, targetFolderId);
    newId = moved.id;
    if (moved.id !== oldId) {
      service.markSelfWrite(store.requestPath(moved.id));
      await renameHistory(oldId, moved.id);
      RequestPanel.rekey(oldId, moved.id);
    }
  } else {
    const oldId = item.id;
    if (targetFolderId === oldId || targetFolderId.startsWith(`${oldId}/`)) return;
    const affected = (service.tree?.requests ?? []).filter((r) => r.id.startsWith(`${oldId}/`)).map((r) => r.id);
    service.markSelfWrite(...affected.map((id) => store.requestPath(id)));
    const moved = await store.moveFolder(oldId, targetFolderId);
    newId = moved.id;
    if (moved.id !== oldId) {
      for (const id of affected) {
        const movedId = moved.id + id.slice(oldId.length);
        service.markSelfWrite(store.requestPath(movedId));
        await renameHistory(id, movedId);
        RequestPanel.rekey(id, movedId);
      }
    }
  }
  await service.reload();
  if (before !== undefined) await applyOrder(service, item.kind, targetFolderId, newId, before);
}

/** Rewrites `order` of the target folder's requests (or subfolders) so `id` sits in front of `before`. */
async function applyOrder(service: ProjectService, kind: SidebarItemRef['kind'], folderId: string, id: string, before: string | null): Promise<void> {
  const store = service.store;
  const tree = service.tree;
  if (!store || !tree) return;
  if (kind === 'request') {
    const updates = orderUpdates(tree.requests.filter((r) => r.folderId === folderId), id, before);
    for (const u of updates) {
      const req = await store.readRequest(u.id);
      service.markSelfWrite(store.requestPath(u.id));
      await store.writeRequest({ ...req, order: u.order });
    }
    if (updates.length) await service.reload();
  } else {
    const siblings = tree.folders.filter((f) => parentId(f.id) === folderId);
    const updates = orderUpdates(siblings, id, before);
    const defs = new Map(siblings.map((f) => [f.id, f]));
    for (const u of updates) {
      const def = defs.get(u.id);
      if (def) await store.writeFolder({ ...def, order: u.order });
    }
    if (updates.length) await service.reload();
  }
}

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];
  /** The current view's webview has posted 'ready'. */
  private ready = false;
  private pendingFocusFilter = false;

  constructor(
    private readonly service: ProjectService,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      service.onDidChangeTree(() => this.postState()),
      RequestPanel.onDidChangeActiveRequest(() => this.postState()),
      RequestPanel.onDidChangeDirty(() => this.postState()),
      service.scanner.onDidChangeStatus(() => this.postState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsUserSettings(e)) this.postState();
      }),
    );
  }

  static register(service: ProjectService, extensionUri: vscode.Uri): vscode.Disposable {
    const provider = new SidebarViewProvider(service, extensionUri);
    const reg = vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    });
    const focusFilter = vscode.commands.registerCommand('onRoute.focusFilter', () => provider.focusFilter());
    return vscode.Disposable.from(reg, focusFilter, provider);
  }

  /** Reveal the view and put the cursor in its filter box. */
  async focusFilter(): Promise<void> {
    // `.focus` reveals the container and moves keyboard focus into the webview even when an editor
    // (e.g. a request panel) currently has it; view.show() alone may leave focus in the editor.
    await vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`);
    // A view that was never shown resolves (and loads its webview) only now: focus once it is ready.
    if (this.view && this.ready) this.post({ type: 'focusFilter' });
    else this.pendingFocusFilter = true;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
    this.view = webviewView;
    this.ready = false;
    const { enableScripts, localResourceRoots } = webviewOptions(this.extensionUri);
    webviewView.webview.options = { enableScripts, localResourceRoots };
    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri, { view: 'sidebar', uiState: this.service.uiState('sidebar') });
    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m)),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) this.view = undefined;
        for (const d of this.viewDisposables) d.dispose();
        this.viewDisposables = [];
      }),
    );
  }

  private state(): SidebarState {
    return {
      initialized: this.service.initialized,
      tree: this.service.tree ?? null,
      activeRequestId: RequestPanel.activeRequestId,
      dirtyRequestIds: RequestPanel.dirtyRequestIds(),
      hasWorkspace: !!this.service.folder,
      scanning: this.service.scanner.status.running,
      settings: userSettings(),
    };
  }

  private post(msg: ExtensionMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  private postState(): void {
    if (this.view) this.post({ type: 'sidebar', state: this.state() });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'persistUiState':
          await this.service.setUiState('sidebar', msg.state);
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('onRoute.openOverview', 'settings');
          break;
        case 'ready':
          this.ready = true;
          this.postState();
          if (this.pendingFocusFilter) {
            this.pendingFocusFilter = false;
            this.post({ type: 'focusFilter' });
          }
          break;
        case 'openRequest':
          await vscode.commands.executeCommand('onRoute.openRequest', msg.id);
          break;
        case 'newRequest':
          await vscode.commands.executeCommand('onRoute.newRequest', { kind: 'folder', id: msg.folderId } satisfies SidebarItemRef);
          break;
        case 'runCommand':
          if (!SIDEBAR_COMMANDS.includes(msg.command)) return;
          await vscode.commands.executeCommand(`onRoute.${msg.command}`, msg.item);
          break;
        case 'moveItem':
          await moveItem(this.service, msg.item, msg.targetFolderId, msg.before);
          break;
        default:
          break;
      }
    } catch (e) {
      const message = errorMessage(e);
      this.service.log(`Sidebar (${msg.type}) failed: ${message}`);
      void vscode.window.showErrorMessage(`On Route: ${message}`);
      // Re-sync the UI in case it applied an optimistic change.
      this.postState();
    }
  }

  dispose(): void {
    for (const d of this.viewDisposables) d.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
