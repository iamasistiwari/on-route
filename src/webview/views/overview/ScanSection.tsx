import { useEffect, useState } from 'react';
import type { ProjectConfig } from '../../../shared/model';
import type { ScanStatus } from '../../../shared/protocol';
import { SCAN_FRAMEWORK_GROUPS, SCAN_INTERVAL_MAX, SCAN_INTERVAL_MIN, scanSettings, type ScanConfig } from '../../../shared/scan';
import { Button, Spinner, Switch, cx } from '../../components/ui';
import { relativeTime } from '../../lib/format';
import { post } from '../../vscode';
import { Section } from './Section';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function LastScan({ scan }: { scan: ScanStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [scan.last?.at]);

  const last = scan.last;
  if (scan.running) {
    return (
      <div className="flex items-center gap-2.5">
        <Spinner /> Scanning your code for routes…
      </div>
    );
  }
  if (!last) return <p className="text-muted">No scan has run in this window yet. Scan the project to add its routes now.</p>;
  if (last.error) return <p className="text-error">The last scan failed: {last.error}</p>;
  return (
    <div className="space-y-1">
      <p className="text-[14px] font-medium">
        {last.added > 0 ? `Added ${plural(last.added, 'new request', 'new requests')}` : 'No new endpoints'}
      </p>
      <p className="text-[12.5px] text-muted">
        Found {plural(last.found, 'endpoint', 'endpoints')} in {plural(last.filesScanned, 'file', 'files')},{' '}
        <span title={new Date(last.at).toLocaleString()}>{relativeTime(last.at, now)}</span>.
      </p>
      {last.truncated && <p className="text-[12px] text-warning">The scan stopped at the file limit. Skip large folders in Settings to cover the rest.</p>}
    </div>
  );
}

/** Automatic scanning switch, interval and skipped paths (stored in on_route.json). Shown on the Settings page. */
export function ScanSettingsCard({ config }: { config: ProjectConfig }) {
  const settings = scanSettings(config);
  const save = (patch: Partial<ScanConfig>) => post({ type: 'saveConfig', config: { ...config, scan: { ...settings, ...patch } } });

  const [interval, setIntervalText] = useState(String(settings.intervalMinutes));
  useEffect(() => setIntervalText(String(settings.intervalMinutes)), [settings.intervalMinutes]);
  const commitInterval = () => {
    const n = Math.round(Number(interval));
    const next = Number.isFinite(n) && interval.trim() !== '' ? Math.min(SCAN_INTERVAL_MAX, Math.max(SCAN_INTERVAL_MIN, n)) : settings.intervalMinutes;
    setIntervalText(String(next));
    if (next !== settings.intervalMinutes) save({ intervalMinutes: next });
  };

  const excludeText = settings.exclude.join('\n');
  const [exclude, setExclude] = useState(excludeText);
  useEffect(() => setExclude(excludeText), [excludeText]);
  const commitExclude = () => {
    const list = exclude
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.join('\n') !== excludeText) save({ exclude: list });
  };

  return (
    <div className="divide-y divide-[var(--or-line)] rounded-xl border border-[var(--or-line)]">
      <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
        <span className="min-w-0">
          <span className="block font-medium">Scan automatically</span>
          <span className="block text-[12px] text-muted">When the project opens, right after it is initialized, and on the interval below.</span>
        </span>
        <Switch checked={settings.enabled} label="Scan automatically" onChange={(enabled) => save({ enabled })} />
      </label>
      <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3', !settings.enabled && 'opacity-50')}>
        <span className="min-w-0">
          <span className="block font-medium">Scan every</span>
          <span className="block text-[12px] text-muted">How often to look for new routes.</span>
        </span>
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input
            type="number"
            min={SCAN_INTERVAL_MIN}
            max={SCAN_INTERVAL_MAX}
            aria-label="Scan interval in minutes"
            className="ctl is-pill w-[76px] py-[3px] text-center text-fg"
            value={interval}
            disabled={!settings.enabled}
            onChange={(e) => setIntervalText(e.target.value)}
            onBlur={commitInterval}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          minutes
        </label>
      </div>
      <div className="px-4 py-3">
        <label htmlFor="scan-exclude" className="block font-medium">
          Skip paths
        </label>
        <p className="mb-2 text-[12px] text-muted">
          One glob per line, relative to the workspace. Dependency and build folders like node_modules, vendor and dist are always skipped.
        </p>
        <textarea
          id="scan-exclude"
          className="ctl block min-h-[68px] w-full resize-y font-mono text-[12px] leading-5"
          placeholder={'legacy/**\nscripts'}
          spellCheck={false}
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          onBlur={commitExclude}
        />
      </div>
    </div>
  );
}

/** Overview page: scan now, last result and supported frameworks. Settings live on the Settings page. */
export function ScanSection({ config, scan, onOpenSettings }: { config: ProjectConfig; scan: ScanStatus; onOpenSettings: () => void }) {
  const settings = scanSettings(config);
  const detected = new Set(scan.last?.frameworks ?? []);

  return (
    <Section
      id="scanning"
      title="Endpoint scanning"
      description="On Route reads your server code and adds each route as a request, one folder per router. Requests it already added are never changed, so rename, move or delete them freely."
      actions={
        <Button variant="primary" icon="radar" disabled={scan.running} onClick={() => post({ type: 'runCommand', command: 'scanProject' })}>
          {scan.running ? 'Scanning…' : 'Scan project'}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="rounded-xl border border-[var(--or-line)] px-4 py-3.5">
          <LastScan scan={scan} />
          {detected.size > 0 && !scan.running && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {[...detected].map((f) => (
                <span key={f} className="rounded-full bg-[var(--or-soft-strong)] px-2.5 py-0.5 text-[11.5px]">
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--or-line)] px-4 py-2.5">
          <span className="text-[12.5px] text-muted">
            {settings.enabled ? `Scans automatically every ${plural(settings.intervalMinutes, 'minute', 'minutes')}.` : 'Automatic scanning is off.'}
          </span>
          <Button variant="ghost" icon="gear" className="py-0.5" onClick={onOpenSettings}>
            Scan settings
          </Button>
        </div>

        <div>
          <h3 className="mb-2.5 text-[12px] font-semibold text-muted">Supported frameworks</h3>
          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {SCAN_FRAMEWORK_GROUPS.map((g) => (
              <div key={g.language}>
                <div className="mb-1.5 text-[12px] text-muted">{g.language}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.frameworks.map((f) => (
                    <span
                      key={f}
                      title={detected.has(f) ? 'Found in this project' : undefined}
                      className={cx('rounded-full px-2.5 py-0.5 text-[11.5px]', detected.has(f) ? 'bg-primary text-primary-fg' : 'bg-[var(--or-soft)] text-fg/85')}
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
