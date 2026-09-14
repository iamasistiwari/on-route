import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { REQUEST_METHODS, isWebSocket, type HistoryEntry, type HttpErrorInfo, type RequestDef, type RequestMethod } from '../../shared/model';
import {
  DEFAULT_USER_SETTINGS,
  type CodeTarget,
  type RequestContext,
  type RequestLayout,
  type RequestUndoState,
  type SuggestionData,
  type WsEvent,
  type WsStatus,
} from '../../shared/protocol';
import { Icon } from '../components/Icon';
import { isCurlCommand, parseCurl } from '../../shared/importers/curl';
import { decodeBase64Paste, type DecodedPaste } from '../lib/base64Paste';
import { AuthEditor } from '../components/AuthEditor';
import { BodyEditor } from '../components/BodyEditor';
import { CodeDrawer } from '../components/CodeDrawer';
import { KeyValueTable } from '../components/KeyValueTable';
import { METHOD_TEXT } from '../components/MethodBadge';
import { ResponseView, type ResponseTab } from '../components/ResponseView';
import { ShortcutTip } from '../components/ShortcutTip';
import { Tabs } from '../components/Tabs';
import { Toast, type ToastData } from '../components/Toast';
import { UrlInput } from '../components/UrlInput';
import { WebSocketView, WsComposer } from '../components/WebSocketView';
import { Button, DirtyDot, Spinner, cx } from '../components/ui';
import { deepEqual } from '../lib/equal';
import { countEnabled } from '../lib/format';
import { jsonKeyCorpus, suggestBodies, suggestUrl, type UrlSuggestContext } from '../lib/suggest';
import { UndoStack, requestEditKey } from '../lib/undo';
import { parentFolderId } from '../lib/tree';
import { applyUrlEdit } from '../lib/url';
import { getState, post, setState, shortcutLabel, useExtensionMessage, useShortcuts } from '../vscode';

type RequestTab = 'params' | 'headers' | 'body' | 'auth' | 'docs';

interface Persisted {
  request: RequestDef;
  baseline: RequestDef;
  tab: RequestTab;
  responseTab: ResponseTab;
  ratio: number;
  selectedEntryId: string | null;
}

const EMPTY_CONTEXT: RequestContext = {
  activeEnvironment: null,
  environments: [],
  variableKeys: [],
  variables: [],
  responseFontSize: 0,
  inheritedAuth: { type: 'none' },
  inheritedAuthSource: 'project',
  settings: DEFAULT_USER_SETTINGS,
};

/** Smallest request pane while resizing; dragging below half of it hides the pane. */
const MIN_REQUEST_PX = { wide: 320, tall: 140 };
/** The pane split is saved for the request this long after resizing stops. */
const LAYOUT_SAVE_MS = 400;
const layoutKey = (l: RequestLayout) =>
  JSON.stringify({ ratio: l.ratio, ...(l.requestHidden && { requestHidden: true }), tab: l.tab, responseTab: l.responseTab });

const REQUEST_TABS: readonly RequestTab[] = ['params', 'headers', 'body', 'auth', 'docs'];
const RESPONSE_TABS: readonly ResponseTab[] = ['body', 'headers', 'history'];
const pick = <T extends string>(allowed: readonly T[], value: string | undefined): T | undefined =>
  allowed.includes(value as T) ? (value as T) : undefined;

/** WebSocket log lines kept in the view (the host keeps the same limit). */
const WS_LOG_LIMIT = 2000;

const WIDE_BREAKPOINT = 1100;
/** "Immediately" auto save waits this long after the last edit. */
const IMMEDIATE_SAVE_DELAY_MS = 800;
/** A browser / VS Code undo arriving this soon after a handled key press is the same command. */
const HISTORY_ECHO_MS = 500;
/** Undo history is handed to the host this long after the last change. */
const UNDO_SYNC_MS = 150;

/** Elements that keep their own native undo (e.g. the rename box, which renames the file right away). */
const hasNativeUndo = (target: EventTarget | null) => target instanceof Element && !!target.closest('[data-native-undo]');

function looksLikeCurl(text: string): boolean {
  try {
    return isCurlCommand(text);
  } catch {
    return /^\s*(\$\s*)?curl\s/i.test(text);
  }
}

function isDefaultName(name: string): boolean {
  return /^\s*$|^(new request|untitled|request)(\s*\d+)?$/i.test(name.trim());
}

function mergeImported(current: RequestDef, imported: Partial<RequestDef>): RequestDef {
  const { id: _ignore, ...rest } = imported;
  void _ignore;
  return {
    ...current,
    ...rest,
    id: current.id,
    name: isDefaultName(current.name) && imported.name ? imported.name : current.name,
    docs: current.docs,
    order: current.order,
  };
}

export function RequestView() {
  const persisted = useMemo(() => getState<Persisted>(), []);
  const [request, setRequest] = useState<RequestDef | null>(null);
  const [baseline, setBaseline] = useState<RequestDef | null>(null);
  const [context, setContext] = useState<RequestContext>(EMPTY_CONTEXT);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  /** Last transport failure; shown as a badge only, never stored as a response. */
  const [failure, setFailure] = useState<HttpErrorInfo | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [tab, setTab] = useState<RequestTab>(persisted?.tab ?? 'params');
  const [responseTab, setResponseTab] = useState<ResponseTab>(persisted?.responseTab ?? 'body');
  const [ratio, setRatio] = useState(persisted?.ratio ?? 0.5);
  const [requestHidden, setRequestHidden] = useState(false);
  /** Layout last saved for (or loaded from) this request; null until the request is loaded. */
  const lastLayoutRef = useRef<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState<{ target: CodeTarget; code: string } | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [conflict, setConflict] = useState<RequestDef | null>(null);
  const [suggestionData, setSuggestionData] = useState<SuggestionData | null>(null);
  const [editingName, setEditingName] = useState(false);
  /** Bumped on every cURL import; the address bar pops once per bump (see `urlPopClass`). */
  const [importTick, setImportTick] = useState(0);
  /** A base64 blob pasted into the URL bar, shown in the response pane instead of filling the field. */
  const [paste, setPaste] = useState<DecodedPaste | null>(null);
  const [wide, setWide] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>('idle');
  const [wsEvents, setWsEvents] = useState<WsEvent[]>([]);
  const splitRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef(new UndoStack<RequestDef>());
  /** Set before a request change that must not become an undo step: 'reset' also clears the history. */
  const skipRecordRef = useRef<'history' | 'reset' | null>(null);
  const requestRef = useRef<RequestDef | null>(null);
  const prevRequestRef = useRef<RequestDef | null>(null);
  const lastHistoryAtRef = useRef(0);
  /** Undo history from the host, applied with the next 'reset'. */
  const pendingUndoRef = useRef<RequestUndoState | null>(null);
  /** When a send last started here; VS Code's own send keybinding for the same key press arrives as an echo. */
  const lastSendAtRef = useRef(0);

  const dirty = useMemo(() => !!request && !!baseline && !deepEqual(request, baseline), [request, baseline]);

  const showToast = useCallback((t: Omit<ToastData, 'id'>) => setToast({ ...t, id: Date.now() }), []);
  /** Apply a parsed cURL command: the address bar filling itself is the whole feedback. */
  const applyImport = useCallback((prev: RequestDef, imported: Partial<RequestDef>) => {
    setRequest(mergeImported(prev, imported));
    setImportTick((n) => n + 1);
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // ---------- host messages ----------
  useExtensionMessage((msg) => {
    switch (msg.type) {
      case 'initRequest': {
        const keepPersisted =
          persisted && persisted.request.id === msg.request.id && !deepEqual(persisted.request, persisted.baseline);
        skipRecordRef.current = 'reset';
        pendingUndoRef.current = msg.undo ?? null;
        setRequest(keepPersisted ? persisted.request : msg.request);
        setBaseline(msg.request);
        setContext(msg.context);
        // Layout, request tab and response tab are remembered per request (kept by the host across reloads).
        const saved = msg.layout;
        const sameRequest = persisted?.request.id === msg.request.id;
        const layout: RequestLayout = {
          ratio: saved?.ratio ?? persisted?.ratio ?? 0.5,
          ...(saved?.requestHidden && { requestHidden: true }),
          tab: pick(REQUEST_TABS, saved?.tab) ?? (sameRequest ? persisted?.tab : undefined) ?? 'params',
          responseTab: pick(RESPONSE_TABS, saved?.responseTab) ?? (sameRequest ? persisted?.responseTab : undefined) ?? 'body',
        };
        setRatio(layout.ratio);
        setRequestHidden(!!layout.requestHidden);
        setTab(layout.tab as RequestTab);
        setResponseTab(layout.responseTab as ResponseTab);
        lastLayoutRef.current = layoutKey(layout);
        setHistory(msg.history);
        const wantedId = msg.selectedHistoryId ?? persisted?.selectedEntryId;
        const selected = wantedId ? msg.history.find((h) => h.id === wantedId) : undefined;
        setEntry(selected ?? msg.history[0] ?? null);
        if (msg.selectedHistoryId && selected) setResponseTab('body');
        break;
      }
      case 'selectHistory': {
        const selected = history.find((h) => h.id === msg.id);
        if (selected) {
          setEntry(selected);
          setResponseTab('body');
        }
        break;
      }
      case 'renamed':
        setRequest((r) => (r ? { ...r, id: msg.id, name: msg.name } : r));
        setBaseline((b) => (b ? { ...b, id: msg.id, name: msg.name } : b));
        break;
      case 'requestContext':
        setContext(msg.context);
        break;
      case 'requestChangedOnDisk':
        if (!dirty) {
          // An undoable step, like any other change.
          setRequest(msg.request);
          setBaseline(msg.request);
          setConflict(null);
        } else {
          setConflict(msg.request);
        }
        break;
      case 'saved':
        setBaseline(msg.request);
        setRequest((r) => (r ? { ...r, id: msg.request.id, order: msg.request.order } : msg.request));
        setConflict(null);
        break;
      case 'sending':
        setSending((s) => s ?? Date.now());
        break;
      case 'sendShortcut':
        if (sending === null && Date.now() - lastSendAtRef.current >= HISTORY_ECHO_MS) send();
        break;
      case 'response':
        setSending(null);
        if (msg.entry.response) {
          setFailure(null);
          setEntry(msg.entry);
          setHistory((h) => [msg.entry, ...h.filter((x) => x.id !== msg.entry.id)]);
        } else if (msg.entry.error) {
          // The request never reached the server: report it in the status badge, leave the body pane
          // and the history alone.
          setFailure(msg.entry.error);
        }
        if (responseTab === 'history') setResponseTab('body');
        break;
      case 'ws':
        setWsStatus(msg.status);
        if (msg.reset) setWsEvents(msg.events);
        else if (msg.events.length) setWsEvents((prev) => [...prev, ...msg.events].slice(-WS_LOG_LIMIT));
        break;
      case 'history':
        setHistory(msg.history);
        if (entry && !msg.history.some((h) => h.id === entry.id) && msg.history.length === 0) setEntry(null);
        break;
      case 'suggestions':
        setSuggestionData(msg.data);
        break;
      case 'curlParsed':
        if (request) applyImport(request, msg.request);
        break;
      case 'code':
        setCode({ target: msg.target, code: msg.code });
        break;
      case 'error':
        setSending(null);
        showToast({ message: msg.message, kind: 'error' });
        break;
    }
  });

  useEffect(() => post({ type: 'ready' }), []);

  // ---------- dirty + persistence ----------
  const lastDirty = useRef<boolean | null>(null);
  useEffect(() => {
    if (!request) return;
    if (lastDirty.current !== dirty) {
      lastDirty.current = dirty;
      post({ type: 'setDirty', dirty });
    }
  }, [dirty, request]);

  useEffect(() => {
    if (request && baseline) setState<Persisted>({ request, baseline, tab, responseTab, ratio, selectedEntryId: entry?.id ?? null });
  }, [request, baseline, tab, responseTab, ratio, entry]);

  // ---------- layout ----------
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width > WIDE_BREAKPOINT));
    ro.observe(el);
    return () => ro.disconnect();
  }, [request === null]);

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = splitRef.current;
    if (!el) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const size = Math.max(1, wide ? rect.width : rect.height);
      const pos = wide ? ev.clientX - rect.left : ev.clientY - rect.top;
      const min = wide ? MIN_REQUEST_PX.wide : MIN_REQUEST_PX.tall;
      // Near the edge the request pane snaps closed (response only); dragging back out reopens it.
      if (pos < min / 2) {
        setRequestHidden(true);
        return;
      }
      setRequestHidden(false);
      setRatio(Math.min(0.85, Math.max(pos, Math.min(min, size * 0.85)) / size));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // Remember the split for this request (per request, kept across restarts).
  useEffect(() => {
    if (lastLayoutRef.current === null) return;
    const layout: RequestLayout = { ratio, ...(requestHidden && { requestHidden: true }), tab, responseTab };
    const key = layoutKey(layout);
    if (key === lastLayoutRef.current) return;
    const t = setTimeout(() => {
      lastLayoutRef.current = key;
      post({ type: 'setLayout', layout });
    }, LAYOUT_SAVE_MS);
    return () => clearTimeout(t);
  }, [ratio, requestHidden, tab, responseTab]);

  const toggleRequestPane = useCallback(() => setRequestHidden((h) => !h), []);

  // ---------- actions ----------
  const update = useCallback((patch: Partial<RequestDef>) => setRequest((r) => (r ? { ...r, ...patch } : r)), []);

  const ws = isWebSocket(request?.method);

  const sendWsMessage = useCallback(() => {
    if (!request || wsStatus !== 'open') return;
    const message = request.body.type === 'json' || request.body.type === 'raw' ? request.body.content : '';
    if (message === '') {
      setTab('body');
      showToast({ message: 'Write a message in the Message tab first' });
      return;
    }
    post({ type: 'wsSend', request, message });
  }, [request, wsStatus, showToast]);

  /** WS request: connect when idle, send the message when connected. */
  const wsPrimary = useCallback(() => {
    if (!request) return;
    lastSendAtRef.current = Date.now();
    if (wsStatus === 'idle') {
      setWsStatus('connecting');
      post({ type: 'wsConnect', request });
    } else if (wsStatus === 'open') {
      sendWsMessage();
    }
  }, [request, wsStatus, sendWsMessage]);

  const wsDisconnect = useCallback(() => post({ type: 'wsDisconnect' }), []);
  const wsClear = useCallback(() => {
    setWsEvents([]);
    post({ type: 'wsClearLog' });
  }, []);

  const send = useCallback(() => {
    if (!request) return;
    // Sending a blank URL reaches the server layer and comes back as "Invalid request", which says
    // nothing. Stop it here, silently: the empty field is its own explanation.
    if (!request.url.trim()) return;
    // A base64 blob left in the URL bar (pasted quoted, then edited by hand) is not an address.
    // Decode it rather than firing a request that can only come back as ERR_INVALID_URL.
    const blob = decodeBase64Paste(request.url);
    if (blob) {
      setPaste(blob);
      setImportTick((n) => n + 1);
      if (responseTab === 'history') setResponseTab('body');
      return;
    }
    if (isWebSocket(request.method)) {
      wsPrimary();
      return;
    }
    lastSendAtRef.current = Date.now();
    setSending(Date.now());
    setPaste(null);
    setFailure(null);
    if (responseTab === 'history') setResponseTab('body');
    post({ type: 'sendRequest', request });
  }, [request, responseTab, wsPrimary]);

  const cancel = useCallback(() => {
    post({ type: 'cancelRequest' });
    setSending(null);
  }, []);

  const save = useCallback(() => {
    // Nothing to save: Ctrl/Cmd+S is a no-op when clean.
    if (request && dirty) post({ type: 'saveRequest', request });
  }, [request, dirty]);

  const onUrlChange = useCallback((text: string) => setRequest((r) => (r ? { ...r, ...applyUrlEdit(r, text) } : r)), []);

  const onUrlPaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData('text/plain');
      if (!request) return;
      if (!looksLikeCurl(text)) {
        // A base64 blob belongs in the response pane, not in a URL field thousands of characters wide.
        const decoded = decodeBase64Paste(text);
        if (decoded) {
          e.preventDefault();
          setPaste(decoded);
          setImportTick((n) => n + 1);
        }
        return;
      }
      e.preventDefault();
      try {
        applyImport(request, parseCurl(text));
      } catch {
        // Fall back to the host parser (it reports the failure as an error toast).
        post({ type: 'parseCurl', text });
      }
    },
    [request, applyImport],
  );

  const dismissPaste = useCallback(() => setPaste(null), []);

  const copy = useCallback((text: string) => post({ type: 'copyToClipboard', text }), []);
  const setResponseFontSize = useCallback((size: number) => {
    // Optimistic; the host saves it to settings and re-posts the context to every open request.
    setContext((c) => ({ ...c, responseFontSize: size }));
    post({ type: 'setResponseFontSize', size });
  }, []);
  const clearHistory = useCallback(() => request && post({ type: 'clearHistory', requestId: request.id }), [request]);
  const selectHistory = useCallback((h: HistoryEntry) => {
    setEntry(h);
    setResponseTab('body');
  }, []);

  // ---------- undo / redo ----------
  // Every edit of the request (URL, params, headers, body, auth, docs) is one history, so Cmd/Ctrl+Z works the
  // same everywhere and is not lost when auto save writes the file.
  requestRef.current = request;
  useEffect(() => {
    const prev = prevRequestRef.current;
    prevRequestRef.current = request;
    const skip = skipRecordRef.current;
    skipRecordRef.current = null;
    const history = historyRef.current;
    if (skip === 'reset') {
      history.clear();
      const saved = pendingUndoRef.current;
      pendingUndoRef.current = null;
      if (saved && request) {
        history.restore(saved);
        // Reopened with other content than when the history was saved (e.g. unsaved edits were discarded):
        // that content becomes one undo step back.
        const key = requestEditKey(saved.current, request);
        if (key) history.record(saved.current, key);
      }
    } else if (!skip && prev && request) {
      const key = requestEditKey(prev, request);
      if (key) history.record(prev, key);
    }
    if (!request) return;
    // Hand the history to the host so it survives closing / hiding this editor.
    const t = setTimeout(() => post({ type: 'undoState', state: { current: request, ...history.snapshot() } }), UNDO_SYNC_MS);
    return () => clearTimeout(t);
  }, [request]);

  /** Returns whether there was a step to apply. */
  const stepHistory = useCallback((direction: 'undo' | 'redo'): boolean => {
    const cur = requestRef.current;
    if (!cur) return false;
    const target = direction === 'undo' ? historyRef.current.undo(cur) : historyRef.current.redo(cur);
    if (!target) return false;
    skipRecordRef.current = 'history';
    // Name, file and position change on disk right away; undo keeps the current ones.
    setRequest({ ...target, id: cur.id, name: cur.name, order: cur.order });
    return true;
  }, []);

  // ---------- keyboard ----------
  useShortcuts(context.settings.shortcuts, {
    send: () => keyRef.current.sending === null && keyRef.current.send(),
    save: () => keyRef.current.save(),
    toggleRequestPane,
  });
  const keyRef = useRef({ send, save, cancel, codeOpen, sending, stepHistory });
  keyRef.current = { send, save, cancel, codeOpen, sending, stepHistory };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = keyRef.current;
      const key = e.key.toLowerCase();
      const undoKey = mod && !e.altKey && key === 'z';
      const redoKey = (undoKey && e.shiftKey) || (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'y');
      if ((undoKey || redoKey) && !hasNativeUndo(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        lastHistoryAtRef.current = Date.now();
        k.stepHistory(redoKey ? 'redo' : 'undo');
        return;
      }
      if (e.key === 'Escape' && k.codeOpen) {
        e.preventDefault();
        setCodeOpen(false);
      }
    };
    // VS Code's Edit > Undo (and its undo command after a key press) runs document.execCommand('undo') in the
    // webview: a native undo of the focused input that fires only a non-cancelable `input` event. Hide it from
    // React and run our history step instead. When that changes nothing (an echo of a handled key press, or an
    // empty history), put the field back with the opposite native command once this one has finished; browsers
    // refuse nested execCommand calls.
    let reverting = false;
    const onInput = (e: Event) => {
      const type = (e as InputEvent).inputType;
      if ((type !== 'historyUndo' && type !== 'historyRedo') || hasNativeUndo(e.target)) return;
      e.stopImmediatePropagation();
      if (reverting) return;
      let applied = false;
      if (Date.now() - lastHistoryAtRef.current >= HISTORY_ECHO_MS) {
        lastHistoryAtRef.current = Date.now();
        applied = keyRef.current.stepHistory(type === 'historyRedo' ? 'redo' : 'undo');
      }
      if (applied) return;
      setTimeout(() => {
        reverting = true;
        document.execCommand(type === 'historyUndo' ? 'redo' : 'undo');
        reverting = false;
      }, 0);
    };
    const onBeforeInput = (e: Event) => {
      const type = (e as InputEvent).inputType;
      if ((type !== 'historyUndo' && type !== 'historyRedo') || hasNativeUndo(e.target) || !e.cancelable) return;
      e.preventDefault();
      if (Date.now() - lastHistoryAtRef.current < HISTORY_ECHO_MS) return;
      lastHistoryAtRef.current = Date.now();
      keyRef.current.stepHistory(type === 'historyRedo' ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeinput', onBeforeInput, true);
    window.addEventListener('input', onInput, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('beforeinput', onBeforeInput, true);
      window.removeEventListener('input', onInput, true);
    };
  }, []);

  // ---------- suggestions ----------
  const folderId = request ? parentFolderId(request.id) : '';
  const suggestionRequests = suggestionData?.requests;
  const urlContext = useRef<UrlSuggestContext>({ requests: [] });
  urlContext.current = { requests: suggestionRequests ?? [], currentId: request?.id, folderId, method: request?.method, variableKeys: context.variableKeys };
  const suggestUrlText = useCallback((text: string) => suggestUrl(text, urlContext.current), []);
  const bodyStarters = useMemo(
    () => (request && suggestionRequests ? suggestBodies(suggestionRequests, { id: request.id, folderId, method: request.method, url: request.url }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggestionRequests, request?.id, request?.method, request?.url, folderId],
  );
  const jsonKeys = useMemo(
    () => (request && suggestionRequests ? jsonKeyCorpus(suggestionRequests, { id: request.id, folderId }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggestionRequests, request?.id, folderId],
  );

  // ---------- auto save ----------
  /** null = off, 0 = immediately, otherwise seconds between saves. */
  const autoSave = context.settings.autoSave ? context.settings.autoSaveIntervalSeconds : null;
  const autoSaveRef = useRef({ save, dirty, conflict });
  autoSaveRef.current = { save, dirty, conflict };
  useEffect(() => {
    if (!autoSave) return;
    const t = setInterval(() => {
      const a = autoSaveRef.current;
      // While the file changed on disk, wait for the user to pick Reload or Keep mine.
      if (a.dirty && !a.conflict) a.save();
    }, autoSave * 1000);
    return () => clearInterval(t);
  }, [autoSave]);
  useEffect(() => {
    if (autoSave !== 0 || !dirty || conflict) return;
    const t = setTimeout(() => autoSaveRef.current.save(), IMMEDIATE_SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [autoSave, request, dirty, conflict]);

  const tabs = useMemo(
    () =>
      request
        ? [
            { id: 'params' as const, label: 'Params', badge: countEnabled(request.params) },
            { id: 'headers' as const, label: 'Headers', badge: countEnabled(request.headers) },
            isWebSocket(request.method)
              ? { id: 'body' as const, label: 'Message', badge: (request.body.type === 'json' || request.body.type === 'raw') && request.body.content ? '•' : undefined }
              : { id: 'body' as const, label: 'Body', badge: request.body.type === 'none' ? undefined : '•' },
            { id: 'auth' as const, label: 'Auth', badge: request.auth.type === 'none' || request.auth.type === 'inherit' ? undefined : '•' },
            { id: 'docs' as const, label: 'Docs', badge: request.docs ? '•' : undefined },
          ]
        : [],
    [request],
  );

  if (!request) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner /> Loading request…
      </div>
    );
  }

  // Alternating class names so a second paste restarts the pop instead of being ignored as "already animating".
  const urlPopClass = importTick === 0 ? undefined : importTick % 2 ? 'url-pop-a' : 'url-pop-b';
  const pct = `${Math.round(ratio * 1000) / 10}%`;
  const paneShortcut = shortcutLabel(context.settings.shortcuts.toggleRequestPane);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {editingName ? (
            <>
              <input
                autoFocus
                data-native-undo
                aria-label="Request name"
                className="ctl min-w-0 max-w-md flex-1 py-[3px] font-semibold"
                defaultValue={request.name}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  // Renames the request and its file right away (history and open tabs follow).
                  if (name && name !== request.name) post({ type: 'renameRequest', name });
                  setEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    e.currentTarget.value = request.name;
                    setEditingName(false);
                  }
                }}
              />
              <span className="hidden shrink-0 text-[11px] text-muted sm:inline">Enter to rename · Esc to cancel</span>
            </>
          ) : (
            <>
              <button
                type="button"
                title="Click to rename"
                className="min-w-0 truncate rounded-full px-2.5 py-[3px] text-left text-[13.5px] font-semibold hover:bg-[var(--or-soft-strong)]"
                onClick={() => setEditingName(true)}
              >
                {request.name || 'Untitled request'}
              </button>
              <DirtyDot show={dirty} />
            </>
          )}
        </div>
        <ShortcutTip label="Select environment" shortcut={shortcutLabel(context.settings.shortcuts.selectEnvironment)}>
          <select
            className="ctl is-pill max-w-[180px] cursor-pointer py-[3px] text-[12px]"
            aria-label="Environment"
            value={context.activeEnvironment ?? ''}
            onChange={(e) => {
              const name = e.target.value || null;
              setContext((c) => ({ ...c, activeEnvironment: name }));
              post({ type: 'setActiveEnvironment', name });
            }}
          >
            <option value="">No environment</option>
            {context.environments.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </ShortcutTip>
        {!ws && (
          <Button variant="ghost" icon="code" onClick={() => setCodeOpen(true)}>
            Code
          </Button>
        )}
        {autoSave !== null && (
          <span
            className="hidden shrink-0 text-[11.5px] text-muted sm:inline"
            title={autoSave === 0 ? 'Changes are saved as you type' : `Unsaved changes are saved every ${autoSave < 60 ? `${autoSave} seconds` : `${autoSave / 60} min`}`}
          >
            Auto save on
          </span>
        )}
        <ShortcutTip label={dirty ? 'Save' : 'Save (no changes)'} shortcut={shortcutLabel(context.settings.shortcuts.save)}>
          {/* Wrapper: disabled buttons get no mouse events. */}
          <span className="inline-flex">
            <Button variant="primary" disabled={!dirty} onClick={save}>
              Save
            </Button>
          </span>
        </ShortcutTip>
      </div>

      {conflict && (
        <div className="mx-3 mt-2 flex items-center gap-3 rounded-full border border-banner-border bg-banner px-4 py-1 text-[12px]">
          <span className="flex-1">File changed on disk.</span>
          <button
            type="button"
            className="text-link hover:underline"
            onClick={() => {
              setRequest(conflict);
              setBaseline(conflict);
              setConflict(null);
            }}
          >
            Reload
          </button>
          <button
            type="button"
            className="text-link hover:underline"
            onClick={() => {
              setBaseline(conflict);
              setConflict(null);
            }}
          >
            Keep mine
          </button>
        </div>
      )}

      {/* URL row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* Method + URL share one rounded field, like an address bar. */}
        <div className={cx('ctl flex min-w-0 flex-1 items-center p-0 pl-1', urlPopClass)}>
          <select
            aria-label="Method"
            className={cx(
              'w-[84px] shrink-0 cursor-pointer rounded-md bg-transparent px-2 py-1 font-mono text-[12.5px] font-bold outline-none hover:bg-[var(--or-soft)]',
              METHOD_TEXT[request.method],
            )}
            value={request.method}
            onChange={(e) => {
              const method = e.target.value as RequestMethod;
              // Leaving WebSocket mode closes its connection.
              if (isWebSocket(request.method) && !isWebSocket(method) && wsStatus !== 'idle') wsDisconnect();
              update({ method });
            }}
          >
            {REQUEST_METHODS.map((m) => (
              <option key={m} value={m} title={isWebSocket(m) ? 'WebSocket' : undefined}>
                {m}
              </option>
            ))}
          </select>
          <span className="h-4 w-px shrink-0 bg-[var(--or-line)]" aria-hidden />
          <UrlInput
            className="min-w-0 flex-1"
            url={request.url}
            params={request.params}
            variables={context.variables}
            onChange={onUrlChange}
            onPaste={onUrlPaste}
            onEnter={send}
            suggest={suggestUrlText}
            preview={paste ? { head: paste.source.head, length: paste.source.length, onClear: dismissPaste } : undefined}
          />
        </div>
        {ws ? (
          wsStatus === 'idle' ? (
            <ShortcutTip label="Connect" shortcut={shortcutLabel(context.settings.shortcuts.send)}>
              <Button variant="primary" icon="plug" className="min-w-[84px] py-[5px]" onClick={wsPrimary}>
                Connect
              </Button>
            </ShortcutTip>
          ) : (
            <Button variant="secondary" className="min-w-[84px] py-[5px]" disabled={wsStatus === 'closing'} onClick={wsDisconnect}>
              {wsStatus === 'connecting' ? 'Cancel' : 'Disconnect'}
            </Button>
          )
        ) : sending !== null ? (
          <Button variant="secondary" className="w-[84px] py-[5px]" onClick={cancel}>
            Cancel
          </Button>
        ) : (
          <ShortcutTip label="Send request" shortcut={shortcutLabel(context.settings.shortcuts.send)}>
            <Button variant="primary" icon="send" className="w-[84px] py-[5px]" onClick={send}>
              Send
            </Button>
          </ShortcutTip>
        )}
      </div>

      {/* Split */}
      <div ref={splitRef} className={cx('flex min-h-0 flex-1', wide ? 'flex-row' : 'flex-col')}>
        {requestHidden && (
          <ShortcutTip label="Show request pane" shortcut={paneShortcut}>
            <button
              type="button"
              aria-label="Show request pane"
              className={cx(
                'flex shrink-0 items-center justify-center gap-1.5 text-[12px] text-muted hover:bg-[var(--or-soft)] hover:text-fg',
                wide ? 'w-7 flex-col py-2 [writing-mode:vertical-rl]' : 'h-7 px-3',
              )}
              onClick={toggleRequestPane}
            >
              <Icon name={wide ? 'panelLeft' : 'panelTop'} />
              Request
            </button>
          </ShortcutTip>
        )}
        <section
          className="flex min-h-0 min-w-0 flex-col"
          style={requestHidden ? { display: 'none' } : { flexBasis: pct, flexGrow: 0, flexShrink: 0 }}
        >
          <Tabs
            className="px-3"
            items={tabs}
            active={tab}
            onChange={setTab}
            right={
              <ShortcutTip label="Hide request pane" shortcut={paneShortcut}>
                <button
                  type="button"
                  aria-label="Hide request pane"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-[var(--or-soft-strong)] hover:text-fg"
                  onClick={toggleRequestPane}
                >
                  <Icon name={wide ? 'panelLeft' : 'panelTop'} />
                </button>
              </ShortcutTip>
            }
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2">
            {tab === 'params' && (
              <KeyValueTable rows={request.params} variables={context.variables} onChange={(params) => update({ params })} keyPlaceholder="Parameter" />
            )}
            {tab === 'headers' && (
              <KeyValueTable rows={request.headers} variables={context.variables} onChange={(headers) => update({ headers })} keyPlaceholder="Header" />
            )}
            {tab === 'body' && ws && (
              <WsComposer
                value={request.body}
                variables={context.variables}
                onChange={(body) => update({ body })}
                canSend={wsStatus === 'open'}
                onSend={sendWsMessage}
                sendShortcut={shortcutLabel(context.settings.shortcuts.send)}
              />
            )}
            {tab === 'body' && !ws && (
              <BodyEditor
                value={request.body}
                variables={context.variables}
                method={request.method}
                starters={bodyStarters}
                jsonKeys={jsonKeys}
                collapseStringsOver={context.settings.collapseLongStrings ? context.settings.collapseStringsOver : undefined}
                onChange={(body) => update({ body })}
              />
            )}
            {tab === 'auth' && (
              <AuthEditor
                value={request.auth}
                variables={context.variables}
                onChange={(auth) => update({ auth })}
                allowInherit
                inherited={{ auth: context.inheritedAuth, source: context.inheritedAuthSource }}
              />
            )}
            {tab === 'docs' && (
              <textarea
                className="ctl min-h-[160px] w-full flex-1 resize-none font-mono text-[12px] leading-5"
                placeholder="Describe this endpoint (Markdown)…"
                value={request.docs ?? ''}
                onChange={(e) => update({ docs: e.target.value === '' ? undefined : e.target.value })}
              />
            )}
          </div>
        </section>

        <div
          role="separator"
          aria-orientation={wide ? 'vertical' : 'horizontal'}
          title="Drag to resize · double-click to reset"
          onPointerDown={onDividerDown}
          onDoubleClick={() => {
            setRatio(0.5);
            setRequestHidden(false);
          }}
          className={cx(
            'group relative shrink-0 bg-[var(--or-line)]',
            wide ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
          )}
        >
          <div className={cx('absolute z-10 group-hover:bg-focus', wide ? '-left-[2px] -right-[2px] inset-y-0' : '-top-[2px] -bottom-[2px] inset-x-0')} />
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {ws ? (
            <WebSocketView
              status={wsStatus}
              events={wsEvents}
              onClear={wsClear}
              onCopy={copy}
              onDisconnect={wsDisconnect}
              fontSize={context.responseFontSize}
              sendShortcut={shortcutLabel(context.settings.shortcuts.send)}
            />
          ) : (
          <ResponseView
            sending={sending !== null}
            startedAt={sending}
            entry={entry}
            history={history}
            method={request.method}
            url={request.url}
            tab={responseTab}
            onTabChange={setResponseTab}
            onSelectHistory={selectHistory}
            onClearHistory={clearHistory}
            onCopy={copy}
            onCancel={cancel}
            onRetry={send}
            fontSize={context.responseFontSize}
            onFontSizeChange={setResponseFontSize}
            sendShortcut={shortcutLabel(context.settings.shortcuts.send)}
            paste={paste}
            onDismissPaste={dismissPaste}
            failure={failure}
          />
          )}
        </section>
      </div>

      {codeOpen && <CodeDrawer request={request} code={code} onClose={() => setCodeOpen(false)} />}
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
