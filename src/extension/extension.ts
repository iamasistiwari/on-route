import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { RequestPanel } from './panels/requestPanel';
import { ProjectService, syncShortcutContexts } from './services/project';
import { ProjectDiagnostics } from './views/diagnostics';
import { SidebarViewProvider } from './views/sidebarView';
import { EnvironmentStatusBar } from './views/statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('On Route');
  context.subscriptions.push(output);

  const service = new ProjectService(context, output);
  context.subscriptions.push(service);

  context.subscriptions.push(SidebarViewProvider.register(service, context.extensionUri));
  context.subscriptions.push(new EnvironmentStatusBar(service));
  context.subscriptions.push(new ProjectDiagnostics(service));

  registerCommands(context, service);
  RequestPanel.attach(service);
  void syncShortcutContexts();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('onRoute.shortcuts')) void syncShortcutContexts();
    }),
  );

  if (!service.folder) {
    await vscode.commands.executeCommand('setContext', 'onRoute.initialized', false);
    return;
  }
  void service.reload();
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}
