import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HttpMethod } from '../../shared/model';
import type { WebviewBootstrap } from '../../shared/protocol';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

export function methodIconUri(extensionUri: vscode.Uri, method: HttpMethod | string | undefined): vscode.Uri {
  const m = (method ?? 'GET').toLowerCase();
  return vscode.Uri.joinPath(extensionUri, 'media', 'methods', `${m}.svg`);
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bootstrap: WebviewBootstrap): string {
  const nonce = randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.css'));
  const csp = [
    `default-src 'none'`,
    // Binary responses are previewed from blob: URLs built in the webview (see ResponseView).
    `img-src ${webview.cspSource} data: blob: https:`,
    `media-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const boot = JSON.stringify({ ...bootstrap, isMac: process.platform === 'darwin' }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>On Route</title>
<link rel="stylesheet" href="${styleUri}">
<script nonce="${nonce}">window.__ON_ROUTE__ = ${boot};</script>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
