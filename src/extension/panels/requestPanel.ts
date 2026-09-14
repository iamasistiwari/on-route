import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { generators } from '../../shared/codegen';
import { parseCurl } from '../../shared/importers/curl';
import type { HistoryEntry, HttpErrorInfo, RequestDef } from '../../shared/model';
import type { ExtensionMessage, RequestUndoState, WebviewMessage, WsEvent } from '../../shared/protocol';
import { executeRequest, HttpExecuteError } from '../http/executor';
import { affectsUserSettings, errorMessage, RESPONSE_FONT_SIZE_KEY, type ProjectService } from '../services/project';
import { nameConflict } from '../services/treeUtils';
import { WsSession } from '../ws/wsClient';
import { getWebviewHtml, methodIconUri, webviewOptions } from './webviewHtml';

/** WebSocket log lines kept per editor, so the log survives hiding the tab (the webview is rebuilt). */
const WS_LOG_LIMIT = 2000;

export class RequestPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, RequestPanel>();
  private static activeId: string | null = null;
  private static readonly _onDidChangeActiveRequest = new vscode.EventEmitter<string | null>();
  /** Fires with the id of the request whose editor is active, or null. */
  static readonly onDidChangeActiveRequest = RequestPanel._onDidChangeActiveRequest.event;
  private static readonly _onDidChangeDirty = new vscode.EventEmitter<string[]>();
  /** Fires with all request ids whose open editors are dirty. */
  static readonly onDidChangeDirty = RequestPanel._onDidChangeDirty.event;

  /** Undo / redo history per request id, kept while VS Code runs so closing or switching tabs never loses it. */
  private static readonly undoStates = new Map<string, RequestUndoState>();

  /** Service used by static helpers that run before any editor is open (rekey, forget). */
  private static service: ProjectService | undefined;

  static attach(service: ProjectService): void {
    RequestPanel.service = service;
  }

  /** Drops kept undo history and saved layout of requests matching `pred` (e.g. deleted ones). */
  static forgetUndo(pred: (id: string) => boolean): void {
    for (const id of [...RequestPanel.undoStates.keys()]) if (pred(id)) RequestPanel.undoStates.delete(id);
    const service = RequestPanel.service;
    for (const id of service?.tree?.requests.map((r) => r.id) ?? []) {
      if (pred(id)) void service?.moveRequestLayout(id, undefined);
    }
  }

  /** Cmd/Ctrl+Enter from VS Code: send the request of the active editor. */
  static sendActive(): void {
    const p = RequestPanel.activeId ? RequestPanel.panels.get(RequestPanel.activeId) : undefined;
    p?.post({ type: 'sendShortcut' });
  }

  static get activeRequestId(): string | null {
    return RequestPanel.activeId;
  }

  static dirtyRequestIds(): string[] {
    return [...RequestPanel.panels].filter(([, p]) => p.dirty).map(([id]) => id);
  }

  private static setActive(id: string | null): void {
    if (RequestPanel.activeId === id) return;
    RequestPanel.activeId = id;
    RequestPanel._onDidChangeActiveRequest.fire(id);
  }

  private static fireDirty(): void {
    RequestPanel._onDidChangeDirty.fire(RequestPanel.dirtyRequestIds());
  }

  /** An open editor follows its file after rename / move. No-op when no editor is open for oldId. */
  static rekey(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const undo = RequestPanel.undoStates.get(oldId);
    if (undo) {
      RequestPanel.undoStates.delete(oldId);
      RequestPanel.undoStates.set(newId, undo);
    }
    void RequestPanel.service?.moveRequestLayout(oldId, newId);
    const p = RequestPanel.panels.get(oldId);
    if (!p) return;
    RequestPanel.panels.get(newId)?.dispose();
    RequestPanel.panels.delete(oldId);
    p.id = newId;
    RequestPanel.panels.set(newId, p);
    if (RequestPanel.activeId === oldId) RequestPanel.setActive(newId);
    if (p.dirty) RequestPanel.fireDirty();
    void p.afterRekey();
  }

  /** Open (or reveal) the editor for `id`. `historyId` selects that stored response once loaded. */
  static open(service: ProjectService, extensionUri: vscode.Uri, id: string, historyId?: string): RequestPanel {
    const existing = RequestPanel.panels.get(id);
    if (existing) {
      existing.panel.reveal();
      if (historyId) existing.post({ type: 'selectHistory', id: historyId });
      return existing;
    }
    RequestPanel.service ??= service;
    const p = new RequestPanel(service, extensionUri, id);
    p.pendingHistoryId = historyId;
    RequestPanel.panels.set(id, p);
    return p;
  }

  static isOpen(id: string): boolean {
    return RequestPanel.panels.has(id);
  }

  /** Close panels whose id matches. Returns closed ids. */
  static closeWhere(pred: (id: string) => boolean): string[] {
    const closed: string[] = [];
    for (const [id, p] of [...RequestPanel.panels]) {
      if (pred(id)) {
        closed.push(id);
        p.dispose();
      }
    }
    return closed;
  }

  static anyDirty(pred: (id: string) => boolean): boolean {
    return [...RequestPanel.panels].some(([id, p]) => pred(id) && p.dirty);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private dirty = false;
  private name: string;
  private abort: AbortController | undefined;
  private lastMissingWarning = '';
  private disposed = false;
  private pendingHistoryId: string | undefined;
  private suggestionTimer: NodeJS.Timeout | undefined;
  private readonly ws = new WsSession((events, status) => {
    this.wsLog.push(...events);
    if (this.wsLog.length > WS_LOG_LIMIT) this.wsLog.splice(0, this.wsLog.length - WS_LOG_LIMIT);
    this.post({ type: 'ws', status, events });
  });
  private wsLog: WsEvent[] = [];

  private constructor(
    private readonly service: ProjectService,
    private readonly extensionUri: vscode.Uri,
    public id: string,
  ) {
    const summary = service.tree?.requests.find((r) => r.id === id);
    this.name = summary?.name ?? id;
    this.panel = vscode.window.createWebviewPanel('onRoute.request', this.name, vscode.ViewColumn.Active, webviewOptions(extensionUri));
    this.panel.iconPath = methodIconUri(extensionUri, summary?.method);
    this.panel.webview.html = getWebviewHtml(this.panel.webview, extensionUri, { view: 'request' });

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) RequestPanel.setActive(this.id);
        else if (RequestPanel.activeId === this.id) RequestPanel.setActive(null);
      },
      undefined,
      this.disposables,
    );
    if (this.panel.active) RequestPanel.setActive(id);
    this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m), undefined, this.disposables);
    this.disposables.push(
      service.onDidChangeTree(() => {
        void this.postContext();
        this.scheduleSuggestions();
      }),
      service.onDidChangeEnvironment(() => void this.postContext()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`onRoute.${RESPONSE_FONT_SIZE_KEY}`) || affectsUserSettings(e)) void this.postContext();
      }),
      service.onDidChangeRequestFile((e) => {
        if (e.id === this.id) void this.onFileChanged(e.deleted);
      }),
    );
  }

  private post(msg: ExtensionMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  private updateTitle(): void {
    if (this.disposed) return;
    this.panel.title = `${this.dirty ? '● ' : ''}${this.name}`;
  }

  private get store() {
    const s = this.service.store;
    if (!s) throw new Error('No workspace folder open');
    return s;
  }

  private async currentRequest(): Promise<RequestDef> {
    return this.store.readRequest(this.id);
  }

  private async afterRekey(): Promise<void> {
    try {
      const req = await this.currentRequest();
      const renamed = req.name !== this.name;
      this.name = req.name;
      this.updateTitle();
      this.post({ type: 'history', history: await this.listHistory() });
      if (renamed) this.post({ type: 'requestChangedOnDisk', request: req });
    } catch (e) {
      this.service.log(`Failed to refresh editor after move of ${this.id}: ${errorMessage(e)}`);
    }
  }

  private async postContext(): Promise<void> {
    try {
      const req = await this.currentRequest();
      this.post({ type: 'requestContext', context: await this.service.requestContext(req) });
    } catch {
      // File may be gone; handled by file events.
    }
  }

  private scheduleSuggestions(): void {
    clearTimeout(this.suggestionTimer);
    this.suggestionTimer = setTimeout(() => void this.postSuggestions(), 300);
  }

  private async postSuggestions(): Promise<void> {
    try {
      this.post({ type: 'suggestions', data: await this.service.suggestionData() });
    } catch (e) {
      this.service.log(`Failed to collect suggestions: ${errorMessage(e)}`);
    }
  }

  private async onFileChanged(deleted: boolean): Promise<void> {
    if (deleted) {
      void vscode.window.showInformationMessage(`On Route: "${this.name}" was deleted on disk; editor closed.`);
      this.dispose();
      return;
    }
    try {
      const req = await this.currentRequest();
      this.post({ type: 'requestChangedOnDisk', request: req });
    } catch (e) {
      this.service.log(`Failed to reload ${this.id}: ${errorMessage(e)}`);
    }
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          const request = await this.currentRequest();
          this.name = request.name;
          this.panel.iconPath = methodIconUri(this.extensionUri, request.method);
          this.updateTitle();
          const [context, history] = await Promise.all([this.service.requestContext(request), this.listHistory()]);
          this.post({
            type: 'initRequest',
            request,
            context,
            history,
            selectedHistoryId: this.pendingHistoryId,
            undo: RequestPanel.undoStates.get(this.id),
            layout: this.service.requestLayout(this.id),
          });
          this.pendingHistoryId = undefined;
          if (this.wsLog.length || this.ws.status !== 'idle') this.post({ type: 'ws', status: this.ws.status, events: this.wsLog, reset: true });
          void this.postSuggestions();
          break;
        }
        case 'renameRequest': {
          const name = msg.name.trim();
          if (!name) break;
          const oldId = this.id;
          const conflict = nameConflict(this.service.tree, 'request', name, oldId);
          if (conflict) throw new Error(conflict);
          this.service.markSelfWrite(this.store.requestPath(oldId));
          const updated = await this.store.renameRequest(oldId, name);
          this.service.markSelfWrite(this.store.requestPath(updated.id));
          // Set before rekey so afterRekey does not report the rename as an external change.
          this.name = updated.name;
          if (updated.id !== oldId) {
            await this.service.history?.rename(oldId, updated.id).catch((e) => this.service.log(`history rename: ${errorMessage(e)}`));
            RequestPanel.rekey(oldId, updated.id);
          }
          this.updateTitle();
          this.post({ type: 'renamed', id: updated.id, name: updated.name });
          await this.service.reload();
          break;
        }
        case 'saveRequest': {
          // Position is set by drag & drop in the tree, never by the editor: keep what is on disk.
          const onDisk = await this.store.readRequest(this.id).catch(() => undefined);
          const request: RequestDef = { ...msg.request, id: this.id, order: onDisk?.order };
          this.service.markSelfWrite(this.store.requestPath(this.id));
          await this.store.writeRequest(request);
          this.name = request.name;
          if (this.dirty) {
            this.dirty = false;
            RequestPanel.fireDirty();
          }
          this.panel.iconPath = methodIconUri(this.extensionUri, request.method);
          this.updateTitle();
          this.post({ type: 'saved', request });
          void this.service.reload();
          break;
        }
        case 'sendRequest':
          await this.send({ ...msg.request, id: this.id });
          break;
        case 'cancelRequest':
          this.abort?.abort();
          break;
        case 'wsConnect': {
          const prepared = await this.service.prepare({ ...msg.request, id: this.id }, true);
          this.warnMissing(prepared.missing);
          const cfg = vscode.workspace.getConfiguration('onRoute');
          this.ws.connect(prepared.request, {
            timeoutMs: cfg.get<number>('timeoutMs', 0),
            rejectUnauthorized: cfg.get<boolean>('rejectUnauthorized', true),
          });
          break;
        }
        case 'wsSend': {
          // Resolve {{variables}} in the message the same way as a request body.
          const prepared = await this.service.prepare({ ...msg.request, id: this.id, body: { type: 'raw', content: msg.message } }, true);
          this.warnMissing(prepared.missing);
          const body = prepared.request.body;
          if (!this.ws.send(body.type === 'text' ? body.content : msg.message)) throw new Error('WebSocket is not connected');
          break;
        }
        case 'wsDisconnect':
          this.ws.close();
          break;
        case 'wsClearLog':
          this.wsLog = [];
          break;
        case 'undoState':
          RequestPanel.undoStates.set(this.id, msg.state);
          break;
        case 'setLayout':
          await this.service.setRequestLayout(this.id, msg.layout);
          break;
        case 'setDirty':
          if (this.dirty !== msg.dirty) {
            this.dirty = msg.dirty;
            RequestPanel.fireDirty();
          }
          this.updateTitle();
          break;
        case 'parseCurl': {
          const parsed = parseCurl(msg.text);
          this.post({ type: 'curlParsed', request: parsed });
          break;
        }
        case 'generateCode': {
          const prepared = await this.service.prepare({ ...msg.request, id: this.id }, msg.resolveVariables);
          this.post({ type: 'code', target: msg.target, code: generators[msg.target](prepared.request) });
          break;
        }
        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('$(check) Copied', 2000);
          break;
        case 'saveResponseBody':
          await saveResponseBody(msg.base64, msg.fileName);
          break;
        case 'focusFilter':
          await vscode.commands.executeCommand('onRoute.focusFilter');
          break;
        case 'setResponseFontSize':
          // Global so the choice sticks across workspaces; the config listener re-posts context to every panel.
          await vscode.workspace
            .getConfiguration('onRoute')
            .update(RESPONSE_FONT_SIZE_KEY, msg.size > 0 ? msg.size : undefined, vscode.ConfigurationTarget.Global);
          break;
        case 'setActiveEnvironment':
          await this.service.setActiveEnvironment(msg.name);
          break;
        case 'clearHistory':
          // Always the panel's current id: the webview may still hold a pre-move/rename id.
          await this.service.history?.clear(this.id);
          this.service.notifyHistoryChanged();
          this.post({ type: 'history', history: await this.listHistory() });
          break;
        case 'openRequest':
          await vscode.commands.executeCommand('onRoute.openRequest', msg.id);
          break;
        default:
          break;
      }
    } catch (e) {
      const message = errorMessage(e);
      this.service.log(`Request panel ${this.id} (${msg.type}) failed: ${message}`);
      this.post({ type: 'error', message });
    }
  }

  private async listHistory(): Promise<HistoryEntry[]> {
    try {
      return (await this.service.history?.list(this.id)) ?? [];
    } catch (e) {
      this.service.log(`Failed to read history for ${this.id}: ${errorMessage(e)}`);
      return [];
    }
  }

  /** Warns once per distinct set of unresolved variables. */
  private warnMissing(missing: string[]): void {
    if (!missing.length) {
      this.lastMissingWarning = '';
      return;
    }
    const key = [...missing].sort().join(', ');
    if (key === this.lastMissingWarning) return;
    this.lastMissingWarning = key;
    void vscode.window.showWarningMessage(`Unresolved variables: ${key}`);
  }

  private async send(request: RequestDef): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.post({ type: 'sending' });

    const cfg = vscode.workspace.getConfiguration('onRoute');
    const started = Date.now();
    const environment = this.service.activeEnvironment;
    let prepared;
    try {
      prepared = await this.service.prepare(request, true);
    } catch (e) {
      if (this.abort === abort) this.abort = undefined;
      throw e;
    }

    this.warnMissing(prepared.missing);

    const entry: HistoryEntry = {
      id: randomUUID(),
      requestId: this.id,
      timestamp: started,
      environment,
      request: prepared.request,
    };
    try {
      entry.response = await executeRequest(prepared.request, {
        timeoutMs: cfg.get<number>('timeoutMs', 0),
        rejectUnauthorized: cfg.get<boolean>('rejectUnauthorized', true),
        followRedirects: cfg.get<boolean>('followRedirects', true),
        signal: abort.signal,
        workspaceRoot: this.service.workspaceRoot ?? process.cwd(),
      });
    } catch (e) {
      const info: HttpErrorInfo =
        e instanceof HttpExecuteError ? e.info : { message: errorMessage(e), timing: { totalMs: Date.now() - started } };
      entry.error = info;
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }

    // Only real responses are history, including 4xx and 5xx. A transport failure (refused connection,
    // DNS, timeout, bad URL) never reached the server, so it is reported and then forgotten.
    if (entry.response) {
      try {
        await this.service.history?.add(entry);
        this.service.notifyHistoryChanged();
      } catch (e) {
        this.service.log(`Failed to save history for ${this.id}: ${errorMessage(e)}`);
      }
    }
    this.post({ type: 'response', entry });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.suggestionTimer);
    this.abort?.abort();
    this.ws.dispose();
    if (RequestPanel.panels.get(this.id) === this) RequestPanel.panels.delete(this.id);
    if (RequestPanel.activeId === this.id) RequestPanel.setActive(null);
    if (this.dirty) RequestPanel.fireDirty();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Ask where to put a binary response body, then write it there. */
async function saveResponseBody(base64: string, fileName: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    title: 'Save Response Body',
    defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : undefined,
    saveLabel: 'Save',
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
  const open = 'Open';
  const choice = await vscode.window.showInformationMessage(`Saved ${fileName}`, open);
  if (choice === open) await vscode.commands.executeCommand('vscode.open', target);
}
