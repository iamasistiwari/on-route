import { useEffect, useState } from 'react';
import type { ProjectConfig } from '../../../shared/model';
import { AUTO_SAVE_INTERVALS, DEFAULT_COLLAPSE_STRINGS_OVER, type UserSettings } from '../../../shared/protocol';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, comboFromEvent, type ShortcutAction, type Shortcuts } from '../../../shared/shortcuts';
import { Button, Segmented, Switch, cx } from '../../components/ui';
import { IS_MAC, post, setRecordingShortcut, shortcutLabel } from '../../vscode';
import { ScanSettingsCard } from './ScanSection';
import { Section } from './Section';

const intervalLabel = (seconds: number) => (seconds === 0 ? 'Immediately' : seconds < 60 ? `${seconds} sec` : `${seconds / 60} min`);

/** Overview page: auto save, editor and shortcuts (user settings) and endpoint scanning (project settings). */
export function SettingsSection({ config, settings }: { config: ProjectConfig; settings: UserSettings }) {
  const update = (patch: Partial<UserSettings>) => post({ type: 'updateSettings', settings: patch });
  const intervals: number[] = [...AUTO_SAVE_INTERVALS];
  if (!intervals.includes(settings.autoSaveIntervalSeconds)) intervals.push(settings.autoSaveIntervalSeconds);
  intervals.sort((a, b) => a - b);

  return (
    <Section id="settings" title="Settings" description="Choose how On Route saves your work, shows long values, which shortcuts it uses and how endpoints stay in sync with your code.">
      <div className="space-y-8">
        <div>
          <h3 className="text-[14px] font-semibold">Auto save</h3>
          <p className="mb-3 mt-0.5 text-[12.5px] text-muted">
            Saves unsaved changes in open requests and on the overview pages. Saved in your VS Code user settings, so it applies to every project.
          </p>
          <div className="divide-y divide-[var(--or-line)] rounded-xl border border-[var(--or-line)]">
            <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block font-medium">Save automatically</span>
                <span className="block text-[12px] text-muted">Off by default. {shortcutLabel(settings.shortcuts.save)} still saves right away.</span>
              </span>
              <Switch checked={settings.autoSave} label="Save automatically" onChange={(autoSave) => update({ autoSave })} />
            </label>
            <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3', !settings.autoSave && 'opacity-50')}>
              <span className="min-w-0">
                <span className="block font-medium">Save every</span>
                <span className="block text-[12px] text-muted">How long unsaved changes wait before they are written.</span>
              </span>
              <Segmented
                options={intervals.map((s) => ({ value: String(s), label: intervalLabel(s) }))}
                value={String(settings.autoSaveIntervalSeconds)}
                onChange={(v) => update({ autoSaveIntervalSeconds: Number(v) })}
              />
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-[14px] font-semibold">Editor</h3>
          <p className="mb-3 mt-0.5 text-[12.5px] text-muted">How request bodies are shown. Saved in your VS Code user settings.</p>
          <div className="divide-y divide-[var(--or-line)] rounded-xl border border-[var(--or-line)]">
            <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block font-medium">Shorten long text values</span>
                <span className="block text-[12px] text-muted">
                  Long JSON string values end in “…view more”; click one (or put the cursor in it) to see it in full.
                </span>
              </span>
              <Switch checked={settings.collapseLongStrings} label="Shorten long text values" onChange={(collapseLongStrings) => update({ collapseLongStrings })} />
            </label>
            <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3', !settings.collapseLongStrings && 'opacity-50')}>
              <span className="min-w-0">
                <span className="block font-medium">Shorten after</span>
                <span className="block text-[12px] text-muted">Characters shown before a value is shortened. Default {DEFAULT_COLLAPSE_STRINGS_OVER}.</span>
              </span>
              <LengthInput
                value={settings.collapseStringsOver}
                disabled={!settings.collapseLongStrings}
                onCommit={(collapseStringsOver) => update({ collapseStringsOver })}
              />
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block font-medium">Fix and format JSON when sending</span>
                <span className="block text-[12px] text-muted">
                  Repairs missing or doubled commas and quotes, single quotes, unquoted keys and missing brackets in a JSON body and formats it when you
                  send it. {'{{variables}}'} are kept.
                </span>
              </span>
              <Switch checked={settings.autoFixJson} label="Fix and format JSON when sending" onChange={(autoFixJson) => update({ autoFixJson })} />
            </label>
          </div>
        </div>

        <div>
          <h3 className="text-[14px] font-semibold">Keyboard shortcuts</h3>
          <p className="mb-3 mt-0.5 text-[12.5px] text-muted">
            Click a shortcut and press the new keys. Saved in your VS Code user settings. Changed shortcuts work while an On Route view or request editor has
            focus.
          </p>
          <ShortcutsCard shortcuts={settings.shortcuts} onChange={(shortcuts) => update({ shortcuts })} />
        </div>

        <div>
          <h3 className="text-[14px] font-semibold">Endpoint scanning</h3>
          <p className="mb-3 mt-0.5 text-[12.5px] text-muted">Saved in .on_route/on_route.json, so everyone on the project shares these settings.</p>
          <ScanSettingsCard config={config} />
        </div>
      </div>
    </Section>
  );
}

/** Whole number ≥ 1, saved on blur or Enter; invalid input goes back to the saved value. */
function LengthInput({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  const valid = /^\d+$/.test(text.trim()) && n >= 1;
  const commit = () => {
    if (valid && n !== value) onCommit(n);
    else if (!valid) setText(String(value));
  };
  return (
    <span className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        aria-label="Characters before shortening"
        disabled={disabled}
        className={cx('ctl w-24 py-[3px] text-right tabular-nums', !valid && 'border-error')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setText(String(value));
        }}
      />
      <span className="text-[12px] text-muted">characters</span>
    </span>
  );
}

function ShortcutsCard({ shortcuts, onChange }: { shortcuts: Shortcuts; onChange: (s: Shortcuts) => void }) {
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState<{ action: ShortcutAction; message: string } | null>(null);

  useEffect(() => {
    if (!recording) return;
    setRecordingShortcut(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(null);
        return;
      }
      const combo = comboFromEvent(e, IS_MAC);
      if (!combo) {
        // Lone modifiers while the user is still pressing keys; plain keys are not allowed.
        if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
          setError({ action: recording, message: 'Use Cmd, Ctrl or Alt/Option with a key (or a function key).' });
        }
        return;
      }
      const clash = SHORTCUT_ACTIONS.find((a) => a.id !== recording && shortcuts[a.id] === combo);
      if (clash) {
        setError({ action: recording, message: `${shortcutLabel(combo)} is already used by “${clash.label}”.` });
        return;
      }
      setError(null);
      setRecording(null);
      if (combo !== shortcuts[recording]) onChange({ ...shortcuts, [recording]: combo });
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setRecordingShortcut(false);
    };
  }, [recording, shortcuts, onChange]);

  const customized = SHORTCUT_ACTIONS.some((a) => shortcuts[a.id] !== a.default);

  return (
    <div className="divide-y divide-[var(--or-line)] rounded-xl border border-[var(--or-line)]">
      {SHORTCUT_ACTIONS.map((a) => {
        const isRecording = recording === a.id;
        const changed = shortcuts[a.id] !== a.default;
        return (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <span className="min-w-0">
              <span className="block font-medium">{a.label}</span>
              <span className={cx('block text-[12px]', error?.action === a.id ? 'text-error' : 'text-muted')}>
                {error?.action === a.id ? error.message : a.description}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {changed && !isRecording && (
                <button
                  type="button"
                  className="text-[12px] text-link hover:underline"
                  title={`Reset to ${shortcutLabel(a.default)}`}
                  onClick={() => onChange({ ...shortcuts, [a.id]: a.default })}
                >
                  Reset
                </button>
              )}
              <button
                type="button"
                aria-label={`Change shortcut for ${a.label}`}
                className={cx(
                  'min-w-[120px] rounded-full border px-3 py-[3px] font-mono text-[12px] transition-colors',
                  isRecording ? 'border-focus bg-[var(--or-soft-strong)] text-fg' : 'border-[var(--or-line)] hover:bg-[var(--or-soft-strong)]',
                )}
                onClick={() => {
                  setError(null);
                  setRecording(isRecording ? null : a.id);
                }}
                onBlur={() => isRecording && setRecording(null)}
              >
                {isRecording ? 'Press keys… (Esc)' : shortcutLabel(shortcuts[a.id])}
              </button>
            </span>
          </div>
        );
      })}
      {customized && (
        <div className="flex justify-end px-4 py-2">
          <Button variant="ghost" onClick={() => onChange(DEFAULT_SHORTCUTS)}>
            Reset all to defaults
          </Button>
        </div>
      )}
    </div>
  );
}
