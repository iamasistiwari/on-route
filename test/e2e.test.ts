// End-to-end over the pure modules: curl paste -> store -> resolve -> send -> history -> export.
import { promises as fs } from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/extension/history/historyStore';
import { executeRequest } from '../src/extension/http/executor';
import { prepareRequest } from '../src/extension/services/resolve';
import { ProjectStore } from '../src/extension/storage/projectStore';
import { toAxios, toCurl } from '../src/shared/codegen';
import { parseCurl } from '../src/shared/importers/curl';

let server: http.Server;
let port: number;
let root: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'onroute-e2e-'));
});

afterAll(async () => {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('on route e2e', () => {
  it('imports curl, sends with env + inherited auth, records history, exports', async () => {
    const store = new ProjectStore(root);
    await store.init('e2e');

    const tree0 = await store.load();
    await store.writeConfig({ ...tree0.config, auth: { type: 'bearer', token: '{{token}}' } });
    await store.writeEnvironment({
      name: 'dev',
      variables: [
        { key: 'baseUrl', value: `http://127.0.0.1:${port}` },
        { key: 'token', value: '', secret: true },
      ],
    });
    await store.writeLocalOverrides('dev', [{ key: 'token', value: 's3cret' }]);

    const parsed = parseCurl(
      `curl 'http://example.com/users?notify=true' -H 'Content-Type: application/json' --data-raw '{"name":"Ada"}'`,
    );
    const folder = await store.createFolder('', 'Users');
    const created = await store.createRequest(folder.id, 'Create user', {
      ...parsed,
      url: '{{baseUrl}}/users',
      auth: { type: 'inherit' },
    });

    const tree = await store.load();
    expect(tree.requests.map((r) => r.id)).toContain(created.id);
    const envFile = await fs.readFile(path.join(store.dir, 'environments/dev.yaml'), 'utf8');
    expect(envFile).not.toContain('s3cret');

    const req = await store.readRequest(created.id);
    const local = await store.readLocalOverrides('dev');
    const { request: resolved, missing } = prepareRequest(tree, req, 'dev', local);
    expect(missing).toEqual([]);

    const res = await executeRequest(resolved, {
      timeoutMs: 5000,
      rejectUnauthorized: true,
      followRedirects: true,
      workspaceRoot: root,
    });
    expect(res.status).toBe(200);
    const echo = JSON.parse(res.body);
    expect(echo).toMatchObject({ method: 'POST', url: '/users?notify=true', auth: 'Bearer s3cret' });
    expect(JSON.parse(echo.body)).toEqual({ name: 'Ada' });

    const history = new HistoryStore(store.dir);
    await history.add({ id: 'h1', requestId: req.id, timestamp: Date.now(), environment: 'dev', request: resolved, response: res });
    expect((await history.list(req.id))[0].response?.status).toBe(200);

    const placeholders = prepareRequest(tree, req, 'dev', local, false).request;
    const curl = toCurl(placeholders);
    expect(curl).toContain("'{{baseUrl}}/users?notify=true'");
    expect(curl).toContain('Bearer {{token}}');
    expect(toAxios(resolved)).toContain("name: 'Ada'");
  });
});
