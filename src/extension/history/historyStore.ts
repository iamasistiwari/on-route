// OWNER: agent "storage". Pure Node, no `vscode` import.
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { HistoryEntry, HttpResponse } from '../../shared/model';

export const MAX_HISTORY_BODY_BYTES = 1024 * 1024;

function truncateResponse(res: HttpResponse): HttpResponse {
  if (res.bodyEncoding === 'base64') {
    const buf = Buffer.from(res.body, 'base64');
    if (buf.length <= MAX_HISTORY_BODY_BYTES) return res;
    // A binary body is a file: the first megabyte of an image or a video is not a smaller image or
    // video, it is a broken one. Keep the metadata and drop the bytes.
    return { ...res, body: '', bodyOmitted: true };
  }
  if (Buffer.byteLength(res.body, 'utf8') <= MAX_HISTORY_BODY_BYTES) return res;
  const buf = Buffer.from(res.body, 'utf8').subarray(0, MAX_HISTORY_BODY_BYTES);
  // Drop a trailing partial multi-byte sequence (decoded as U+FFFD).
  const body = buf.toString('utf8').replace(/�$/, '');
  return { ...res, body, truncated: true };
}

/**
 * Stores responses at .on_route/.history/<requestId with '/' replaced by '__'>.json as a JSON array,
 * newest first, capped at `limit`. Text bodies larger than 1 MB are truncated (truncated: true);
 * binary bodies that large are dropped instead (bodyOmitted: true), since a partial file is useless.
 * Corrupt files are treated as empty.
 */
export class HistoryStore {
  private queues = new Map<string, Promise<unknown>>();

  constructor(readonly onRouteDir: string, public limit = 20) {}

  private file(requestId: string): string {
    if (
      !requestId ||
      /[\\\0]/.test(requestId) ||
      requestId.startsWith('/') ||
      requestId.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
      throw new Error(`Invalid request id: ${requestId}`);
    }
    return path.join(this.onRouteDir, '.history', `${requestId.replace(/\//g, '__')}.json`);
  }

  /** Serialize operations touching the same file(s) to avoid lost updates. */
  private enqueue<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const prev = Promise.all(keys.map((k) => this.queues.get(k)?.catch(() => undefined)));
    const run = prev.then(fn);
    for (const k of keys) {
      const settled = run.catch(() => undefined);
      this.queues.set(k, settled);
      void settled.then(() => {
        if (this.queues.get(k) === settled) this.queues.delete(k);
      });
    }
    return run;
  }

  private async read(file: string): Promise<HistoryEntry[]> {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return Array.isArray(data) ? data.filter((e) => e && typeof e === 'object') : [];
    } catch {
      return [];
    }
  }

  private async write(file: string, entries: HistoryEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries), 'utf8');
    await fs.rename(tmp, file);
  }

  async add(entry: HistoryEntry): Promise<void> {
    const file = this.file(entry.requestId);
    return this.enqueue([file], async () => {
      const stored: HistoryEntry = entry.response ? { ...entry, response: truncateResponse(entry.response) } : entry;
      const entries = [stored, ...(await this.read(file))]
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
        .slice(0, Math.max(0, this.limit));
      await this.write(file, entries);
    });
  }

  async list(requestId: string): Promise<HistoryEntry[]> {
    const file = this.file(requestId);
    return this.enqueue([file], () => this.read(file));
  }

  /** Every stored entry across all requests, newest first. */
  async listAll(): Promise<HistoryEntry[]> {
    const dir = path.join(this.onRouteDir, '.history');
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const lists = await Promise.all(
      names.map((n) => {
        const file = path.join(dir, n);
        return this.enqueue([file], () => this.read(file));
      }),
    );
    return lists.flat().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  /** Bytes the history files take on disk, for the "free up space" hint on Clear all. */
  async diskBytes(): Promise<number> {
    const dir = path.join(this.onRouteDir, '.history');
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return 0;
    }
    const sizes = await Promise.all(
      names.map(async (n) => {
        try {
          return (await fs.stat(path.join(dir, n))).size;
        } catch {
          return 0;
        }
      }),
    );
    return sizes.reduce((a, b) => a + b, 0);
  }

  /** Remove history for every request. */
  async clearAll(): Promise<void> {
    const dir = path.join(this.onRouteDir, '.history');
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    await Promise.all(
      names.map((n) => {
        const file = path.join(dir, n);
        return this.enqueue([file], () => fs.rm(file, { force: true }));
      }),
    );
  }

  async clear(requestId: string): Promise<void> {
    const file = this.file(requestId);
    return this.enqueue([file], () => fs.rm(file, { force: true }));
  }

  /** Move history when a request is renamed. */
  async rename(oldId: string, newId: string): Promise<void> {
    const from = this.file(oldId);
    const to = this.file(newId);
    if (from === to) return;
    return this.enqueue([from, to], async () => {
      const moved = await this.read(from);
      if (moved.length === 0) {
        await fs.rm(from, { force: true });
        return;
      }
      const merged = [...moved.map((e) => ({ ...e, requestId: newId })), ...(await this.read(to))]
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
        .slice(0, Math.max(0, this.limit));
      await this.write(to, merged);
      await fs.rm(from, { force: true });
    });
  }
}
