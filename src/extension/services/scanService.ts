// Runs endpoint scans (manual, on init, on a timer) and adds newly found endpoints as request files.
import * as vscode from 'vscode';
import type { ProjectConfig } from '../../shared/model';
import type { ScanRun, ScanStatus, ScanTrigger } from '../../shared/protocol';
import { appendOrder } from '../../shared/order';
import type { ProjectTree } from '../../shared/model';
import { scanSettings } from '../../shared/scan';
import { planScan, type ScanPlan } from '../scan/plan';
import { scanProject } from '../scan/scanner';
import type { ProjectService } from './project';

const FIRST_SCAN_DELAY_MS = 3000;
/** An automatic scan right after another scan finished is redundant. */
const MIN_AUTO_GAP_MS = 5000;
const DEFAULT_BASE_URL = 'http://localhost:3000';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ScanService implements vscode.Disposable {
  private _status: ScanStatus = { running: false };
  private running: Promise<ScanRun | undefined> | undefined;
  private interval: NodeJS.Timeout | undefined;
  private delayed: NodeJS.Timeout | undefined;
  /** "off", or the interval in minutes the timer runs with; "" before the project loaded. */
  private schedule = '';
  private readonly _onDidChangeStatus = new vscode.EventEmitter<ScanStatus>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly service: ProjectService) {
    this.subs = [this._onDidChangeStatus, service.onDidChangeTree(() => this.syncSchedule())];
  }

  get status(): ScanStatus {
    return this._status;
  }

  /** Starts / restarts / stops the timer when the scan settings change; scans shortly after it is switched on. */
  private syncSchedule(): void {
    const tree = this.service.initialized ? this.service.tree : undefined;
    const settings = tree ? scanSettings(tree.config) : undefined;
    const next = settings?.enabled ? String(settings.intervalMinutes) : 'off';
    if (next === this.schedule) return;
    const wasOn = this.schedule !== '' && this.schedule !== 'off';
    this.schedule = next;
    clearInterval(this.interval);
    this.interval = undefined;
    if (!settings?.enabled) {
      clearTimeout(this.delayed);
      return;
    }
    this.interval = setInterval(() => void this.scan('auto'), settings.intervalMinutes * 60_000);
    if (!wasOn) {
      clearTimeout(this.delayed);
      this.delayed = setTimeout(() => void this.scan('auto'), FIRST_SCAN_DELAY_MS);
    }
  }

  /** Scans the workspace; concurrent calls share the running scan. Undefined when there is no project. */
  scan(trigger: ScanTrigger): Promise<ScanRun | undefined> {
    if (this.running) return this.running;
    if (!this.service.store || !this.service.workspaceRoot || !this.service.initialized) return Promise.resolve(undefined);
    const last = this._status.last;
    if (trigger === 'auto' && last && Date.now() - last.at < MIN_AUTO_GAP_MS) return Promise.resolve(last);
    const running: Promise<ScanRun | undefined> = Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '$(radio-tower) On Route: scanning endpoints' }, () => this.run(trigger)),
    )
      .catch(() => undefined)
      .finally(() => {
        if (this.running === running) this.running = undefined;
      });
    this.running = running;
    return running;
  }

  private setStatus(status: ScanStatus): void {
    this._status = status;
    this._onDidChangeStatus.fire(status);
  }

  private async run(trigger: ScanTrigger): Promise<ScanRun> {
    const store = this.service.store!;
    const root = this.service.workspaceRoot!;
    const started = Date.now();
    this.setStatus({ ...this._status, running: true });
    let run: ScanRun;
    try {
      if (!this.service.tree) await this.service.reload();
      const tree = this.service.tree;
      if (!tree) throw new Error('On Route project is not initialized');
      const settings = scanSettings(tree.config);
      const result = await scanProject(root, { exclude: settings.exclude });
      const state = await store.readScanState();
      const plan = planScan(result.routes, tree, state?.known ?? []);

      const added = await this.apply(plan, tree);
      if (!state && added > 0 && result.suggestedBaseUrl) await this.adoptBaseUrl(tree.config, result.suggestedBaseUrl);
      const knownChanged = !state || state.known.length !== plan.known.length || state.known.some((k, i) => k !== plan.known[i]);
      if (knownChanged) {
        this.service.markSelfWrite(store.scanStatePath);
        await store.writeScanState({ known: plan.known });
      }
      if (added > 0) await this.service.reload();

      run = {
        at: Date.now(),
        trigger,
        found: result.routes.length,
        added,
        frameworks: result.frameworks,
        filesScanned: result.filesScanned,
        durationMs: Date.now() - started,
        truncated: result.truncated || undefined,
      };
      this.service.log(
        `Scan (${trigger}): ${run.found} endpoint(s) in ${run.filesScanned} file(s), ${added} added` +
          (run.frameworks.length ? ` [${run.frameworks.join(', ')}]` : '') +
          ` in ${run.durationMs} ms`,
      );
    } catch (e) {
      run = { at: Date.now(), trigger, found: 0, added: 0, frameworks: [], filesScanned: 0, durationMs: Date.now() - started, error: message(e) };
      this.service.log(`Scan (${trigger}) failed: ${run.error}`);
    }
    this.setStatus({ running: false, last: run });
    return run;
  }

  /**
   * Writes planned folders and requests; never modifies existing files. In folders the user has arranged by
   * drag & drop, new items go after the existing ones so nothing moves. Returns the number of requests created.
   */
  private async apply(plan: ScanPlan, tree: ProjectTree): Promise<number> {
    const store = this.service.store!;
    let count = 0;
    let nextFolderOrder = appendOrder(tree.folders.filter((f) => !f.id.includes('/')));
    for (const group of plan.groups) {
      let folderId = group.folderId;
      if (folderId === null) {
        const name = group.newFolder!;
        const folder = await store.createFolder('', name, { slug: name });
        if (nextFolderOrder !== undefined) await store.writeFolder({ ...folder, order: nextFolderOrder++ });
        folderId = folder.id;
      }
      const inFolder = folderId;
      let nextOrder = appendOrder(tree.requests.filter((r) => r.folderId === inFolder));
      for (const planned of group.requests) {
        const order = nextOrder === undefined ? undefined : nextOrder++;
        const req = await store.createRequest(folderId, planned.request.name, { ...planned.request, order }, { slug: planned.slug });
        this.service.markSelfWrite(store.requestPath(req.id));
        count++;
      }
    }
    return count;
  }

  /** On the first scan, point a still-default baseUrl at the port the detected server listens on. */
  private async adoptBaseUrl(config: ProjectConfig, baseUrl: string): Promise<void> {
    const store = this.service.store!;
    const current = config.variables.find((v) => v.key === 'baseUrl');
    if (current && current.value !== DEFAULT_BASE_URL) return;
    if (current?.value === baseUrl) return;
    const variables = current
      ? config.variables.map((v) => (v.key === 'baseUrl' ? { ...v, value: baseUrl } : v))
      : [{ key: 'baseUrl', value: baseUrl }, ...config.variables];
    this.service.markSelfWrite(store.configPath);
    await store.writeConfig({ ...config, variables });
  }

  dispose(): void {
    clearInterval(this.interval);
    clearTimeout(this.delayed);
    for (const s of this.subs) s.dispose();
  }
}

/** One-line result for notifications. */
export function scanSummary(run: ScanRun): string {
  if (run.error) return `On Route: scan failed: ${run.error}`;
  if (run.found === 0) return 'On Route: no API routes found in this workspace.';
  const found = `${run.found} ${run.found === 1 ? 'endpoint' : 'endpoints'} found`;
  if (!run.added) return `On Route: no new endpoints (${found}).`;
  return `On Route: added ${run.added} new ${run.added === 1 ? 'endpoint' : 'endpoints'} (${found}).`;
}
