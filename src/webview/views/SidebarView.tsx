import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { SidebarCommand, SidebarItemRef, SidebarState } from '../../shared/protocol';
import { Icon } from '../components/Icon';
import { MenuPopup, MoreMenu, type MenuItem } from '../components/Menu';
import { MethodBadge } from '../components/MethodBadge';
import { folderMenuItems, requestMenuItems, rootMenuItems } from '../components/requestMenu';
import { pinKey, pinnedRows, prunePins, remapPins, togglePin } from '../lib/pins';
import { ShortcutTip } from '../components/ShortcutTip';
import { Button, Spinner, cx } from '../components/ui';
import { ancestorFolderIds, buildTree, canDrop, dropPlacement, endPlacement, filterTree, flattenTree, matchScore, rowInFolder, type DragItem, type DropPlacement, type TreeRow } from '../lib/tree';
import { DEFAULT_SHORTCUTS } from '../../shared/shortcuts';
import { getState, post, setState as persistState, shortcutLabel, useExtensionMessage, useShortcuts } from '../vscode';

interface Persisted {
  expanded: string[];
  /** Pin keys ("request:<id>" / "folder:<id>"), oldest first. Personal state; never written to YAML. */
  pinned?: string[];
}

const INDENT = 12;
const BASE_PAD = 4;
const AUTO_EXPAND_MS = 600;
const MIN_QUERY = 2;
const rowKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
/** Pinned rows mirror rows of the tree below, so their DOM ids and cursor keys need their own namespace. */
const pinnedRowKey = (r: { kind: string; id: string }) => `pinned-${rowKey(r)}`;
const runCommand = (command: SidebarCommand, item?: SidebarItemRef) => post({ type: 'runCommand', command, item });

interface RowHandlers {
  click(row: TreeRow, e: MouseEvent): void;
  togglePin(row: TreeRow): void;
  menuItems(row: TreeRow): MenuItem[];
  contextMenu(row: TreeRow, e: MouseEvent): void;
  dragStart(row: TreeRow, e: DragEvent): void;
  dragOver(row: TreeRow, e: DragEvent): void;
  drop(row: TreeRow, e: DragEvent): void;
  dragEnd(): void;
}

function PinButton({ name, pinned, onToggle }: { name: string; pinned: boolean; onToggle: () => void }) {
  const label = `${pinned ? 'Unpin' : 'Pin'} ${name}`;
  return (
    <button
      type="button"
      className={cx('sb-action', pinned && 'is-pinned')}
      title={label}
      aria-label={label}
      aria-pressed={pinned}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name={pinned ? 'pinOff' : 'pin'} size={13} />
    </button>
  );
}

const Row = memo(function Row({
  row,
  selected,
  dirty,
  pinned,
  inPinnedSection = false,
  dragging,
  inDropBlock,
  isDropTarget,
  dropLine,
  contextOpen,
  handlers,
}: {
  row: TreeRow;
  selected: boolean;
  dirty: boolean;
  pinned: boolean;
  /** Rendered in the "Pinned" shortcut section: no drag & drop, no twistie, clicking a folder reveals it. */
  inPinnedSection?: boolean;
  dragging: boolean;
  inDropBlock: boolean;
  isDropTarget: boolean;
  /** Insertion line while reordering by drag & drop. */
  dropLine?: 'before' | 'after';
  /** Its right-click menu is open. */
  contextOpen: boolean;
  handlers: RowHandlers;
}) {
  const key = inPinnedSection ? pinnedRowKey(row) : rowKey(row);
  const [menuOpen, setMenuOpen] = useState(false);
  const pin = useMemo(() => ({ pinned, toggle: () => handlers.togglePin(row) }), [pinned, row, handlers]);
  const menuItems = useMemo(
    () => (row.kind === 'request' ? requestMenuItems(row.id, pin) : folderMenuItems(row.id, pin)),
    [row.kind, row.id, pin],
  );
  const context = JSON.stringify({ webviewSection: row.kind, kind: row.kind, id: row.id, preventDefaultContextMenuItems: true });
  const guides = [];
  for (let i = 0; i < row.depth; i++) guides.push(<span key={i} className="sb-guide" style={{ left: BASE_PAD + i * INDENT + 7 }} />);

  return (
    <div
      id={`sb-row-${key}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.kind === 'folder' ? row.expanded : undefined}
      data-vscode-context={context}
      draggable={!inPinnedSection}
      title={row.kind === 'request' ? `${row.method} ${row.url}` : row.id}
      className={cx(
        'sb-row',
        selected && 'is-selected is-focused',
        dragging && 'is-dragging',
        inDropBlock && 'is-drop',
        isDropTarget && 'is-drop-target',
        dropLine === 'before' && 'is-drop-before',
        dropLine === 'after' && 'is-drop-after',
        (menuOpen || contextOpen) && 'is-menu-open',
      )}
      style={{ paddingLeft: BASE_PAD + row.depth * INDENT, ['--sb-indent' as string]: `${BASE_PAD + row.depth * INDENT + 16}px` }}
      onClick={(e) => handlers.click(row, e)}
      onContextMenu={(e) => handlers.contextMenu(row, e)}
      onDragStart={(e) => handlers.dragStart(row, e)}
      onDragOver={(e) => handlers.dragOver(row, e)}
      onDrop={(e) => handlers.drop(row, e)}
      onDragEnd={handlers.dragEnd}
    >
      {guides}
      {row.kind === 'folder' ? (
        <>
          <span className="sb-twistie">{row.hasChildren && <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={14} />}</span>
          <Icon name={row.expanded ? 'folderOpen' : 'folder'} size={14} className="mr-1.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
          {pinned && !inPinnedSection && <Icon name="pin" size={11} className="sb-pin-mark" />}
          <span className="sb-count ml-1.5 shrink-0 text-[10.5px] text-muted tabular-nums">{row.count}</span>
          <span className="sb-actions">
            <button
              type="button"
              className="sb-action"
              title={`New Request in ${row.name}`}
              aria-label={`New Request in ${row.name}`}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                post({ type: 'newRequest', folderId: row.id });
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              className="sb-action"
              title="New Folder"
              aria-label={`New Folder in ${row.name}`}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                runCommand('newFolder', { kind: 'folder', id: row.id });
              }}
            >
              <Icon name="newFolder" size={14} />
            </button>
            <PinButton name={row.name} pinned={pinned} onToggle={() => handlers.togglePin(row)} />
            <MoreMenu items={menuItems} title={`More actions for ${row.name}`} buttonClassName="sb-action" onOpenChange={setMenuOpen} />
          </span>
        </>
      ) : (
        <>
          <span className="sb-twistie" />
          <MethodBadge method={row.method} size="sm" />
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          {pinned && !inPinnedSection && <Icon name="pin" size={11} className="sb-pin-mark" />}
          {dirty && <span className="sb-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
          <span className="sb-actions">
            <PinButton name={row.name} pinned={pinned} onToggle={() => handlers.togglePin(row)} />
            <MoreMenu items={menuItems} title={`More actions for ${row.name}`} buttonClassName="sb-action" onOpenChange={setMenuOpen} />
          </span>
        </>
      )}
    </div>
  );
});

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2.5 px-5 py-3 text-[13px] leading-[1.5]">{children}</div>;
}

export function SidebarView() {
  const persisted = useMemo(() => getState<Persisted>(), []);
  const [state, setSidebar] = useState<SidebarState | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(persisted?.expanded ?? []));
  const [pins, setPins] = useState<readonly string[]>(() => persisted?.pinned ?? []);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<{ key: string; where: 'before' | 'after' } | null>(null);
  /** Right-click menu; `key` is the row it belongs to ("" = empty space). */
  const [contextMenu, setContextMenu] = useState<{ key: string; x: number; y: number; items: MenuItem[] } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const seededExpansion = useRef(persisted?.expanded !== undefined);

  const closeContextMenu = useCallback((refocus: boolean) => {
    setContextMenu(null);
    if (refocus) treeRef.current?.focus();
  }, []);

  const filterRef = useRef<HTMLInputElement>(null);
  const focusFilter = useCallback(() => {
    filterRef.current?.focus();
    filterRef.current?.select();
  }, []);

  useExtensionMessage((msg) => {
    if (msg.type === 'sidebar') setSidebar(msg.state);
    else if (msg.type === 'focusFilter') focusFilter();
  });
  useEffect(() => post({ type: 'ready' }), []);

  // The search shortcut anywhere in the view, or "/" from the tree, jumps to the filter.
  // A custom send shortcut sends the open request (the default one is a VS Code keybinding already).
  const shortcuts = state?.settings.shortcuts ?? DEFAULT_SHORTCUTS;
  useShortcuts(shortcuts, {
    focusFilter,
    ...(shortcuts.send !== DEFAULT_SHORTCUTS.send && { send: () => post({ type: 'runCommand', command: 'sendRequest' }) }),
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      focusFilter();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusFilter]);

  const tree = state?.tree ?? null;
  const root = useMemo(() => (tree ? buildTree(tree.folders, tree.requests) : null), [tree?.folders, tree?.requests]); // eslint-disable-line react-hooks/exhaustive-deps
  // Filtering starts at MIN_QUERY characters so a single keystroke doesn't collapse the tree.
  const q = query.trim().length >= MIN_QUERY ? query.trim() : '';
  const filtered = useMemo(() => (root ? filterTree(root, q) : null), [root, q]);
  const rows = useMemo(() => (filtered ? flattenTree(filtered, q ? () => true : (id) => expanded.has(id)) : []), [filtered, q, expanded]);
  const dirtySet = useMemo(() => new Set(state?.dirtyRequestIds ?? []), [state?.dirtyRequestIds]);

  // First load without persisted state: expand top-level folders.
  useEffect(() => {
    if (!root || seededExpansion.current) return;
    seededExpansion.current = true;
    setExpanded(new Set(root.folders.map((f) => f.id)));
  }, [root]);

  useEffect(() => persistState<Persisted>({ expanded: [...expanded], pinned: [...pins] }), [expanded, pins]);

  // Pins of deleted or renamed items would point at nothing; drop them as soon as the tree says so.
  useEffect(() => {
    if (tree) setPins((p) => prunePins(p, tree.folders, tree.requests));
  }, [tree]);

  const pinSet = useMemo(() => new Set(pins), [pins]);
  const pinRows = useMemo(() => (root ? pinnedRows(root, pins) : []), [root, pins]);
  const isPinned = useCallback((row: TreeRow) => pinSet.has(pinKey(row.kind, row.id)), [pinSet]);
  const toggleItemPin = useCallback((row: Pick<TreeRow, 'kind' | 'id'>) => setPins((p) => togglePin(p, pinKey(row.kind, row.id))), []);

  /** Pinned section: open the request, or jump to the folder's real row in the tree. */
  const revealPinned = useCallback(
    (row: TreeRow) => {
      if (row.kind === 'request') {
        post({ type: 'openRequest', id: row.id });
        return;
      }
      const need = ancestorFolderIds(row.id, true);
      setExpanded((set) => new Set([...set, ...need]));
      setCursor(rowKey(row));
      treeRef.current?.focus();
    },
    [],
  );

  // Follow the active editor: select it and reveal its folder.
  const activeId = state?.activeRequestId ?? null;
  useEffect(() => {
    if (!activeId || !tree) return;
    const req = tree.requests.find((r) => r.id === activeId);
    if (!req) return;
    setCursor(rowKey({ kind: 'request', id: activeId }));
    const need = ancestorFolderIds(req.folderId, true);
    setExpanded((s) => (need.every((id) => s.has(id)) ? s : new Set([...s, ...need])));
  }, [activeId, tree]);

  useEffect(() => {
    if (cursor) document.getElementById(`sb-row-${cursor}`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const toggle = useCallback((id: string, open?: boolean) => {
    setExpanded((s) => {
      const isOpen = s.has(id);
      const want = open ?? !isOpen;
      if (want === isOpen) return s;
      const n = new Set(s);
      if (want) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);

  const activate = useCallback(
    (row: TreeRow) => {
      if (row.kind === 'request') post({ type: 'openRequest', id: row.id });
      else if (!q) toggle(row.id);
    },
    [q, toggle],
  );

  // ---------- drag & drop ----------
  const dragRef = useRef<DragItem | null>(null);
  const placementRef = useRef<DropPlacement | null>(null);
  const hoverTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current.timer);
    hoverTimer.current = null;
  };
  const endDrag = useCallback(() => {
    clearHoverTimer();
    dragRef.current = null;
    placementRef.current = null;
    setDrag(null);
    setDropTarget(null);
    setDropLine(null);
  }, []);

  const overTarget = useCallback(
    (target: string, e: DragEvent, expandFolder?: { id: string; expanded: boolean }) => {
      const item = dragRef.current;
      if (!item) return;
      e.stopPropagation();
      if (!canDrop(item, target)) {
        e.dataTransfer.dropEffect = 'none';
        setDropTarget(null);
        clearHoverTimer();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(target);
      if (expandFolder && !expandFolder.expanded) {
        if (hoverTimer.current?.id !== expandFolder.id) {
          clearHoverTimer();
          const id = expandFolder.id;
          hoverTimer.current = { id, timer: setTimeout(() => toggle(id, true), AUTO_EXPAND_MS) };
        }
      } else {
        clearHoverTimer();
      }
    },
    [toggle],
  );

  /** Moves the dragged item into `target`, in front of `before` (null = at the end). `reorder`: a line drop, same folder allowed. */
  const dropOn = useCallback(
    (target: string, e: DragEvent, before: string | null = null, reorder = false) => {
      const item = dragRef.current;
      e.preventDefault();
      e.stopPropagation();
      if (item && (reorder || canDrop(item, target))) {
        post({ type: 'moveItem', item: { kind: item.kind, id: item.id }, targetFolderId: target, before });
        if (target && !reorder) toggle(target, true);
        if (item.kind === 'folder' && item.parentId !== target) {
          // Folder ids are paths: carry expansion state over to the new location.
          const newId = (target ? `${target}/` : '') + item.id.slice(item.id.lastIndexOf('/') + 1);
          const prefix = `${item.id}/`;
          setExpanded((s) => {
            const n = new Set<string>();
            for (const id of s) n.add(id === item.id ? newId : id.startsWith(prefix) ? newId + id.slice(item.id.length) : id);
            return n;
          });
          setPins((p) => remapPins(p, item.id, newId));
          setCursor(rowKey({ kind: 'folder', id: newId }));
        }
      }
      endDrag();
    },
    [endDrag, toggle],
  );

  const rowMenuItems = useCallback(
    (row: TreeRow): MenuItem[] => {
      const pin = { pinned: isPinned(row), toggle: () => toggleItemPin(row) };
      return row.kind === 'request' ? requestMenuItems(row.id, pin) : folderMenuItems(row.id, pin);
    },
    [isPinned, toggleItemPin],
  );

  const handlersRef = useRef<RowHandlers>(null as unknown as RowHandlers);
  handlersRef.current = {
    click: (row, e) => {
      setCursor(rowKey(row));
      // Clicking the twistie area of a folder or the row itself both toggle; requests open.
      void e;
      activate(row);
    },
    togglePin: (row) => toggleItemPin(row),
    menuItems: (row) => rowMenuItems(row),
    contextMenu: (row, e) => {
      e.preventDefault();
      e.stopPropagation();
      setCursor(rowKey(row));
      setContextMenu({ key: rowKey(row), x: e.clientX, y: e.clientY, items: rowMenuItems(row) });
    },
    dragStart: (row, e) => {
      const item: DragItem = { kind: row.kind, id: row.id, parentId: row.parentId };
      dragRef.current = item;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.id);
      // Defer so the browser snapshots the undimmed row as the drag image.
      requestAnimationFrame(() => setDrag(item));
    },
    dragOver: (row, e) => {
      const item = dragRef.current;
      if (!item || !root) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const placement = dropPlacement(root, item, row, (e.clientY - rect.top) / Math.max(rect.height, 1));
      placementRef.current = placement;
      if (placement?.line) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        clearHoverTimer();
        setDropTarget(null);
        const next = { key: rowKey(row), where: placement.line };
        setDropLine((cur) => (cur?.key === next.key && cur.where === next.where ? cur : next));
        return;
      }
      setDropLine(null);
      if (!placement) {
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'none';
        setDropTarget(null);
        clearHoverTimer();
        return;
      }
      if (row.kind === 'folder' && placement.folderId === row.id) overTarget(row.id, e, { id: row.id, expanded: row.expanded });
      else overTarget(placement.folderId, e);
    },
    drop: (row, e) => {
      const placement = placementRef.current;
      if (placement?.line) dropOn(placement.folderId, e, placement.before, true);
      else dropOn(placement ? placement.folderId : row.kind === 'folder' ? row.id : row.parentId, e);
    },
    dragEnd: endDrag,
  };
  // Stable identity so memoized rows don't re-render on unrelated state changes.
  const handlers = useMemo<RowHandlers>(
    () => ({
      click: (r, e) => handlersRef.current.click(r, e),
      togglePin: (r) => handlersRef.current.togglePin(r),
      menuItems: (r) => handlersRef.current.menuItems(r),
      contextMenu: (r, e) => handlersRef.current.contextMenu(r, e),
      dragStart: (r, e) => handlersRef.current.dragStart(r, e),
      dragOver: (r, e) => handlersRef.current.dragOver(r, e),
      drop: (r, e) => handlersRef.current.drop(r, e),
      dragEnd: () => handlersRef.current.dragEnd(),
    }),
    [],
  );

  const pinnedHandlers = useMemo<RowHandlers>(
    () => ({
      click: (r) => revealPinned(r),
      togglePin: (r) => handlersRef.current.togglePin(r),
      menuItems: (r) => handlersRef.current.menuItems(r),
      contextMenu: (r, e) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ key: pinnedRowKey(r), x: e.clientX, y: e.clientY, items: handlersRef.current.menuItems(r) });
      },
      dragStart: () => {},
      dragOver: () => {},
      drop: () => {},
      dragEnd: () => {},
    }),
    [revealPinned],
  );

  // ---------- keyboard ----------
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    let idx = cursor ? rows.findIndex((r) => rowKey(r) === cursor) : -1;
    const row = idx >= 0 ? rows[idx] : undefined;
    const move = (i: number) => setCursor(rowKey(rows[Math.max(0, Math.min(rows.length - 1, i))]));
    switch (e.key) {
      case 'ArrowDown':
        move(idx + 1);
        break;
      case 'ArrowUp':
        move(idx < 0 ? rows.length - 1 : idx - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row?.kind === 'folder') {
          if (!row.expanded) toggle(row.id, true);
          else if (rows[idx + 1]?.depth === row.depth + 1) move(idx + 1);
        }
        break;
      case 'ArrowLeft':
        if (row?.kind === 'folder' && row.expanded && !q) toggle(row.id, false);
        else if (row && row.parentId) {
          idx = rows.findIndex((r) => r.kind === 'folder' && r.id === row.parentId);
          if (idx >= 0) move(idx);
        }
        break;
      case 'Enter':
      case ' ':
        // Cmd/Ctrl+Enter is VS Code's "Send Request" for the open editor.
        if (e.metaKey || e.ctrlKey) return;
        if (row) activate(row);
        break;
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return;
        const rect = row && document.getElementById(`sb-row-${rowKey(row)}`)?.getBoundingClientRect();
        if (row && rect) {
          setContextMenu({ key: rowKey(row), x: rect.left + 24, y: rect.bottom, items: rowMenuItems(row) });
        }
        break;
      }
      case 'F2':
        if (row) runCommand('renameItem', { kind: row.kind, id: row.id });
        break;
      case 'Delete':
      case 'Backspace':
        if (row && (e.key === 'Delete' || e.metaKey || e.ctrlKey)) runCommand('deleteItem', { kind: row.kind, id: row.id });
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // ---------- render ----------
  if (!state) return <div className="sb h-full" />;

  const rootContext = JSON.stringify({ preventDefaultContextMenuItems: true });

  if (!state.hasWorkspace) {
    return (
      <div className="sb h-full" data-vscode-context={rootContext}>
        <EmptyState>
          <p>Open a folder to use On Route.</p>
        </EmptyState>
      </div>
    );
  }

  if (!state.initialized || !tree) {
    return (
      <div className="sb h-full" data-vscode-context={rootContext}>
        <EmptyState>
          <p>On Route stores API requests as YAML files in this workspace, so they can be reviewed and shared with git.</p>
          <Button variant="primary" className="w-full" onClick={() => runCommand('init')}>
            Initialize On Route
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => runCommand('importPostman')}>
            Import Postman Collection
          </Button>
        </EmptyState>
      </div>
    );
  }

  const errorCount = tree.errors.length;
  const isEmpty = tree.requests.length === 0 && tree.folders.length === 0;
  const showRootZone = drag !== null && drag.parentId !== '';

  return (
    <div className="sb flex h-full flex-col" data-vscode-context={rootContext}>
      <div className="shrink-0 px-2.5 pb-2 pt-2.5">
        <label className="sb-filter">
          <Icon name="search" size={13} className="shrink-0 opacity-60" />
          <input
            ref={filterRef}
            placeholder="Filter endpoints"
            aria-label="Filter endpoints"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
              else if (e.key === 'ArrowDown' && rows.length) {
                e.preventDefault();
                setCursor(rowKey(rows[0]));
                treeRef.current?.focus();
              } else if (e.key === 'Enter' && rows.length) {
                // Best match, not the first row: a subfolder's weaker hit can be listed above it.
                let best: TreeRow | undefined;
                let bestScore = -1;
                for (const r of rows) {
                  if (r.kind !== 'request') continue;
                  const s = q ? matchScore(q, r) : 0;
                  if (s > bestScore) [best, bestScore] = [r, s];
                }
                if (best) post({ type: 'openRequest', id: best.id });
              }
            }}
          />
          {query ? (
            <button type="button" className="sb-action h-5 w-5" title="Clear filter" aria-label="Clear filter" onClick={() => setQuery('')}>
              <Icon name="x" size={12} />
            </button>
          ) : (
            <ShortcutTip label="Filter endpoints · click to change the shortcut" shortcut={shortcutLabel(shortcuts.focusFilter)}>
              <button
                type="button"
                className="sb-kbd"
                aria-label="Change the search shortcut"
                // Keep the click from focusing the filter (the label wraps it).
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.preventDefault();
                  post({ type: 'openSettings' });
                }}
              >
                {shortcutLabel(shortcuts.focusFilter)}
              </button>
            </ShortcutTip>
          )}
        </label>
      </div>

      {state.scanning && !isEmpty && (
        <div className="mx-2.5 mb-2 flex shrink-0 items-center gap-2 text-[12px] text-muted" role="status">
          <Spinner className="h-3 w-3 border-[1.5px]" /> Scanning for new endpoints…
        </div>
      )}

      {errorCount > 0 && (
        <button type="button" className="sb-warning shrink-0" onClick={() => runCommand('openOverview')} title="Show problems in the overview">
          <Icon name="warning" size={14} className="shrink-0" />
          <span className="truncate">
            {errorCount} {errorCount === 1 ? 'file' : 'files'} failed to parse
          </span>
        </button>
      )}

      {isEmpty ? (
        <EmptyState>
          <p>No requests yet. Scan your code to add its routes, or start from scratch.</p>
          <Button variant="primary" className="w-full" icon="radar" disabled={state.scanning} onClick={() => runCommand('scanProject')}>
            {state.scanning ? 'Scanning…' : 'Scan project'}
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => post({ type: 'newRequest', folderId: '' })}>
            New Request
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => runCommand('importCurl')}>
            Import from cURL
          </Button>
        </EmptyState>
      ) : (
        <>
          {pinRows.length > 0 && (
            <div className="sb-pinned shrink-0">
              <button
                type="button"
                className="sb-section"
                aria-expanded={pinnedOpen}
                onClick={() => setPinnedOpen((o) => !o)}
                title={pinnedOpen ? 'Collapse pinned' : 'Expand pinned'}
              >
                <Icon name={pinnedOpen ? 'chevronDown' : 'chevronRight'} size={12} className="shrink-0 opacity-70" />
                <span className="flex-1 text-left">Pinned</span>
                <span className="sb-count shrink-0 text-[10.5px] tabular-nums">{pinRows.length}</span>
              </button>
              {pinnedOpen && (
                <div role="tree" aria-label="Pinned" className="sb-tree max-h-[35vh] overflow-y-auto overflow-x-hidden px-0 pb-1">
                  {pinRows.map((row) => {
                    const key = pinnedRowKey(row);
                    return (
                      <Row
                        key={key}
                        row={row}
                        inPinnedSection
                        pinned
                        selected={false}
                        dirty={row.kind === 'request' && dirtySet.has(row.id)}
                        dragging={false}
                        inDropBlock={false}
                        isDropTarget={false}
                        contextOpen={contextMenu?.key === key}
                        handlers={pinnedHandlers}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {showRootZone && (
            <div
              className={cx('sb-rootzone shrink-0', dropTarget === '' && 'is-over')}
              onDragOver={(e) => overTarget('', e)}
              onDrop={(e) => dropOn('', e)}
            >
              <Icon name="chevronDown" size={12} className="rotate-180" /> Move to top level
            </div>
          )}
          <div
            ref={treeRef}
            role="tree"
            aria-label="Requests"
            tabIndex={0}
            aria-activedescendant={cursor ? `sb-row-${cursor}` : undefined}
            className={cx('sb-tree min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4', dropTarget === '' && 'sb-drop-root')}
            onKeyDown={onTreeKey}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ key: '', x: e.clientX, y: e.clientY, items: rootMenuItems() });
            }}
            onDragOver={(e) => {
              // Empty space below the rows: move to the end of the top level (or reorder there).
              const item = dragRef.current;
              setDropLine(null);
              clearHoverTimer();
              const placement = item && root ? endPlacement(root, item) : null;
              placementRef.current = placement;
              if (!placement) {
                if (item) e.dataTransfer.dropEffect = 'none';
                setDropTarget(null);
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropTarget('');
            }}
            onDrop={(e) => {
              const placement = placementRef.current;
              if (placement) dropOn('', e, null, !!placement.line);
              else endDrag();
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDropTarget(null);
                setDropLine(null);
                clearHoverTimer();
              }
            }}
          >
            {rows.length === 0 ? (
              <div className="px-5 py-2 text-muted">No endpoints match “{q}”.</div>
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                return (
                  <Row
                    key={key}
                    row={row}
                    selected={cursor === key}
                    dirty={row.kind === 'request' && dirtySet.has(row.id)}
                    pinned={isPinned(row)}
                    dragging={drag !== null && drag.kind === row.kind && drag.id === row.id}
                    inDropBlock={dropTarget !== null && dropTarget !== '' && rowInFolder(row, dropTarget)}
                    isDropTarget={dropTarget !== null && dropTarget !== '' && row.kind === 'folder' && row.id === dropTarget}
                    contextOpen={contextMenu?.key === key}
                    dropLine={dropLine?.key === key ? dropLine.where : undefined}
                    handlers={handlers}
                  />
                );
              })
            )}
          </div>
          {contextMenu && <MenuPopup items={contextMenu.items} x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} />}
        </>
      )}
    </div>
  );
}
