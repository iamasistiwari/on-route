import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryStore } from './historyStore';
import type { HistoryEntry } from '../../shared/model';

let dir: string;
let store: HistoryStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-route-hist-'));
  store = new HistoryStore(dir, 3);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function entry(requestId: string, timestamp: number, body = 'ok', bodyEncoding: 'utf8' | 'base64' = 'utf8'): HistoryEntry {
  return {
    id: `e${timestamp}`,
    requestId,
    timestamp,
    environment: 'dev',
    request: { method: 'GET', url: 'http://x', headers: [], body: { type: 'none' } },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'text/plain']],
      body,
      bodyEncoding,
      size: body.length,
      timing: { totalMs: 5 },
    },
  };
}

describe('HistoryStore', () => {
  it('empty list when no file', async () => {
    expect(await store.list('users/get')).toEqual([]);
  });

  it('stores at .history/<id with __>.json newest first, capped', async () => {
    for (let t = 1; t <= 5; t++) await store.add(entry('users/get', t));
    const list = await store.list('users/get');
    expect(list.map((e) => e.timestamp)).toEqual([5, 4, 3]);
    const raw = JSON.parse(await fs.readFile(path.join(dir, '.history', 'users__get.json'), 'utf8'));
    expect(raw).toHaveLength(3);
    expect(list[0]).toEqual(entry('users/get', 5));
  });

  it('default limit is 20', async () => {
    const s = new HistoryStore(dir);
    expect(s.limit).toBe(20);
    await Promise.all(Array.from({ length: 25 }, (_, i) => s.add(entry('a', i))));
    const list = await s.list('a');
    expect(list).toHaveLength(20);
    expect(list[0].timestamp).toBe(24);
  });

  it('concurrent adds do not lose entries', async () => {
    const s = new HistoryStore(dir, 50);
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.add(entry('c', i))));
    expect((await s.list('c')).map((e) => e.timestamp)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('truncates utf8 bodies over 1MB', async () => {
    const big = 'é'.repeat(700 * 1024); // ~1.4MB in utf8
    const e = entry('big', 1, big);
    await store.add(e);
    const [stored] = await store.list('big');
    expect(stored.response!.truncated).toBe(true);
    expect(Buffer.byteLength(stored.response!.body, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    expect(stored.response!.body.endsWith('é')).toBe(true);
    expect(e.response!.truncated).toBeUndefined(); // input not mutated
    await store.add(entry('small', 1, 'x'.repeat(1024 * 1024)));
    expect((await store.list('small'))[0].response!.truncated).toBeUndefined();
  });

  it('drops base64 bodies over 1MB rather than storing half a file', async () => {
    const b64 = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    const e = entry('bin', 1, b64, 'base64');
    await store.add(e);
    const [stored] = await store.list('bin');
    expect(stored.response!.bodyOmitted).toBe(true);
    expect(stored.response!.body).toBe('');
    expect(stored.response!.truncated).toBeUndefined();
    expect(e.response!.bodyOmitted).toBeUndefined(); // input not mutated
  });

  it('keeps a binary body that fits whole, so it still plays', async () => {
    const b64 = Buffer.alloc(512 * 1024, 7).toString('base64');
    await store.add(entry('small-bin', 1, b64, 'base64'));
    const [stored] = await store.list('small-bin');
    expect(stored.response!.bodyOmitted).toBeUndefined();
    expect(Buffer.from(stored.response!.body, 'base64').length).toBe(512 * 1024);
  });

  it('entries with error and no response', async () => {
    const e: HistoryEntry = { ...entry('err', 1), response: undefined, error: { message: 'ECONNREFUSED', timing: { totalMs: 1 } } };
    delete e.response;
    await store.add(e);
    expect(await store.list('err')).toEqual([e]);
  });

  it('reports the bytes history takes on disk', async () => {
    expect(await store.diskBytes()).toBe(0); // nothing written yet
    await store.add(entry('sized', 1, 'x'.repeat(5000)));
    const bytes = await store.diskBytes();
    expect(bytes).toBeGreaterThan(5000);
    await store.add(entry('sized2', 1, 'y'.repeat(5000)));
    expect(await store.diskBytes()).toBeGreaterThan(bytes); // a second file adds to the total
    await store.clearAll();
    expect(await store.diskBytes()).toBe(0);
  });

  it('corrupt files are treated as empty', async () => {
    await fs.mkdir(path.join(dir, '.history'), { recursive: true });
    await fs.writeFile(path.join(dir, '.history', 'x.json'), '{not json');
    expect(await store.list('x')).toEqual([]);
    await fs.writeFile(path.join(dir, '.history', 'y.json'), '{"a":1}');
    expect(await store.list('y')).toEqual([]);
    await store.add(entry('x', 1));
    expect(await store.list('x')).toHaveLength(1);
  });

  it('clear', async () => {
    await store.add(entry('a/b', 1));
    await store.clear('a/b');
    expect(await store.list('a/b')).toEqual([]);
    await store.clear('never');
  });

  it('rename moves and merges history, updating requestId', async () => {
    await store.add(entry('old/id', 1));
    await store.add(entry('old/id', 3));
    await store.add(entry('new', 2));
    await store.add(entry('new', 4));
    await store.rename('old/id', 'new');
    expect(await store.list('old/id')).toEqual([]);
    const list = await store.list('new');
    expect(list.map((e) => e.timestamp)).toEqual([4, 3, 2]);
    expect(list.every((e) => e.requestId === 'new')).toBe(true);
    await expect(fs.access(path.join(dir, '.history', 'old__id.json'))).rejects.toThrow();
    await store.rename('missing', 'other'); // no-op
    expect(await store.list('other')).toEqual([]);
  });

  it('listAll merges every request newest first; clearAll removes them', async () => {
    await store.add(entry('users/get', 1));
    await store.add(entry('health', 3));
    await store.add(entry('users/get', 2));
    const all = await store.listAll();
    expect(all.map((e) => [e.requestId, e.timestamp])).toEqual([
      ['health', 3],
      ['users/get', 2],
      ['users/get', 1],
    ]);
    await store.clearAll();
    expect(await store.listAll()).toEqual([]);
    expect(await new HistoryStore(path.join(dir, 'missing')).listAll()).toEqual([]);
  });

  it('rejects traversal ids', async () => {
    await expect(store.list('../x')).rejects.toThrow();
    await expect(store.add(entry('a/../../b', 1))).rejects.toThrow();
  });
});
