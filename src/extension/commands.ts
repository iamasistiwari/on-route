import * as path from 'node:path';
import * as vscode from 'vscode';
import { generators } from '../shared/codegen';
import { isCurlCommand, parseCurl } from '../shared/importers/curl';
import { importPostman } from '../shared/importers/postman';
import type { CodeTarget, SidebarItemRef } from '../shared/protocol';
import type { ProjectConfig } from '../shared/model';
import { OverviewPanel } from './panels/overviewPanel';
import { RequestPanel } from './panels/requestPanel';
import { errorMessage, type ProjectService } from './services/project';
import { scanSummary } from './services/scanService';
import { scanSettings } from '../shared/scan';
import { allFolders, nameConflict, uniqueName } from './services/treeUtils';
import { selectEnvironment } from './views/statusBar';

export function registerCommands(context: vscode.ExtensionContext, service: ProjectService): void {
  const uri = context.extensionUri;
  const output = service.output;

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (e) {
          const msg = errorMessage(e);
          service.log(`${id} failed: ${msg}`);
          void vscode.window.showErrorMessage(`On Route: ${msg}`);
        }
      }),
    );

  const requireStore = () => {
    if (!service.store) {
      void vscode.window.showWarningMessage('On Route: Open a folder first.');
      return undefined;
    }
    return service.store;
  };

  const requireProject = () => {
    const store = requireStore();
    if (!store) return undefined;
    if (!service.initialized) {
      void vscode.window
        .showWarningMessage('On Route is not initialized in this workspace.', 'Initialize')
        .then((c) => c && vscode.commands.executeCommand('onRoute.init'));
      return undefined;
    }
    return store;
  };

  const openRequest = (id: string, historyId?: string) => RequestPanel.open(service, uri, id, historyId);

  const pickFolder = async (placeHolder: string): Promise<string | undefined> => {
    const folders = service.tree ? allFolders(service.tree).sort((a, b) => a.id.localeCompare(b.id)) : [];
    if (!folders.length) return '';
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(root-folder) Top level', id: '' },
        ...folders.map((f) => ({ label: `$(folder) ${f.name}`, description: f.id, id: f.id })),
      ],
      { placeHolder },
    );
    return pick?.id;
  };

  const pickRequest = async (): Promise<string | undefined> => {
    const reqs = service.tree?.requests ?? [];
    if (!reqs.length) {
      void vscode.window.showInformationMessage('On Route: no requests yet.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      reqs.map((r) => ({ label: r.name, description: `${r.method} ${r.url}`, detail: r.id, id: r.id })),
      { placeHolder: 'Select a request', matchOnDescription: true, matchOnDetail: true },
    );
    return pick?.id;
  };

  /**
   * Normalizes command args: a plain request id string, or a SidebarItemRef-like object `{ kind, id }`
   * (native webview/context menus pass the element's data-vscode-context, with extra keys).
   */
  const itemRef = (arg: unknown): ItemRef | undefined => {
    if (typeof arg === 'string') return arg ? { kind: 'request', id: arg } : undefined;
    if (!arg || typeof arg !== 'object') return undefined;
    const { kind, id } = arg as { kind?: unknown; id?: unknown };
    if ((kind === 'folder' || kind === 'request') && typeof id === 'string') return { kind, id };
    return undefined;
  };

  const nodeRequestId = (arg: unknown): string | undefined => {
    const ref = itemRef(arg);
    return ref?.kind === 'request' ? ref.id : undefined;
  };

  const folderIdOf = (arg: unknown): string => {
    const ref = itemRef(arg);
    return ref?.kind === 'folder' ? ref.id : '';
  };

  const folderName = (id: string): string =>
    (service.tree ? allFolders(service.tree).find((f) => f.id === id)?.name : undefined) ?? id.slice(id.lastIndexOf('/') + 1);

  const requestName = async (id: string): Promise<string> => {
    const summary = service.tree?.requests.find((r) => r.id === id);
    if (summary) return summary.name;
    return (await service.store?.readRequest(id))?.name ?? id;
  };

  /** Asks for a request / folder name that no other one in the project uses. Undefined when cancelled or empty. */
  const askName = async (kind: 'request' | 'folder', prompt: string, value: string, excludeId?: string): Promise<string | undefined> => {
    const name = await vscode.window.showInputBox({
      prompt,
      value,
      validateInput: (text) => nameConflict(service.tree, kind, text, excludeId),
    });
    const trimmed = name?.trim();
    if (!trimmed) return undefined;
    // The tree may have changed while the box was open.
    const conflict = nameConflict(service.tree, kind, trimmed, excludeId);
    if (conflict) throw new Error(conflict);
    return trimmed;
  };

  reg('onRoute.init', async () => {
    const store = requireStore();
    if (!store) return;
    if (!service.initialized) {
      const name = await vscode.window.showInputBox({
        prompt: 'Project name',
        value: service.folder?.name ?? 'My API',
      });
      if (name === undefined) return;
      await store.init(name.trim() || service.folder?.name || 'My API');
      await service.reload();
      if (service.tree && scanSettings(service.tree.config).enabled) {
        void service.scanner.scan('init').then((run) => {
          if (run?.added || run?.error) void vscode.window.showInformationMessage(scanSummary(run));
        });
      }
    }
    OverviewPanel.open(service, uri);
  });

  reg('onRoute.scanProject', async () => {
    if (!requireProject()) return;
    const run = await service.scanner.scan('manual');
    if (!run) return;
    if (run.error) throw new Error(`Scan failed: ${run.error}`);
    void vscode.window.showInformationMessage(scanSummary(run));
  });

  reg('onRoute.openOverview', (page?: unknown) => {
    if (!requireProject()) return;
    OverviewPanel.open(service, uri, typeof page === 'string' ? page : undefined);
  });

  reg('onRoute.openRequest', async (arg?: unknown, historyId?: unknown) => {
    if (!requireProject()) return;
    const id = nodeRequestId(arg) ?? (await pickRequest());
    if (id) openRequest(id, typeof historyId === 'string' ? historyId : undefined);
  });

  reg('onRoute.newRequest', async (arg?: unknown) => {
    const store = requireProject();
    if (!store) return;
    const folderId = folderIdOf(arg);
    const name = await askName('request', 'Request name', uniqueName(service.tree, 'request', 'New Request'));
    if (!name) return;
    const req = await store.createRequest(folderId, name);
    await service.reload();
    openRequest(req.id);
  });

  reg('onRoute.newFolder', async (arg?: unknown) => {
    const store = requireProject();
    if (!store) return;
    const parentId = folderIdOf(arg);
    const name = await askName('folder', 'Folder name', uniqueName(service.tree, 'folder', 'New Folder'));
    if (!name) return;
    await store.createFolder(parentId, name);
    await service.reload();
  });

  reg('onRoute.renameItem', async (arg?: unknown) => {
    const store = requireProject();
    const ref = itemRef(arg);
    if (!store || !ref) return;
    const renameHistory = (from: string, to: string) =>
      service.history?.rename(from, to).catch((e) => service.log(`history rename: ${errorMessage(e)}`));
    if (ref.kind === 'request') {
      const oldId = ref.id;
      const oldName = await requestName(oldId);
      const name = await askName('request', 'New request name', oldName, oldId);
      if (!name || name === oldName) return;
      service.markSelfWrite(store.requestPath(oldId));
      const updated = await store.renameRequest(oldId, name);
      service.markSelfWrite(store.requestPath(updated.id));
      if (updated.id !== oldId) {
        await renameHistory(oldId, updated.id);
        RequestPanel.rekey(oldId, updated.id);
      }
      await service.reload();
    } else {
      const oldId = ref.id;
      const oldName = folderName(oldId);
      const name = await askName('folder', 'New folder name', oldName, oldId);
      if (!name || name === oldName) return;
      const affected = (service.tree?.requests ?? []).filter((r) => r.id.startsWith(`${oldId}/`)).map((r) => r.id);
      const updated = await store.renameFolder(oldId, name);
      if (updated.id !== oldId) {
        for (const id of affected) {
          const newId = updated.id + id.slice(oldId.length);
          service.markSelfWrite(store.requestPath(newId));
          await renameHistory(id, newId);
          RequestPanel.rekey(id, newId);
        }
      }
      await service.reload();
    }
  });

  reg('onRoute.deleteItem', async (arg?: unknown) => {
    const store = requireProject();
    const ref = itemRef(arg);
    if (!store || !ref) return;
    if (ref.kind === 'request') {
      const ok = await vscode.window.showWarningMessage(`Delete request "${await requestName(ref.id)}"?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      const id = ref.id;
      RequestPanel.closeWhere((x) => x === id);
      RequestPanel.forgetUndo((x) => x === id);
      await store.deleteRequest(id);
      await service.history?.clear(id).catch(() => undefined);
      service.notifyHistoryChanged();
    } else {
      const ok = await vscode.window.showWarningMessage(
        `Delete folder "${folderName(ref.id)}" and everything in it?`,
        { modal: true },
        'Delete',
      );
      if (ok !== 'Delete') return;
      const fid = ref.id;
      RequestPanel.closeWhere((x) => x.startsWith(`${fid}/`));
      RequestPanel.forgetUndo((x) => x.startsWith(`${fid}/`));
      await store.deleteFolder(fid);
    }
    await service.reload();
  });

  reg('onRoute.duplicateRequest', async (node?: unknown) => {
    const store = requireProject();
    if (!store) return;
    const id = nodeRequestId(node) ?? (await pickRequest());
    if (!id) return;
    const copy = await store.duplicateRequest(id, uniqueName(service.tree, 'request', `${await requestName(id)} copy`));
    await service.reload();
    openRequest(copy.id);
  });

  reg('onRoute.importCurl', async () => {
    const store = requireProject();
    if (!store) return;
    let text = (await vscode.env.clipboard.readText()).trim();
    if (!isCurlCommand(text)) {
      const input = await vscode.window.showInputBox({ prompt: 'Paste a cURL command', placeHolder: "curl 'https://api.example.com' -H '...'" });
      if (!input?.trim()) return;
      text = input.trim();
    }
    const parsed = parseCurl(text);
    const suggested = `${parsed.method} ${shortUrlPath(parsed.url)}`;
    const name = await askName('request', 'Request name', uniqueName(service.tree, 'request', parsed.name || suggested));
    if (!name) return;
    const folderId = await pickFolder('Save imported request in…');
    if (folderId === undefined) return;
    const { name: _ignored, ...fields } = parsed;
    const req = await store.createRequest(folderId, name, fields);
    await service.reload();
    openRequest(req.id);
  });

  reg('onRoute.importPostman', async () => {
    const store = requireStore();
    if (!store) return;
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { 'Postman JSON': ['json'] },
      openLabel: 'Import',
      title: 'Select a Postman collection (and optional environment exports)',
    });
    if (!files?.length) return;

    const collections: unknown[] = [];
    const environments: unknown[] = [];
    for (const f of files) {
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(f));
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch (e) {
        throw new Error(`${path.basename(f.fsPath)} is not valid JSON: ${errorMessage(e)}`);
      }
      if (json && typeof json === 'object' && json.info && Array.isArray(json.item)) collections.push(json);
      else if (json && typeof json === 'object' && Array.isArray(json.values)) environments.push(json);
      else throw new Error(`${path.basename(f.fsPath)} is neither a Postman collection nor an environment export.`);
    }
    if (collections.length !== 1) {
      throw new Error(collections.length ? 'Select exactly one Postman collection.' : 'No Postman collection selected.');
    }

    const result = importPostman(collections[0], environments);
    const wasInitialized = service.initialized;
    if (wasInitialized) {
      const ok = await vscode.window.showWarningMessage(
        'Merge into existing .on_route?',
        { modal: true, detail: 'Requests, folders and environments with the same ids will be overwritten.' },
        'Merge',
      );
      if (ok !== 'Merge') return;
    } else {
      await store.init(result.config.name || service.folder?.name || 'Imported');
    }

    let config: ProjectConfig | undefined = result.config;
    if (wasInitialized) {
      const existing = service.tree?.config;
      if (existing) {
        const keys = new Set(existing.variables.map((v) => v.key));
        const extra = result.config.variables.filter((v) => !keys.has(v.key));
        config = extra.length ? { ...existing, variables: [...existing.variables, ...extra] } : undefined;
      } else {
        config = undefined;
      }
    }
    // Secret values would be blanked in the committed env file; keep them in <env>.local.yaml.
    for (const env of result.environments) {
      const secrets = env.variables.filter((v) => v.secret && (v.value ?? '') !== '');
      if (!secrets.length) continue;
      const existing = await service.localOverrides(env.name);
      const merged = [...existing];
      for (const s of secrets) {
        const override = { key: s.key, value: s.value, secret: true };
        const i = merged.findIndex((v) => v.key === s.key);
        if (i >= 0) merged[i] = { ...merged[i], ...override };
        else merged.push(override);
      }
      await store.writeLocalOverrides(env.name, merged);
    }
    await store.writeAll({ config, folders: result.folders, requests: result.requests, environments: result.environments });
    await service.reload();

    const summary = `Imported ${result.requests.length} request(s), ${result.folders.length} folder(s), ${result.environments.length} environment(s).`;
    if (result.warnings.length) {
      output.appendLine(`Postman import warnings (${result.warnings.length}):`);
      for (const w of result.warnings) output.appendLine(`  - ${w}`);
      const choice = await vscode.window.showInformationMessage(`${summary} ${result.warnings.length} warning(s).`, 'Show warnings');
      if (choice) output.show(true);
    } else {
      void vscode.window.showInformationMessage(summary);
    }
  });

  const copyAs = (target: CodeTarget, label: string) => async (node?: unknown) => {
    const store = requireProject();
    if (!store) return;
    const id = nodeRequestId(node) ?? (await pickRequest());
    if (!id) return;
    const req = await store.readRequest(id);
    const prepared = await service.prepare(req, true);
    await vscode.env.clipboard.writeText(generators[target](prepared.request));
    void vscode.window.showInformationMessage(`Copied "${req.name}" as ${label}.`);
  };
  reg('onRoute.copyAsCurl', copyAs('curl', 'cURL'));
  reg('onRoute.copyAsAxios', copyAs('axios', 'axios'));

  reg('onRoute.selectEnvironment', async () => {
    if (!requireProject()) return;
    await selectEnvironment(service);
  });

  reg('onRoute.sendRequest', () => RequestPanel.sendActive());

  reg('onRoute.refresh', async () => {
    if (!requireStore()) return;
    await service.reload();
  });
}

type ItemRef = SidebarItemRef;

function shortUrlPath(url: string): string {
  const p = url.replace(/^\{\{[^{}]+\}\}/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  return p || '/';
}
