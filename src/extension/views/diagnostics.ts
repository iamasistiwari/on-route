import * as vscode from 'vscode';
import type { ProjectService } from '../services/project';

export class ProjectDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('onRoute');
  private readonly sub: vscode.Disposable;

  constructor(private readonly service: ProjectService) {
    this.sub = service.onDidChangeTree(() => this.update());
    this.update();
  }

  update(): void {
    this.collection.clear();
    const tree = this.service.tree;
    const folder = this.service.folder;
    if (!tree || !folder) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const err of tree.errors) {
      const line = Math.max(0, (err.line ?? 1) - 1);
      const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), err.message, vscode.DiagnosticSeverity.Error);
      d.source = 'On Route';
      const list = byFile.get(err.file) ?? [];
      list.push(d);
      byFile.set(err.file, list);
    }
    for (const [file, diags] of byFile) {
      this.collection.set(vscode.Uri.joinPath(folder.uri, ...file.split(/[\\/]/)), diags);
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.collection.dispose();
  }
}
