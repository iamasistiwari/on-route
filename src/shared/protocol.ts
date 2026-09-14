// Typed postMessage protocol between extension host and webview.
import type {
  AuthConfig,
  Environment,
  FolderDef,
  HistoryEntry,
  ProjectConfig,
  ProjectTree,
  RequestDef,
  RequestMethod,
  Variable,
} from './model';
import { DEFAULT_SHORTCUTS, type Shortcuts } from './shortcuts';

/** Code snippet targets offered by the Code drawer. `syntax` picks the editor highlighting. */
export const CODE_TARGETS = [
  { id: 'curl', label: 'cURL', group: 'Shell', syntax: 'shell' },
  { id: 'wget', label: 'wget', group: 'Shell', syntax: 'shell' },
  { id: 'httpie', label: 'HTTPie', group: 'Shell', syntax: 'shell' },
  { id: 'powershell', label: 'PowerShell', group: 'Shell', syntax: 'powershell' },
  { id: 'http', label: 'HTTP', group: 'Raw', syntax: 'http' },
  { id: 'fetch', label: 'JavaScript - fetch', group: 'JavaScript', syntax: 'javascript' },
  { id: 'axios', label: 'JavaScript - axios', group: 'JavaScript', syntax: 'javascript' },
  { id: 'python-requests', label: 'Python - requests', group: 'Python', syntax: 'python' },
  { id: 'python-http', label: 'Python - http.client', group: 'Python', syntax: 'python' },
  { id: 'go', label: 'Go - net/http', group: 'Go', syntax: 'go' },
  { id: 'java-okhttp', label: 'Java - OkHttp', group: 'JVM', syntax: 'java' },
  { id: 'java-httpclient', label: 'Java - HttpClient', group: 'JVM', syntax: 'java' },
  { id: 'kotlin-okhttp', label: 'Kotlin - OkHttp', group: 'JVM', syntax: 'kotlin' },
  { id: 'csharp', label: 'C# - HttpClient', group: '.NET', syntax: 'csharp' },
  { id: 'php-curl', label: 'PHP - cURL', group: 'PHP', syntax: 'php' },
  { id: 'php-guzzle', label: 'PHP - Guzzle', group: 'PHP', syntax: 'php' },
  { id: 'ruby', label: 'Ruby - Net::HTTP', group: 'Ruby', syntax: 'ruby' },
  { id: 'swift', label: 'Swift - URLSession', group: 'Mobile', syntax: 'swift' },
  { id: 'dart', label: 'Dart - http', group: 'Mobile', syntax: 'dart' },
  { id: 'rust', label: 'Rust - reqwest', group: 'Rust', syntax: 'rust' },
] as const;

export type CodeTarget = (typeof CODE_TARGETS)[number]['id'];
export type CodeSyntax = (typeof CODE_TARGETS)[number]['syntax'];

/** Request editor undo history: `current` is the editor value the stacks were recorded against. */
export interface RequestUndoState {
  current: RequestDef;
  past: { value: RequestDef; key: string; at: number }[];
  future: RequestDef[];
}

/** Injected into the webview HTML as window.__ON_ROUTE__ before the bundle loads. */
export interface WebviewBootstrap {
  view: 'request' | 'overview' | 'sidebar';
  /** Host OS is macOS (shortcut labels: ⌘ vs Ctrl). Set by the host. */
  isMac?: boolean;
  /** View state saved by the host (sidebar / overview), restored after VS Code reloads. */
  uiState?: unknown;
}

/** Sidebar (WebviewView `onRoute.explorer`) state. */
export interface SidebarState {
  initialized: boolean;
  /** null when not initialized / no workspace. */
  tree: ProjectTree | null;
  /** Request whose editor panel is currently active, for highlighting. */
  activeRequestId: string | null;
  /** Request ids whose open editors have unsaved changes. */
  dirtyRequestIds: string[];
  /** false when no folder is open in VS Code. */
  hasWorkspace: boolean;
  settings: UserSettings;
  /** An endpoint scan is running. */
  scanning: boolean;
}

/**
 * Commands the sidebar can trigger. Each maps to the package.json command `onRoute.<name>`, called with
 * a SidebarItemRef argument when `item` is given. The same ref shape is placed in `data-vscode-context`
 * so native `webview/context` menus pass it to commands too (plus `webview` / `webviewSection` keys).
 */
export type SidebarCommand =
  | 'init'
  | 'importPostman'
  | 'importCurl'
  | 'openOverview'
  | 'newRequest'
  | 'newFolder'
  | 'renameItem'
  | 'deleteItem'
  | 'duplicateRequest'
  | 'copyAsCurl'
  | 'copyAsAxios'
  | 'scanProject'
  | 'selectEnvironment'
  | 'sendRequest';

/** Commands webviews may run via `runCommand` (allow-list checked by the host). */
export const SIDEBAR_COMMANDS: readonly SidebarCommand[] = [
  'init',
  'importPostman',
  'importCurl',
  'openOverview',
  'newRequest',
  'newFolder',
  'renameItem',
  'deleteItem',
  'duplicateRequest',
  'copyAsCurl',
  'copyAsAxios',
  'scanProject',
  'selectEnvironment',
  'sendRequest',
];

export interface SidebarItemRef {
  kind: 'folder' | 'request';
  id: string;
}

/** Personal preferences, stored in VS Code user settings (`onRoute.*`). */
export interface UserSettings {
  autoSave: boolean;
  autoSaveIntervalSeconds: number;
  /** Shorten long JSON string values in the body editor ("…view more"). */
  collapseLongStrings: boolean;
  /** Characters shown before a value is shortened. */
  collapseStringsOver: number;
  shortcuts: Shortcuts;
}

export const DEFAULT_COLLAPSE_STRINGS_OVER = 40;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  autoSave: false,
  autoSaveIntervalSeconds: 10,
  collapseLongStrings: true,
  collapseStringsOver: DEFAULT_COLLAPSE_STRINGS_OVER,
  shortcuts: DEFAULT_SHORTCUTS,
};

/** Split between the request and response panes of one request, remembered per request. */
export interface RequestLayout {
  /** Share of the request pane, 0–1. */
  ratio: number;
  /** Request pane hidden: only the response is shown. */
  requestHidden?: boolean;
  /** Request tab last open (params, headers, body, auth, docs). */
  tab?: string;
  /** Response tab last open (body, headers, history). */
  responseTab?: string;
}

/** Auto save intervals offered in the UI, in seconds; 0 = immediately (shortly after typing stops). */
export const AUTO_SAVE_INTERVALS = [0, 10, 20, 30, 60, 120, 300] as const;

/** Another request, as the editor needs it for URL and body suggestions. */
export interface SuggestionRequest {
  id: string;
  folderId: string;
  name: string;
  method: RequestMethod;
  url: string;
  paramKeys: string[];
  /** JSON / raw bodies up to a size limit. */
  body?: { type: 'json' | 'raw'; content: string };
}

export interface SuggestionData {
  requests: SuggestionRequest[];
}

/** A variable visible to a request, for autocomplete and highlighting. */
export interface VariableInfo {
  key: string;
  /** Resolved value; always "" for secrets (never sent to the webview). */
  value: string;
  /** Scope that supplied the value, e.g. "project" or "environment dev". */
  source: string;
  secret: boolean;
  /** false when defined but without a usable value (e.g. a secret with no local override). */
  resolved: boolean;
}

/** Context a request editor needs besides the request itself. */
export interface RequestContext {
  activeEnvironment: string | null;
  environments: string[];
  /** All variable keys visible to this request (for autocomplete / highlighting). */
  variableKeys: string[];
  /** Variables visible to this request, sorted by key. */
  variables: VariableInfo[];
  /** Response body font size in px; 0 = follow the editor font size. */
  responseFontSize: number;
  /** Effective auth of the parent chain, shown when request auth = inherit. */
  inheritedAuth: AuthConfig;
  inheritedAuthSource: string; // e.g. "folder users" or "project"
  settings: UserSettings;
}

export type ScanTrigger = 'manual' | 'auto' | 'init';

/** Result of one endpoint scan. */
export interface ScanRun {
  /** Finish time, epoch ms. */
  at: number;
  trigger: ScanTrigger;
  /** Unique endpoints found in the code. */
  found: number;
  /** Endpoints added as new requests. */
  added: number;
  frameworks: string[];
  filesScanned: number;
  durationMs: number;
  /** The file limit was reached. */
  truncated?: boolean;
  error?: string;
}

export interface ScanStatus {
  running: boolean;
  last?: ScanRun;
}

// ---------- WebSocket ----------

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closing';

/** One line of a WebSocket session log. Sessions live in memory only (not written to history). */
export type WsEvent = { id: string; at: number } & (
  | { kind: 'connecting'; url: string }
  /** Handshake done; `headers` are the handshake response headers when available. */
  | { kind: 'open'; protocol: string; headers: [string, string][]; ms: number }
  | { kind: 'sent'; data: string; size: number }
  /** `binary` messages carry base64 in `data`. */
  | { kind: 'received'; data: string; size: number; binary?: boolean }
  | { kind: 'closed'; code: number; reason: string; wasClean: boolean }
  | { kind: 'error'; message: string }
);

export interface OverviewState {
  /** Environments whose file is currently tracked by git (may differ from their commit setting). */
  trackedEnvironments: string[];
  scan: ScanStatus;
  settings: UserSettings;
  tree: ProjectTree;
  activeEnvironment: string | null;
  /** Local (gitignored) overrides per environment name. */
  localOverrides: Record<string, Variable[]>;
}

// ---------- webview -> extension ----------
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'saveRequest'; request: RequestDef }
  | { type: 'sendRequest'; request: RequestDef }
  | { type: 'cancelRequest' }
  /** WebSocket request: open a connection (variables and auth resolved like an HTTP send). */
  | { type: 'wsConnect'; request: RequestDef }
  /** Send a text message on the open connection; `{{variables}}` in it are resolved against `request`. */
  | { type: 'wsSend'; request: RequestDef; message: string }
  | { type: 'wsDisconnect' }
  /** Forget the kept WebSocket log (the webview cleared its view). */
  | { type: 'wsClearLog' }
  | { type: 'setDirty'; dirty: boolean }
  /** Request editor: latest undo / redo history, kept by the host so it survives closing or hiding the tab. */
  | { type: 'undoState'; state: RequestUndoState }
  /** Request editor: remember the pane split of this request. */
  | { type: 'setLayout'; layout: RequestLayout }
  /** Sidebar / overview: keep this view state across VS Code reloads (webview state alone is lost). */
  | { type: 'persistUiState'; state: unknown }
  /** Open Overview › Settings (e.g. from a shortcut hint). */
  | { type: 'openSettings' }
  | { type: 'parseCurl'; text: string }
  | { type: 'generateCode'; request: RequestDef; target: CodeTarget; resolveVariables: boolean }
  | { type: 'copyToClipboard'; text: string }
  /** Write a binary response body to a file the user picks. `base64` is the body as stored. */
  | { type: 'saveResponseBody'; base64: string; fileName: string }
  /** Cmd/Ctrl+F outside a code editor: reveal the sidebar and focus its endpoint filter. */
  | { type: 'focusFilter' }
  /** Persist the response body font size (px; 0 = editor default) in user settings. */
  | { type: 'setResponseFontSize'; size: number }
  /** `historyId` selects that response in the opened editor. */
  | { type: 'openRequest'; id: string; historyId?: string }
  /** Request editor: rename the request (name + file slug) immediately. */
  | { type: 'renameRequest'; name: string }
  /** Overview history page. */
  | { type: 'listAllHistory' }
  | { type: 'clearAllHistory' }
  | { type: 'newRequest'; folderId: string }
  | { type: 'setActiveEnvironment'; name: string | null }
  /** Overview settings page: change personal preferences (written to user settings). */
  | { type: 'updateSettings'; settings: Partial<UserSettings> }
  | { type: 'saveConfig'; config: ProjectConfig }
  | { type: 'saveFolder'; folder: FolderDef }
  | { type: 'saveEnvironment'; environment: Environment; localOverrides: Variable[] }
  | { type: 'createEnvironment'; name: string }
  | { type: 'deleteEnvironment'; name: string }
  /** Stop tracking an environment file in git (`git rm --cached`), after confirmation. */
  | { type: 'untrackEnvironment'; name: string }
  | { type: 'clearHistory'; requestId: string }
  // sidebar
  | { type: 'runCommand'; command: SidebarCommand; item?: SidebarItemRef }
  /**
   * Drag & drop: move a request or folder into targetFolderId ("" = top level). `before` places it in front of
   * that sibling (same kind), null = at the end; undefined keeps the stored order untouched.
   */
  | { type: 'moveItem'; item: SidebarItemRef; targetFolderId: string; before?: string | null };

// ---------- extension -> webview ----------
export type ExtensionMessage =
  | {
      type: 'initRequest';
      request: RequestDef;
      context: RequestContext;
      history: HistoryEntry[];
      selectedHistoryId?: string;
      /** Undo / redo history kept by the host since the editor was first opened (until VS Code reloads). */
      undo?: RequestUndoState;
      /** Pane split saved for this request; undefined = default. */
      layout?: RequestLayout;
    }
  /** Send shortcut (Cmd/Ctrl+Enter) handled by VS Code, e.g. while the webview itself has no keyboard focus. */
  | { type: 'sendShortcut' }
  /** Show this history entry (e.g. opened from the overview history page). */
  | { type: 'selectHistory'; id: string }
  /** Request was renamed on disk; update name + id without touching other unsaved edits. */
  | { type: 'renamed'; id: string; name: string }
  /** All history across the project, newest first. Response bodies may be shortened (`truncated`). */
  | { type: 'allHistory'; entries: HistoryEntry[]; bytes: number }
  | { type: 'requestContext'; context: RequestContext }
  /** File changed on disk while editor open. Webview replaces if not dirty, else asks. */
  | { type: 'requestChangedOnDisk'; request: RequestDef }
  | { type: 'saved'; request: RequestDef }
  | { type: 'sending' }
  | { type: 'response'; entry: HistoryEntry }
  /** WebSocket session: connection status plus new log events (appended in order; `reset` replaces the log). */
  | { type: 'ws'; status: WsStatus; events: WsEvent[]; reset?: boolean }
  | { type: 'history'; history: HistoryEntry[] }
  /** Other requests of the project, for URL / body suggestions. Re-sent when the project changes. */
  | { type: 'suggestions'; data: SuggestionData }
  | { type: 'curlParsed'; request: Partial<RequestDef> }
  | { type: 'code'; target: CodeTarget; code: string }
  | { type: 'overview'; state: OverviewState }
  /** Overview: switch to this page. */
  | { type: 'showPage'; page: string }
  | { type: 'sidebar'; state: SidebarState }
  /** Sidebar: move keyboard focus to the endpoint filter. */
  | { type: 'focusFilter' }
  | { type: 'error'; message: string };
