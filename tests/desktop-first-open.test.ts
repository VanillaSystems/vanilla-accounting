/**
 * The Mac app's first books (#65): the packed app starts with no VANILLA_WORKSPACE and a cwd outside
 * any workspace, so the books API must serve the books the desktop opened, never look for its own.
 * Its own process: the server's workspace is chosen once, when the first books open.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';

const home = mkdtempSync(join(tmpdir(), 'vanilla-first-open-'));
process.env.VANILLA_WORKSPACE = '';
process.chdir(home);
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'Documents'), dist });
const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
desktop.allowHost(`127.0.0.1:${port}`);
after(() => server.close());

const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, json: await r.json() as any }; };

test('books created as the first books of the app are the books the API serves', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/desktop/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preset: 'consultant', name: 'Erste Bücher GmbH', uid: 'CHE-153.004.184', owner: 'Erika Test', language: 'de', root: join(home, 'Documents', 'Erste'),
      answers: {
        legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly', fiscalYear: 'calendar', start: 'new',
        sells: 'services', foreignCustomers: 'yes', imports: 'no', employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
      },
      banks: [{ bank: 'UBS', currency: 'CHF' }],
    }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal((await get('/api/status')).status, 200);
  assert.equal((await get('/api/workspace')).json.company.name, 'Erste Bücher GmbH');
});
