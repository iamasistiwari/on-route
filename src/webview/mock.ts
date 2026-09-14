// Mock VS Code API for previewing the webview in a plain browser (vite dev server).
// Usage: http://localhost:5199/?view=overview|sidebar|request  (&theme=light) (sidebar: &empty=workspace|init|requests)
import type { HistoryEntry, ProjectTree, RequestDef, Variable } from '../shared/model';
import {
  DEFAULT_USER_SETTINGS,
  type ExtensionMessage,
  type OverviewState,
  type RequestContext,
  type SidebarState,
  type SuggestionRequest,
  type WebviewMessage,
} from '../shared/protocol';
import { parseCurl } from '../shared/importers/curl';
import { generators } from '../shared/codegen';

const DARK: Record<string, string> = {
  'editor-background': '#1f1f1f',
  'editor-foreground': '#cccccc',
  foreground: '#cccccc',
  descriptionForeground: '#9d9d9d',
  'input-background': '#313131',
  'input-foreground': '#cccccc',
  'input-border': '#3c3c3c',
  'input-placeholderForeground': '#8b8b8b',
  focusBorder: '#0078d4',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#026ec1',
  'button-secondaryBackground': '#313131',
  'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c',
  'panel-border': '#2b2b2b',
  'badge-background': '#616161',
  'badge-foreground': '#f8f8f8',
  errorForeground: '#f85149',
  'testing-iconPassed': '#73c991',
  'charts-green': '#89d185',
  'charts-yellow': '#cca700',
  'charts-blue': '#3794ff',
  'charts-purple': '#b180d7',
  'charts-red': '#f14c4c',
  'charts-orange': '#d18616',
  'list-hoverBackground': '#2a2d2e',
  'list-activeSelectionBackground': '#04395e',
  'list-activeSelectionForeground': '#ffffff',
  'toolbar-hoverBackground': 'rgba(90,93,94,0.31)',
  'textLink-foreground': '#4daafc',
  'editor-selectionBackground': '#264f78',
  'editor-lineHighlightBackground': 'rgba(255,255,255,0.04)',
  'editorLineNumber-foreground': '#6e7681',
  'sideBar-background': '#181818',
  'editorWidget-background': '#202020',
  'widget-shadow': 'rgba(0,0,0,0.36)',
  'editorWarning-foreground': '#cca700',
  'inputValidation-warningBackground': '#352a05',
  'inputValidation-warningBorder': '#b89500',
  'textCodeBlock-background': '#2b2b2b',
  'dropdown-background': '#313131',
  'dropdown-border': '#3c3c3c',
  'dropdown-foreground': '#cccccc',
  'debugTokenExpression-string': '#ce9178',
  'debugTokenExpression-number': '#b5cea8',
  'debugTokenExpression-boolean': '#4e94ce',
  'debugTokenExpression-name': '#9cdcfe',
  'scrollbarSlider-background': 'rgba(121,121,121,0.4)',
  'panelTitle-activeBorder': '#0078d4',
  'panelTitle-activeForeground': '#e7e7e7',
  'panelTitle-inactiveForeground': '#9d9d9d',
  'sideBar-foreground': '#cccccc',
  'list-inactiveSelectionBackground': '#37373d',
  'list-dropBackground': 'rgba(56,56,62,0.9)',
  'list-focusOutline': '#0078d4',
  'tree-indentGuidesStroke': '#585858',
  'sideBarSectionHeader-background': '#181818',
  'sideBarSectionHeader-foreground': '#cccccc',
  'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  'font-size': '13px',
  'editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
  'editor-font-size': '12px',
};

const LIGHT: Record<string, string> = {
  ...DARK,
  'editor-background': '#ffffff',
  'editor-foreground': '#3b3b3b',
  foreground: '#3b3b3b',
  descriptionForeground: '#717171',
  'input-background': '#ffffff',
  'input-foreground': '#3b3b3b',
  'input-border': '#cecece',
  'input-placeholderForeground': '#767676',
  'button-secondaryBackground': '#e5e5e5',
  'button-secondaryForeground': '#3b3b3b',
  'button-secondaryHoverBackground': '#cccccc',
  'panel-border': '#e5e5e5',
  errorForeground: '#e51400',
  'testing-iconPassed': '#388a34',
  'charts-green': '#388a34',
  'charts-yellow': '#bf8803',
  'charts-blue': '#1a85ff',
  'charts-purple': '#652d90',
  'charts-red': '#e51400',
  'list-hoverBackground': '#f2f2f2',
  'list-activeSelectionForeground': '#000000',
  'toolbar-hoverBackground': 'rgba(184,184,184,0.31)',
  'textLink-foreground': '#005fb8',
  'editor-selectionBackground': '#add6ff',
  'editor-lineHighlightBackground': 'rgba(0,0,0,0.03)',
  'sideBar-background': '#f8f8f8',
  'editorWidget-background': '#f8f8f8',
  'inputValidation-warningBackground': '#f6f5d2',
  'textCodeBlock-background': '#f2f2f2',
  'dropdown-background': '#ffffff',
  'dropdown-border': '#cecece',
  'dropdown-foreground': '#3b3b3b',
  'debugTokenExpression-string': '#a31515',
  'debugTokenExpression-number': '#098658',
  'debugTokenExpression-boolean': '#0000ff',
  'debugTokenExpression-name': '#0451a5',
  'panelTitle-activeForeground': '#3b3b3b',
  'panelTitle-inactiveForeground': '#717171',
  'sideBar-foreground': '#3b3b3b',
  'list-activeSelectionBackground': '#e4e6f1',
  'list-inactiveSelectionBackground': '#e4e6f1',
  'list-dropBackground': '#d6ebff',
  'list-focusOutline': '#005fb8',
  'tree-indentGuidesStroke': '#a9a9a9',
  'sideBarSectionHeader-background': '#f8f8f8',
  'sideBarSectionHeader-foreground': '#3b3b3b',
};

function applyTheme(light: boolean) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(light ? LIGHT : DARK)) root.style.setProperty(`--vscode-${k}`, v);
  document.body.classList.add(light ? 'vscode-light' : 'vscode-dark');
}

const config = {
  version: 1 as const,
  name: 'Acme API',
  auth: { type: 'bearer' as const, token: '{{token}}' },
  variables: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'apiVersion', value: 'v2', description: 'Path prefix' },
    { key: 'token', value: '', secret: true },
  ] as Variable[],
};

const tree: ProjectTree = {
  config,
  folders: [
    { id: 'users', name: 'users', auth: { type: 'inherit' }, variables: [] },
    { id: 'users/admin', name: 'admin', auth: { type: 'basic', username: 'admin', password: '{{adminPass}}' }, variables: [{ key: 'role', value: 'admin' }] },
    { id: 'auth', name: 'auth', auth: { type: 'none' }, variables: [] },
  ],
  requests: [
    { id: 'health', folderId: '', name: 'Health check', method: 'GET', url: '{{baseUrl}}/health' },
    { id: 'users/list-users', folderId: 'users', name: 'List users', method: 'GET', url: '{{baseUrl}}/{{apiVersion}}/users' },
    { id: 'users/get-user', folderId: 'users', name: 'Get user', method: 'GET', url: '{{baseUrl}}/{{apiVersion}}/users/{{userId}}' },
    { id: 'users/create-user', folderId: 'users', name: 'Create user', method: 'POST', url: '{{baseUrl}}/{{apiVersion}}/users' },
    { id: 'users/update-user', folderId: 'users', name: 'Update user', method: 'PATCH', url: '{{baseUrl}}/{{apiVersion}}/users/{{userId}}' },
    { id: 'users/admin/purge', folderId: 'users/admin', name: 'Purge deleted users', method: 'DELETE', url: '{{baseUrl}}/admin/users/deleted' },
    { id: 'users/admin/replace-role', folderId: 'users/admin', name: 'Replace role', method: 'PUT', url: '{{baseUrl}}/admin/roles/{{role}}' },
    { id: 'auth/login', folderId: 'auth', name: 'Login', method: 'POST', url: '{{baseUrl}}/auth/login' },
    { id: 'auth/options', folderId: 'auth', name: 'CORS preflight', method: 'OPTIONS', url: '{{baseUrl}}/auth/login' },
  ],
  environments: [
    { name: 'dev', variables: [{ key: 'baseUrl', value: 'https://dev.acme.test' }, { key: 'token', value: '', secret: true }] },
    { name: 'prod', commit: true, variables: [{ key: 'baseUrl', value: 'https://api.acme.com' }, { key: 'token', value: '', secret: true }] },
  ],
  errors: [{ file: '.on_route/requests/orders/broken.yaml', line: 7, message: 'Unexpected indentation: expected a mapping' }],
};

const sidebarTree: ProjectTree = {
  ...tree,
  folders: [
    ...tree.folders,
    { id: 'orders', name: 'orders', auth: { type: 'inherit' }, variables: [] },
    { id: 'orders/refunds', name: 'refunds', auth: { type: 'inherit' }, variables: [] },
    { id: 'orders/refunds/archive', name: 'archive', auth: { type: 'inherit' }, variables: [] },
    { id: 'webhooks', name: 'webhooks', auth: { type: 'inherit' }, variables: [] },
  ],
  requests: [
    ...tree.requests,
    { id: 'auth/head-session', folderId: 'auth', name: 'Check session', method: 'HEAD', url: '{{baseUrl}}/auth/session' },
    { id: 'orders/list-orders', folderId: 'orders', name: 'List orders', method: 'GET', url: '{{baseUrl}}/orders' },
    { id: 'orders/create-order', folderId: 'orders', name: 'Create order with a very long descriptive name', method: 'POST', url: '{{baseUrl}}/orders' },
    { id: 'orders/refunds/refund', folderId: 'orders/refunds', name: 'Refund order', method: 'POST', url: '{{baseUrl}}/orders/{{id}}/refund' },
    { id: 'orders/refunds/archive/old', folderId: 'orders/refunds/archive', name: 'Delete archived refund', method: 'DELETE', url: '{{baseUrl}}/refunds/{{id}}' },
  ],
};

const MOCK_BODIES: Record<string, string> = {
  'auth/login': '{\n  "email": "ada@example.com",\n  "password": "{{password}}"\n}',
  'users/update-user': '{\n  "name": "Ada Lovelace",\n  "role": "admin",\n  "isActive": true\n}',
  'orders/create-order': '{\n  "customerId": "c_123",\n  "items": [{ "sku": "BOOK-1", "quantity": 2 }],\n  "currency": "USD"\n}',
};

const suggestionRequests: SuggestionRequest[] = sidebarTree.requests.map((r) => ({
  id: r.id,
  folderId: r.folderId,
  name: r.name,
  method: r.method,
  url: r.url,
  paramKeys: r.id === 'users/list-users' ? ['page', 'limit', 'role'] : [],
  body: MOCK_BODIES[r.id] ? { type: 'json', content: MOCK_BODIES[r.id] } : undefined,
}));

const sidebar: SidebarState = {
  initialized: true,
  hasWorkspace: true,
  tree: sidebarTree,
  activeRequestId: 'users/create-user',
  dirtyRequestIds: ['users/update-user'],
  scanning: false,
  settings: DEFAULT_USER_SETTINGS,
};

/** Apply a drag & drop move to the mock sidebar tree, mimicking the host (ids are paths). */
function applyMove(kind: 'folder' | 'request', id: string, target: string) {
  const t = sidebar.tree!;
  const base = id.slice(id.lastIndexOf('/') + 1);
  const newId = target ? `${target}/${base}` : base;
  const remap = (x: string) => (x === id ? newId : x.startsWith(`${id}/`) ? newId + x.slice(id.length) : x);
  if (kind === 'request') {
    sidebar.tree = {
      ...t,
      requests: t.requests.map((r) => (r.id === id ? { ...r, id: newId, folderId: target } : r)),
    };
    if (sidebar.activeRequestId === id) sidebar.activeRequestId = newId;
    sidebar.dirtyRequestIds = sidebar.dirtyRequestIds.map((d) => (d === id ? newId : d));
  } else {
    sidebar.tree = {
      ...t,
      folders: t.folders.map((f) => ({ ...f, id: remap(f.id) })),
      requests: t.requests.map((r) => ({ ...r, id: remap(r.id), folderId: remap(r.folderId) })),
    };
    if (sidebar.activeRequestId) sidebar.activeRequestId = remap(sidebar.activeRequestId);
    sidebar.dirtyRequestIds = sidebar.dirtyRequestIds.map(remap);
  }
}

const overview: OverviewState = {
  tree,
  activeEnvironment: 'dev',
  localOverrides: { dev: [{ key: 'token', value: 'dev-secret-123' }], prod: [] },
  settings: DEFAULT_USER_SETTINGS,
  trackedEnvironments: ['dev', 'prod'],
  scan: {
    running: false,
    last: { at: Date.now() - 4 * 60_000, trigger: 'auto', found: 14, added: 3, frameworks: ['Express', 'NestJS'], filesScanned: 212, durationMs: 840 },
  },
};

let request: RequestDef = {
  id: 'users/create-user',
  name: 'Create user',
  method: 'POST',
  url: '{{baseUrl}}/{{apiVersion}}/users',
  params: [
    { key: 'notify', value: 'true' },
    { key: 'dryRun', value: '1', enabled: false },
  ],
  headers: [
    { key: 'Accept', value: 'application/json' },
    { key: 'X-Request-Id', value: '{{$uuid}}' },
    { key: 'X-Tenant', value: '{{tenant}}', description: 'unknown variable example' },
  ],
  auth: { type: 'inherit' },
  body: { type: 'json', content: '{\n  "name": "Ada Lovelace",\n  "email": "ada@example.com",\n  "roles": ["admin"]\n}' },
  docs: 'Creates a user and optionally sends a welcome email.',
};

let responseFontSize = 0;

function context(): RequestContext {
  return {
    activeEnvironment: overview.activeEnvironment,
    environments: tree.environments.map((e) => e.name),
    variableKeys: ['baseUrl', 'apiVersion', 'token', 'userId'],
    variables: [
      { key: 'apiVersion', value: 'v1', source: 'project', secret: false, resolved: true },
      { key: 'baseUrl', value: 'https://dev.example.com', source: 'environment dev', secret: false, resolved: true },
      { key: 'token', value: '', source: 'local', secret: true, resolved: true },
      { key: 'userId', value: '42', source: 'environment dev', secret: false, resolved: true },
    ],
    responseFontSize,
    inheritedAuth: config.auth,
    inheritedAuthSource: 'project',
    settings: overview.settings,
  };
}

let seq = 0;
function makeEntry(status: number, ago: number, body: unknown): HistoryEntry {
  const text = JSON.stringify(body);
  return {
    id: `h${++seq}`,
    requestId: request.id,
    timestamp: Date.now() - ago,
    environment: overview.activeEnvironment,
    request: { method: request.method === 'WS' ? 'GET' : request.method, url: 'https://dev.acme.test/v2/users?notify=true', headers: [], body: { type: 'none' } },
    response: {
      status,
      statusText: status === 201 ? 'Created' : status === 422 ? 'Unprocessable Entity' : 'OK',
      headers: [
        ['content-type', 'application/json; charset=utf-8'],
        ['content-length', String(text.length)],
        ['x-request-id', 'b9e1c1a0-8d0e-4d8f-9a0e-2f6c0b1c2d3e'],
        ['date', new Date().toUTCString()],
      ],
      body: text,
      bodyEncoding: 'utf8',
      size: text.length,
      timing: { totalMs: 80 + Math.round(Math.random() * 300), ttfbMs: 60 },
      contentType: 'application/json; charset=utf-8',
    },
  };
}

let history: HistoryEntry[] = [
  makeEntry(201, 3 * 60_000, { id: 42, name: 'Ada Lovelace', email: 'ada@example.com', roles: ['admin'], createdAt: '2026-09-14T10:00:00Z' }),
  makeEntry(422, 2 * 3_600_000, { error: 'email already taken' }),
];

export function createMockApi() {
  const params = new URLSearchParams(location.search);
  const viewParam = params.get('view');
  window.__ON_ROUTE__ ??= { view: viewParam === 'overview' || viewParam === 'sidebar' ? viewParam : 'request' };
  applyTheme(params.get('theme') === 'light');
  const empty = params.get('empty');
  if (empty === 'workspace') Object.assign(sidebar, { hasWorkspace: false, initialized: false, tree: null });
  else if (empty === 'init') Object.assign(sidebar, { initialized: false, tree: null });
  else if (empty === 'requests') sidebar.tree = { ...sidebarTree, folders: [], requests: [], errors: [] };
  const sendSidebar = () => send({ type: 'sidebar', state: { ...sidebar } });

  let state: unknown;
  let pendingSend: ReturnType<typeof setTimeout> | undefined;
  const send = (msg: ExtensionMessage, delay = 30) =>
    setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: msg })), delay);

  return {
    getState: () => state,
    setState: (s: unknown) => {
      state = s;
    },
    postMessage(raw: unknown) {
      const msg = raw as WebviewMessage;
      console.debug('[mock] ←', msg.type, msg);
      switch (msg.type) {
        case 'ready':
          if (window.__ON_ROUTE__?.view === 'overview') send({ type: 'overview', state: overview });
          else if (window.__ON_ROUTE__?.view === 'sidebar') sendSidebar();
          else {
            send({ type: 'initRequest', request, context: context(), history });
            send({ type: 'suggestions', data: { requests: suggestionRequests } }, 60);
          }
          break;
        case 'saveRequest':
          request = msg.request;
          send({ type: 'saved', request });
          break;
        case 'sendRequest':
          send({ type: 'sending' }, 0);
          pendingSend = setTimeout(() => {
            const entry = makeEntry(201, 0, { id: Math.round(Math.random() * 1000), ...safeJson(msg.request.body) });
            history = [entry, ...history].slice(0, 20);
            send({ type: 'response', entry }, 0);
          }, 900);
          break;
        case 'cancelRequest':
          clearTimeout(pendingSend);
          break;
        case 'parseCurl':
          try {
            send({ type: 'curlParsed', request: parseCurl(msg.text) });
          } catch (e) {
            send({ type: 'error', message: `Could not parse cURL: ${(e as Error).message}` });
          }
          break;
        case 'generateCode': {
          const r = msg.request;
          const b = r.body;
          const code = generators[msg.target]({
            method: r.method === 'WS' ? 'GET' : r.method,
            url: r.url,
            headers: r.headers.filter((h) => h.enabled !== false).map(({ key, value }) => ({ key, value })),
            body:
              b.type === 'json'
                ? { type: 'text', content: b.content, contentType: 'application/json' }
                : b.type === 'raw'
                  ? { type: 'text', content: b.content, contentType: b.contentType }
                  : b.type === 'form'
                    ? { type: 'form', fields: b.fields.map((f) => ({ key: f.key, value: f.value, kind: f.kind ?? 'text' })) }
                    : b,
          });
          send({ type: 'code', target: msg.target, code }, 120);
          break;
        }
        case 'clearHistory':
          history = [];
          send({ type: 'history', history });
          break;
        case 'listAllHistory':
          // Stand-in for the size of the .history folder on disk.
          send({ type: 'allHistory', entries: history, bytes: history.length * 48 * 1024 });
          break;
        case 'clearAllHistory':
          history = [];
          send({ type: 'allHistory', entries: history, bytes: 0 });
          break;
        case 'renameRequest': {
          const folder = request.id.includes('/') ? request.id.slice(0, request.id.lastIndexOf('/') + 1) : '';
          const slug = msg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'request';
          request = { ...request, id: folder + slug, name: msg.name };
          send({ type: 'renamed', id: request.id, name: request.name });
          break;
        }
        case 'setResponseFontSize':
          responseFontSize = msg.size;
          send({ type: 'requestContext', context: context() });
          break;
        case 'setActiveEnvironment':
          overview.activeEnvironment = msg.name;
          send(window.__ON_ROUTE__?.view === 'overview' ? { type: 'overview', state: { ...overview } } : { type: 'requestContext', context: context() });
          break;
        case 'updateSettings':
          overview.settings = { ...overview.settings, ...msg.settings };
          send(window.__ON_ROUTE__?.view === 'overview' ? { type: 'overview', state: { ...overview } } : { type: 'requestContext', context: context() });
          break;
        case 'saveConfig':
          overview.tree = { ...overview.tree, config: msg.config };
          send({ type: 'overview', state: { ...overview } });
          break;
        case 'saveFolder':
          overview.tree = {
            ...overview.tree,
            folders: [...overview.tree.folders.filter((f) => f.id !== msg.folder.id), msg.folder],
          };
          send({ type: 'overview', state: { ...overview } });
          break;
        case 'saveEnvironment':
          overview.tree = {
            ...overview.tree,
            environments: overview.tree.environments.map((e) => (e.name === msg.environment.name ? msg.environment : e)),
          };
          overview.localOverrides = { ...overview.localOverrides, [msg.environment.name]: msg.localOverrides };
          send({ type: 'overview', state: { ...overview } });
          break;
        case 'createEnvironment':
          overview.tree = { ...overview.tree, environments: [...overview.tree.environments, { name: msg.name, variables: [] }] };
          send({ type: 'overview', state: { ...overview } });
          break;
        case 'untrackEnvironment':
          overview.trackedEnvironments = overview.trackedEnvironments.filter((n) => n !== msg.name);
          send({ type: 'overview', state: { ...overview } });
          break;
        case 'deleteEnvironment':
          overview.tree = { ...overview.tree, environments: overview.tree.environments.filter((e) => e.name !== msg.name) };
          send({ type: 'overview', state: { ...overview } });
          break;
        case 'moveItem':
          console.log('[mock] moveItem', msg.item, '→', JSON.stringify(msg.targetFolderId));
          applyMove(msg.item.kind, msg.item.id, msg.targetFolderId);
          sendSidebar();
          break;
        case 'runCommand': {
          console.log('[mock] runCommand', msg.command, msg.item ?? '');
          if (msg.command !== 'scanProject') break;
          const resend = () => (window.__ON_ROUTE__?.view === 'overview' ? send({ type: 'overview', state: { ...overview } }) : sendSidebar());
          overview.scan = { ...overview.scan, running: true };
          sidebar.scanning = true;
          resend();
          setTimeout(() => {
            overview.scan = { running: false, last: { ...overview.scan.last!, at: Date.now(), trigger: 'manual', added: 0 } };
            sidebar.scanning = false;
            resend();
          }, 1500);
          break;
        }
        case 'openRequest':
          console.log('[mock] openRequest', msg.id);
          if (window.__ON_ROUTE__?.view === 'sidebar') {
            sidebar.activeRequestId = msg.id;
            sendSidebar();
          }
          break;
        case 'newRequest':
          console.log('[mock] newRequest in', JSON.stringify(msg.folderId));
          break;
        default:
          break;
      }
    },
  };
}

function safeJson(body: RequestDef['body']): Record<string, unknown> {
  if (body.type !== 'json') return {};
  try {
    const v = JSON.parse(body.content);
    return typeof v === 'object' && v && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
