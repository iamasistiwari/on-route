import { useEffect, useMemo, useState } from 'react';
import type { HistoryEntry } from '../../shared/model';
import type { OverviewState } from '../../shared/protocol';
import { AuthEditor } from '../components/AuthEditor';
import { Icon, type IconName } from '../components/Icon';
import { KeyValueTable } from '../components/KeyValueTable';
import { Toast, type ToastData } from '../components/Toast';
import { Spinner, cx } from '../components/ui';
import { getState, post, setState as persistState, useExtensionMessage, useShortcuts } from '../vscode';
import { EndpointsSection } from './overview/EndpointsSection';
import { EnvironmentsSection } from './overview/EnvironmentsSection';
import { HistorySection } from './overview/HistorySection';
import { ScanSection } from './overview/ScanSection';
import { SettingsSection } from './overview/SettingsSection';
import { AutoSaveContext, SaveActions, Section } from './overview/Section';
import { useDraft } from './overview/useDraft';

type PageId = 'endpoints' | 'scanning' | 'settings' | 'history' | 'authorization' | 'variables' | 'environments' | 'problems';

const NAV: { id: PageId; label: string; icon: IconName }[] = [
  { id: 'endpoints', label: 'Endpoints', icon: 'endpoints' },
  { id: 'scanning', label: 'Scanning', icon: 'radar' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'authorization', label: 'Authorization', icon: 'key' },
  { id: 'variables', label: 'Variables', icon: 'braces' },
  { id: 'environments', label: 'Environments', icon: 'layers' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
  { id: 'problems', label: 'Problems', icon: 'warning' },
];

interface Persisted {
  page: PageId;
}

function ProjectName({ state }: { state: OverviewState }) {
  const [editing, setEditing] = useState(false);
  const config = state.tree.config;
  if (editing) {
    return (
      <input
        autoFocus
        className="ctl w-full max-w-md text-[17px] font-semibold"
        defaultValue={config.name}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name && name !== config.name) post({ type: 'saveConfig', config: { ...config, name } });
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      title="Click to rename project"
      className="-ml-2 max-w-full truncate rounded-full px-2 text-left text-[17px] font-semibold hover:bg-[var(--or-soft-strong)]"
      onClick={() => setEditing(true)}
    >
      {config.name || 'Untitled project'}
    </button>
  );
}

function AuthSection({ state }: { state: OverviewState }) {
  const config = state.tree.config;
  const { draft, setDraft, dirty, reset } = useDraft(config.auth);
  return (
    <Section
      id="authorization"
      title="Authorization"
      description={
        <>
          Default for every request. Resolution: <b className="font-medium text-fg">request</b> →{' '}
          <b className="font-medium text-fg">folder</b> (innermost first) → <b className="font-medium text-fg">project</b>. Set a request or
          folder to “Inherit” to use this.
        </>
      }
      actions={<SaveActions dirty={dirty} onReset={reset} onSave={() => post({ type: 'saveConfig', config: { ...config, auth: draft } })} />}
    >
      <AuthEditor value={draft} onChange={setDraft} allowInherit={false} />
    </Section>
  );
}

function VariablesSection({ state }: { state: OverviewState }) {
  const config = state.tree.config;
  const { draft, setDraft, dirty, reset } = useDraft(config.variables);
  return (
    <Section
      id="variables"
      title="Variables"
      description={
        <>
          Project variables, overridden by folders, then the environment, then local overrides. Use as{' '}
          <code className="rounded-md bg-code px-1.5 font-mono">{'{{baseUrl}}'}</code>. Locked variables are saved in
          .on_route/variables.local.yaml on this machine and never committed. New variables start locked.
        </>
      }
      actions={<SaveActions dirty={dirty} onReset={reset} onSave={() => post({ type: 'saveConfig', config: { ...config, variables: draft } })} />}
    >
      <KeyValueTable
        rows={draft}
        onChange={setDraft}
        secretColumn
        defaultSecret
        lockTitles={{
          locked: 'Locked: saved in .on_route/variables.local.yaml on this machine and never committed. Click to unlock.',
          unlocked: 'Unlocked: saved in on_route.json and committed to git with its value. Click to lock and keep it out of git.',
        }}
        keyPlaceholder="Variable"
      />
    </Section>
  );
}

export function OverviewView() {
  const persisted = useMemo(() => getState<Persisted>(), []);
  const [state, setState] = useState<OverviewState | null>(null);
  useShortcuts(state?.settings.shortcuts);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [page, setPage] = useState<PageId>(persisted?.page ?? 'endpoints');
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  /** Bytes the history files take on disk, shown on Clear all. */
  const [historyBytes, setHistoryBytes] = useState(0);

  useExtensionMessage((msg) => {
    if (msg.type === 'overview') setState(msg.state);
    else if (msg.type === 'allHistory') {
      setHistory(msg.entries);
      setHistoryBytes(msg.bytes);
    }
    else if (msg.type === 'showPage' && (NAV.some((n) => n.id === msg.page) || msg.page === 'problems')) setPage(msg.page as PageId);
    else if (msg.type === 'error') setToast({ id: Date.now(), message: msg.message, kind: 'error' });
  });
  useEffect(() => {
    post({ type: 'ready' });
    post({ type: 'listAllHistory' });
  }, []);
  useEffect(() => persistState<Persisted>({ page }), [page]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner /> Loading project…
      </div>
    );
  }

  const { tree } = state;
  const hasProblems = tree.errors.length > 0;
  const nav = NAV.filter((n) => n.id !== 'problems' || hasProblems);
  const current: PageId = page === 'problems' && !hasProblems ? 'endpoints' : page;
  const counts: Partial<Record<PageId, number>> = {
    endpoints: tree.requests.length,
    history: history?.length,
    environments: tree.environments.length,
    problems: tree.errors.length,
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav
        className="no-scrollbar flex shrink-0 gap-0.5 overflow-x-auto border-b border-border bg-sidebar px-2 md:w-52 md:flex-col md:gap-1 md:overflow-x-visible md:border-b-0 md:border-r md:px-3 md:py-5"
        aria-label="Overview pages"
        role="tablist"
      >
        <div className="mb-3 hidden px-2.5 text-[12px] font-semibold text-muted md:block">On Route</div>
        {nav.map((n) => {
          const selected = current === n.id;
          const count = counts[n.id];
          return (
            <button
              key={n.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setPage(n.id)}
              className={cx(
                'flex shrink-0 items-center gap-2 whitespace-nowrap text-left',
                // Horizontal tab strip on narrow widths, vertical list on wide.
                'border-b-2 px-2.5 py-2 md:rounded-full md:border-b-0 md:px-3 md:py-[5px]',
                selected
                  ? 'border-tab-border font-medium text-tab-active md:bg-[var(--or-soft-strong)] md:text-fg'
                  : 'border-transparent text-tab-inactive hover:text-fg md:text-fg md:hover:bg-[var(--or-soft)]',
              )}
            >
              <Icon name={n.icon} size={14} className={cx('shrink-0', n.id === 'problems' ? 'text-error' : 'opacity-80')} />
              <span className="flex-1">{n.label}</span>
              {count !== undefined &&
                (n.id === 'problems' ? (
                  <span className="rounded-full bg-error px-1.5 text-[10px] font-semibold leading-4 text-bg">{count}</span>
                ) : (
                  <span className={cx('text-[11px] tabular-nums', selected ? 'opacity-80' : 'text-muted')}>{count}</span>
                ))}
            </button>
          );
        })}
      </nav>

      <div data-overview-scroll className="min-h-0 min-w-0 flex-1 overflow-auto">
        <AutoSaveContext.Provider value={state.settings.autoSave ? state.settings.autoSaveIntervalSeconds : null}>
        {/* History scrolls its own list, so the page itself must not add room below it. */}
        <div className={cx('mx-auto max-w-[900px] px-6 pt-4 md:px-8', current === 'history' ? 'pb-0' : 'pb-24')}>
          {/* Compact project header, shown on every page */}
          <header className="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--or-line)] pb-4">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
              <ProjectName state={state} />
              <div className="flex flex-wrap gap-3 text-[12px] text-muted">
                <span>
                  <b className="font-semibold text-fg">{tree.requests.length}</b> endpoints
                </span>
                <span>
                  <b className="font-semibold text-fg">{tree.folders.length}</b> folders
                </span>
                <span>
                  <b className="font-semibold text-fg">{tree.environments.length}</b> environments
                </span>
                {hasProblems && (
                  <button type="button" className="flex items-center gap-1 text-error hover:underline" onClick={() => setPage('problems')}>
                    <Icon name="warning" size={12} /> {tree.errors.length} {tree.errors.length === 1 ? 'problem' : 'problems'}
                  </button>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-muted">
              Environment
              <select
                className="ctl is-pill cursor-pointer py-[3px] text-fg"
                value={state.activeEnvironment ?? ''}
                onChange={(e) => {
                  const name = e.target.value || null;
                  setState((s) => (s ? { ...s, activeEnvironment: name } : s));
                  post({ type: 'setActiveEnvironment', name });
                }}
              >
                <option value="">No environment</option>
                {tree.environments.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </select>
            </label>
          </header>

          {/* One page at a time. Pages stay mounted (hidden) so unsaved drafts survive switching. */}
          <div hidden={current !== 'endpoints'}>
            <EndpointsSection tree={tree} scanning={state.scan.running} />
          </div>
          <div hidden={current !== 'scanning'}>
            <ScanSection config={tree.config} scan={state.scan} onOpenSettings={() => setPage('settings')} />
          </div>
          <div hidden={current !== 'history'}>
            <HistorySection tree={tree} entries={history} bytes={historyBytes} />
          </div>
          <div hidden={current !== 'authorization'}>
            <AuthSection state={state} />
          </div>
          <div hidden={current !== 'variables'}>
            <VariablesSection state={state} />
          </div>
          <div hidden={current !== 'environments'}>
            <Section
              id="environments"
              title="Environments"
              description="Choose for each environment whether its file is committed to git. Locked variables always stay on this machine."
            >
              <EnvironmentsSection
                environments={tree.environments}
                localOverrides={state.localOverrides}
                trackedEnvironments={state.trackedEnvironments}
                activeEnvironment={state.activeEnvironment}
                projectVariables={tree.config.variables}
              />
            </Section>
          </div>
          <div hidden={current !== 'settings'}>
            <SettingsSection config={tree.config} settings={state.settings} />
          </div>
          {hasProblems && current === 'problems' && (
            <Section id="problems" title="Problems" description="These files could not be loaded and were skipped.">
              <ul className="space-y-1.5">
                {tree.errors.map((err, i) => (
                  <li key={i} className="flex items-start gap-2.5 rounded-xl border border-[var(--or-line)] px-3.5 py-2.5">
                    <Icon name="warning" className="mt-0.5 shrink-0 text-error" />
                    <div className="min-w-0">
                      <div className="font-mono text-[12px]">
                        {err.file}
                        {err.line !== undefined && <span className="text-muted">:{err.line}</span>}
                      </div>
                      <div className="text-[12px] text-muted break-words">{err.message}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
        </AutoSaveContext.Provider>
      </div>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
