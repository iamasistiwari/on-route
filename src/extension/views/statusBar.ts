import * as vscode from 'vscode';
import type { ProjectService } from '../services/project';

export class EnvironmentStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('onRoute.environment', vscode.StatusBarAlignment.Left, 50);
  private readonly subs: vscode.Disposable[];

  constructor(private readonly service: ProjectService) {
    this.item.name = 'On Route Environment';
    this.item.command = 'onRoute.selectEnvironment';
    this.item.tooltip = 'On Route: select environment';
    this.subs = [service.onDidChangeTree(() => this.update()), service.onDidChangeEnvironment(() => this.update())];
    this.update();
  }

  update(): void {
    if (!this.service.initialized) {
      this.item.hide();
      return;
    }
    this.item.text = `$(globe) ${this.service.activeEnvironment ?? 'No Env'}`;
    this.item.show();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.item.dispose();
  }
}

type EnvPick = vscode.QuickPickItem & { action: 'env' | 'none' | 'manage'; env?: string };

export async function selectEnvironment(service: ProjectService): Promise<void> {
  const tree = service.tree;
  if (!tree) {
    void vscode.window.showWarningMessage('On Route is not initialized in this workspace.');
    return;
  }
  const active = service.activeEnvironment;
  const items: EnvPick[] = [
    ...tree.environments.map<EnvPick>((e) => ({
      label: `$(globe) ${e.name}`,
      description: e.name === active ? 'active' : undefined,
      action: 'env',
      env: e.name,
    })),
    { label: '$(circle-slash) No environment', description: active === null ? 'active' : undefined, action: 'none' },
    { label: '', kind: vscode.QuickPickItemKind.Separator, action: 'none' },
    { label: '$(gear) Manage environments…', action: 'manage' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select On Route environment' });
  if (!pick) return;
  if (pick.action === 'manage') {
    await vscode.commands.executeCommand('onRoute.openOverview');
  } else {
    await service.setActiveEnvironment(pick.action === 'env' ? pick.env! : null);
  }
}
