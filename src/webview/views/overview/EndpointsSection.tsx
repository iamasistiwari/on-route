import { memo, useMemo, useState } from 'react';
import type { ProjectTree, RequestSummary, Variable } from '../../../shared/model';
import { buildTree, filterTree, type FolderNode } from '../../lib/tree';
import { AuthEditor } from '../../components/AuthEditor';
import { Icon } from '../../components/Icon';
import { KeyValueTable } from '../../components/KeyValueTable';
import { MoreMenu, useContextMenu } from '../../components/Menu';
import { MethodBadge } from '../../components/MethodBadge';
import { folderMenuItems, requestMenuItems } from '../../components/requestMenu';
import { Button, IconButton, cx } from '../../components/ui';
import { post } from '../../vscode';
import { SaveActions, Section } from './Section';
import { useDraft } from './useDraft';

const FolderSettings = memo(function FolderSettings({ node }: { node: FolderNode }) {
  const source = useMemo(
    () => node.def ?? { id: node.id, name: node.name, auth: { type: 'inherit' as const }, variables: [] as Variable[] },
    [node.def, node.id, node.name],
  );
  const { draft, setDraft, dirty, reset } = useDraft(source);
  return (
    <div className="my-1 ml-6 rounded-xl border border-[var(--or-line)] bg-sidebar p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold">Folder settings · {node.id}</span>
        <div className="flex items-center gap-2">
          <SaveActions dirty={dirty} onReset={reset} onSave={() => post({ type: 'saveFolder', folder: draft })} />
        </div>
      </div>
      <div className="mb-1 text-[12px] font-semibold text-muted">Authorization</div>
      <AuthEditor value={draft.auth} onChange={(auth) => setDraft((d) => ({ ...d, auth }))} allowInherit inheritHint="Uses the parent folder's auth, or the project's." />
      <div className="mb-1 mt-3 text-[12px] font-semibold text-muted">Variables</div>
      <KeyValueTable rows={draft.variables} secretColumn onChange={(variables) => setDraft((d) => ({ ...d, variables }))} keyPlaceholder="Variable" />
    </div>
  );
});

const EndpointRow = memo(function EndpointRow({ request: r, indent }: { request: RequestSummary; indent: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const items = useMemo(() => requestMenuItems(r.id), [r.id]);
  const context = useContextMenu();
  return (
    <li
      className={cx('group flex items-center rounded-lg pr-1 hover:bg-[var(--or-soft)]', (menuOpen || context.isOpen) && 'bg-[var(--or-soft)]')}
      onContextMenu={(e) => context.open(e, items)}
    >
      <button
        type="button"
        onClick={() => post({ type: 'openRequest', id: r.id })}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left"
        style={{ paddingLeft: `${indent}px` }}
        title={r.id}
      >
        <MethodBadge method={r.method} />
        <span className="shrink-0 truncate max-w-[45%]">{r.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{r.url}</span>
      </button>
      <MoreMenu
        items={items}
        title={`More actions for ${r.name}`}
        className={cx('flex', !menuOpen && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}
        onOpenChange={setMenuOpen}
      />
      {context.menu}
    </li>
  );
});

function FolderView({
  node,
  depth,
  collapsed,
  toggle,
  settingsOpen,
  toggleSettings,
  forceOpen,
}: {
  node: FolderNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  settingsOpen: Set<string>;
  toggleSettings: (id: string) => void;
  forceOpen: boolean;
}) {
  const isOpen = forceOpen || !collapsed.has(node.id);
  const indent = { paddingLeft: `${depth * 16 + 4}px` };
  const [menuOpen, setMenuOpen] = useState(false);
  const items = useMemo(() => folderMenuItems(node.id), [node.id]);
  const context = useContextMenu();
  return (
    <li>
      {node.id !== '' && (
        <>
          <div
            className={cx('group flex items-center gap-1 rounded-lg py-0.5 pr-1 hover:bg-[var(--or-soft)]', (menuOpen || context.isOpen) && 'bg-[var(--or-soft)]')}
            style={indent}
            onContextMenu={(e) => context.open(e, items)}
          >
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => toggle(node.id)} aria-expanded={isOpen}>
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} className="shrink-0 text-muted" />
              <Icon name={isOpen ? 'folderOpen' : 'folder'} className="shrink-0 text-muted" />
              <span className="truncate font-medium">{node.name}</span>
              <span className="text-[11px] text-muted">{node.count}</span>
            </button>
            <IconButton
              icon="plus"
              title={`New request in ${node.name}`}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100"
              onClick={() => post({ type: 'newRequest', folderId: node.id })}
            />
            <IconButton
              icon="gear"
              title="Folder settings (auth, variables)"
              active={settingsOpen.has(node.id)}
              className={cx(!settingsOpen.has(node.id) && 'opacity-0 group-hover:opacity-100 focus:opacity-100')}
              onClick={() => toggleSettings(node.id)}
            />
            <MoreMenu
              items={items}
              title={`More actions for ${node.name}`}
              className={cx('flex', !menuOpen && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}
              onOpenChange={setMenuOpen}
            />
            {context.menu}
          </div>
          {settingsOpen.has(node.id) && (
            <div style={indent}>
              <FolderSettings node={node} />
            </div>
          )}
        </>
      )}
      {isOpen && (
        <ul>
          {node.folders.map((f) => (
            <FolderView
              key={f.id}
              node={f}
              depth={node.id === '' ? 0 : depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              settingsOpen={settingsOpen}
              toggleSettings={toggleSettings}
              forceOpen={forceOpen}
            />
          ))}
          {node.requests.map((r) => (
            <EndpointRow key={r.id} request={r} indent={(node.id === '' ? 0 : depth + 1) * 16 + 22} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function EndpointsSection({ tree, scanning }: { tree: ProjectTree; scanning: boolean }) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState<Set<string>>(() => new Set());
  const root = useMemo(() => buildTree(tree.folders, tree.requests), [tree.folders, tree.requests]);
  const filtered = useMemo(() => filterTree(root, query.trim()), [root, query]);

  const toggleIn = (setter: typeof setCollapsed) => (id: string) =>
    setter((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Section
      id="endpoints"
      title="Endpoints"
      description="Click to open. Folder gear sets auth and variables for everything inside."
      actions={
        <>
          <Button variant="secondary" icon="radar" className="py-0.5" disabled={scanning} onClick={() => post({ type: 'runCommand', command: 'scanProject' })}>
            {scanning ? 'Scanning…' : 'Scan project'}
          </Button>
          <Button variant="secondary" icon="plus" className="py-0.5" onClick={() => post({ type: 'newRequest', folderId: '' })}>
            New request
          </Button>
        </>
      }
    >
      <div className="ctl is-pill mb-3 flex items-center gap-2 py-[5px]">
        <Icon name="search" className="text-muted" />
        <input
          className="min-w-0 flex-1 bg-transparent py-[1px] outline-none"
          placeholder="Search by name, URL or method"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          aria-label="Search endpoints"
        />
      </div>
      {tree.requests.length === 0 && tree.folders.length === 0 ? (
        <div className="py-3 text-muted">No requests yet. Scan the project to add its routes, or create a request.</div>
      ) : filtered && (filtered.requests.length > 0 || filtered.folders.length > 0) ? (
        <ul>
          <FolderView
            node={filtered}
            depth={0}
            collapsed={collapsed}
            toggle={toggleIn(setCollapsed)}
            settingsOpen={settingsOpen}
            toggleSettings={toggleIn(setSettingsOpen)}
            forceOpen={query.trim() !== ''}
          />
        </ul>
      ) : (
        <div className="py-3 text-muted">No endpoints match “{query}”.</div>
      )}
    </Section>
  );
}
