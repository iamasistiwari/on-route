import { useEffect, useMemo, useState } from 'react';
import type { Environment, Variable } from '../../../shared/model';
import { Icon } from '../../components/Icon';
import { KeyValueTable } from '../../components/KeyValueTable';
import { Button, Switch, cx } from '../../components/ui';
import { mergeScopes } from '../../lib/vars';
import { post } from '../../vscode';
import { SaveActions } from './Section';
import { useDraft } from './useDraft';

/**
 * One list for the editor: variables from environments/<name>.yaml (unlocked) and <name>.local.yaml (locked).
 * A local value for a key that is also in the committed file wins, and the row counts as locked.
 */
function editorRows(env: Environment, local: Variable[]): Variable[] {
  const localByKey = new Map(local.map((v) => [v.key, v]));
  const rows: Variable[] = [];
  for (const v of env.variables) {
    const l = localByKey.get(v.key);
    if (l) {
      rows.push({ ...v, ...l, secret: true });
      localByKey.delete(v.key);
    } else {
      rows.push({ ...v });
    }
  }
  for (const l of localByKey.values()) rows.push({ ...l, secret: true });
  return rows;
}

function EnvironmentEditor({
  env,
  local,
  tracked,
  projectVariables,
  hidden,
  onDirty,
}: {
  env: Environment;
  local: Variable[];
  /** environments/<name>.yaml is tracked by git. */
  tracked: boolean;
  projectVariables: Variable[];
  hidden: boolean;
  onDirty: (name: string, dirty: boolean) => void;
}) {
  const source = useMemo(() => ({ commit: !!env.commit, variables: editorRows(env, local) }), [env, local]);
  const { draft, setDraft, dirty, reset } = useDraft(source);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => onDirty(env.name, dirty), [env.name, dirty, onDirty]);

  const file = `environments/${env.name}.yaml`;
  const localFile = `environments/${env.name}.local.yaml`;

  const resolved = useMemo(
    () =>
      previewOpen
        ? mergeScopes([
            { name: 'project', variables: projectVariables },
            { name: env.name, variables: draft.variables },
          ])
        : [],
    [previewOpen, projectVariables, draft, env.name],
  );

  if (hidden) return null;

  const save = () =>
    post({
      type: 'saveEnvironment',
      environment: { name: env.name, commit: draft.commit, variables: draft.variables.filter((v) => !v.secret) },
      localOverrides: draft.variables.filter((v) => v.secret).map((v) => ({ ...v, secret: true })),
    });

  const commitTitle = draft.commit
    ? `On: ${file} is committed with its unlocked variables and their values. Locked variables stay in ${localFile} and are never committed.`
    : `Off: ${file} stays on this machine. It is listed in .on_route/.gitignore and never committed.`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2.5" title={commitTitle}>
          <Switch checked={draft.commit} label="Commit to git" onChange={(commit) => setDraft((d) => ({ ...d, commit }))} />
          <span className="min-w-0">
            <span className="block font-medium">Commit to git</span>
            <span className="block text-[12px] text-muted">{draft.commit ? `${file} is committed` : `${file} stays on this machine`}</span>
          </span>
        </label>
        <div className="flex items-center gap-2">
          {confirmDelete ? (
            <>
              <span className="text-[12px] text-error">Delete “{env.name}”?</span>
              <Button
                variant="secondary"
                className="py-0.5 text-error"
                onClick={() => {
                  post({ type: 'deleteEnvironment', name: env.name });
                  setConfirmDelete(false);
                }}
              >
                Delete
              </Button>
              <Button variant="ghost" className="py-0.5" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" icon="trash" className="py-0.5 text-muted" onClick={() => setConfirmDelete(true)}>
              Delete environment
            </Button>
          )}
          <SaveActions dirty={dirty} onReset={reset} onSave={save} />
        </div>
      </div>

      {!env.commit && tracked && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-banner-border bg-banner px-3.5 py-2 text-[12px]">
          <Icon name="warning" className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{file} is already tracked by git, so its changes are still committed until you stop tracking it.</span>
          <Button variant="secondary" className="py-0.5" onClick={() => post({ type: 'untrackEnvironment', name: env.name })}>
            Stop tracking
          </Button>
        </div>
      )}

      <div>
        <p className="mb-2 text-[12px] text-muted">
          Unlocked variables are saved in {file}. Locked variables are saved in {localFile} on this machine and never committed. New variables start locked.
        </p>
        <KeyValueTable
          rows={draft.variables}
          secretColumn
          defaultSecret
          lockTitles={{
            locked: `Locked: saved in ${localFile} on this machine and never committed. Click to unlock.`,
            unlocked: `Unlocked: saved in ${file}${draft.commit ? ', which is committed to git with this value' : ''}. Click to lock and keep it out of git.`,
          }}
          keyPlaceholder="Variable"
          onChange={(variables) => setDraft((d) => ({ ...d, variables }))}
        />
      </div>

      <div className="rounded-xl border border-[var(--or-line)]">
        <button
          type="button"
          className="flex w-full items-center gap-1 rounded-xl px-2.5 py-2 text-left hover:bg-[var(--or-soft)]"
          onClick={() => setPreviewOpen((o) => !o)}
          aria-expanded={previewOpen}
        >
          <Icon name={previewOpen ? 'chevronDown' : 'chevronRight'} className="text-muted" />
          <span className="font-medium">Resolved preview</span>
          <span className="text-[12px] text-muted">project, then {env.name}</span>
        </button>
        {previewOpen && (
          <div className="border-t border-[var(--or-line)] p-2">
            {resolved.length === 0 ? (
              <div className="text-muted">No variables.</div>
            ) : (
              <table className="kv-table w-full table-fixed font-mono text-[12px]">
                <tbody>
                  {resolved.map((v) => (
                    <tr key={v.key}>
                      <td className="w-[30%] truncate px-2 py-1">{v.key}</td>
                      <td className={cx('truncate px-2 py-1', v.value === '' && 'text-muted')}>{v.value || 'no value'}</td>
                      <td className="w-28 px-2 py-1 text-muted">{v.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function EnvironmentsSection({
  environments,
  localOverrides,
  trackedEnvironments,
  activeEnvironment,
  projectVariables,
}: {
  environments: Environment[];
  localOverrides: Record<string, Variable[]>;
  trackedEnvironments: string[];
  activeEnvironment: string | null;
  projectVariables: Variable[];
}) {
  const [selected, setSelected] = useState<string | null>(activeEnvironment ?? environments[0]?.name ?? null);
  const [creating, setCreating] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});

  const names = environments.map((e) => e.name);
  // Select newly created env when it shows up; fall back if selection was deleted.
  useEffect(() => {
    if (pending && names.includes(pending)) {
      setSelected(pending);
      setPending(null);
    } else if (selected === null || !names.includes(selected)) {
      setSelected(names[0] ?? null);
    }
  }, [names.join('\n'), pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDirty = useMemo(() => (name: string, dirty: boolean) => setDirtyMap((m) => (m[name] === dirty ? m : { ...m, [name]: dirty })), []);

  const submitNew = () => {
    const name = (creating ?? '').trim();
    if (!name) return setCreating(null);
    if (!/^[\w.-]+$/.test(name)) return;
    post({ type: 'createEnvironment', name });
    setPending(name);
    setCreating(null);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-border">
        {environments.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => setSelected(e.name)}
            className={cx(
              '-mb-px flex items-center gap-1.5 border-b px-2 py-1.5',
              selected === e.name ? 'border-tab-border text-tab-active' : 'border-transparent text-tab-inactive hover:text-tab-active',
            )}
          >
            {e.name}
            {e.name === activeEnvironment && <span className="h-1.5 w-1.5 rounded-full bg-success" title="Active environment" />}
            {dirtyMap[e.name] && <span className="text-[10px]" title="Unsaved changes">●</span>}
          </button>
        ))}
        {creating !== null ? (
          <input
            autoFocus
            className="ctl my-1 w-36 py-0.5"
            placeholder="name, Enter to create"
            value={creating}
            onChange={(e) => setCreating(e.target.value)}
            onBlur={submitNew}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew();
              if (e.key === 'Escape') setCreating(null);
            }}
          />
        ) : (
          <Button variant="ghost" icon="plus" className="py-0.5 text-muted" onClick={() => setCreating('')}>
            New
          </Button>
        )}
        {creating !== null && creating.trim() !== '' && !/^[\w.-]+$/.test(creating.trim()) && (
          <span className="text-[12px] text-error">Letters, digits, - _ . only</span>
        )}
      </div>
      {environments.length === 0 ? (
        <div className="py-3 text-muted">No environments. Create one to switch base URLs and credentials.</div>
      ) : (
        environments.map((e) => (
          <EnvironmentEditor
            key={e.name}
            env={e}
            local={localOverrides[e.name] ?? []}
            tracked={trackedEnvironments.includes(e.name)}
            projectVariables={projectVariables}
            hidden={e.name !== selected}
            onDirty={onDirty}
          />
        ))
      )}
    </div>
  );
}
