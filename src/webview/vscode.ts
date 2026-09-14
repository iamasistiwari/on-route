// Typed bridge to the VS Code webview API (or a mock when running outside VS Code).
import { useEffect, useRef } from 'react';
import type { ExtensionMessage, WebviewBootstrap, WebviewMessage } from '../shared/protocol';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, comboLabel, matchesCombo, type ShortcutAction, type Shortcuts } from '../shared/shortcuts';
import { createMockApi } from './mock';

export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    __ON_ROUTE__?: WebviewBootstrap;
  }
}
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

export const isMock = typeof acquireVsCodeApi !== 'function';
const api: VsCodeApi = !isMock && acquireVsCodeApi ? acquireVsCodeApi() : createMockApi();

export function post(msg: WebviewMessage): void {
  api.postMessage(msg);
}

/** Webview state; after a VS Code reload, the state the host saved for the sidebar / overview. */
export function getState<T>(): T | undefined {
  try {
    return (api.getState() as T | undefined) ?? (getBootstrap().uiState as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

let pendingState: unknown;
let stateTimer: ReturnType<typeof setTimeout> | undefined;
/** Debounced setState; cheap to call on every change. */
export function setState<T>(state: T): void {
  pendingState = state;
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    api.setState(pendingState);
    // Request editors keep their view state per request on the host (see setLayout).
    if (getBootstrap().view !== 'request') post({ type: 'persistUiState', state: pendingState });
  }, 200);
}

export function getBootstrap(): WebviewBootstrap {
  return window.__ON_ROUTE__ ?? { view: 'request' };
}

function isExtensionMessage(data: unknown): data is ExtensionMessage {
  return typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string';
}

export const IS_MAC = getBootstrap().isMac ?? /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Platform label for a combo like "Mod+Enter" ("⌘Enter" / "Ctrl+Enter"). */
export const shortcutLabel = (combo: string) => comboLabel(combo, IS_MAC);

/** True while the settings page records a new shortcut: no shortcut runs meanwhile. */
let recordingShortcut = false;
export function setRecordingShortcut(on: boolean): void {
  recordingShortcut = on;
}

/**
 * Runs the user's shortcuts in a webview. Registered in the capture phase so they win over inputs and
 * CodeMirror (e.g. Cmd/Ctrl+F always reaches the endpoint filter; the body find panel has a toolbar button).
 * Search and environment picking work in every view unless `handlers` override them.
 */
export function useShortcuts(shortcuts: Shortcuts | undefined, handlers: Partial<Record<ShortcutAction, () => void>> = {}): void {
  const ref = useRef({ shortcuts: shortcuts ?? DEFAULT_SHORTCUTS, handlers });
  ref.current = { shortcuts: shortcuts ?? DEFAULT_SHORTCUTS, handlers };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recordingShortcut) return;
      const { shortcuts: s, handlers: h } = ref.current;
      for (const a of SHORTCUT_ACTIONS) {
        if (!matchesCombo(s[a.id], e, IS_MAC)) continue;
        const run =
          h[a.id] ??
          (a.id === 'focusFilter'
            ? () => post({ type: 'focusFilter' })
            : a.id === 'selectEnvironment' && s.selectEnvironment !== a.default
              ? // The default combo is a VS Code keybinding that already runs everywhere.
                () => post({ type: 'runCommand', command: 'selectEnvironment' })
              : undefined);
        if (!run) return;
        e.preventDefault();
        e.stopPropagation();
        run();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** Subscribe to host messages; the latest handler is always used. */
export function useExtensionMessage(handler: (msg: ExtensionMessage) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      if (isExtensionMessage(e.data)) ref.current(e.data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
}
