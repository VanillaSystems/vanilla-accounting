/**
 * The desktop server answers the page from its own `dist`, also once books are open (#364 follow-up):
 * the books' router also serves the checkout's dist folder (src/server/files.ts, APP_DIST), and a
 * checkout holding an older build (a dmg build's dist/) then served that stale page for «/» after the
 * setup created the books. Here APP_DIST is such a stale build.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'vanilla-page-'));
const stale = join(home, 'stale-dist');
const dist = join(home, 'dist');
for (const [dir, title] of [[stale, 'stale build'], [dist, 'this build']]) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${title}</title>`);
  writeFileSync(join(dir, 'assets', 'app.js'), `/* ${title} */`);
}
Object.assign(process.env, { HOME: home, VANILLA_WORKSPACE: '', APP_DIST: stale, VANILLA_AI_SETTINGS: join(home, 'ai.json'), VANILLA_SECRETS_FILE: join(home, 'secrets.json') });
writeFileSync(join(home, 'secrets.json'), '{}');

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test('with books open, the page and its assets come from the desktop server\'s own build, never from a stale one of the checkout', async () => {
  const { desktopServer } = await import('../src/desktop/server.js');
  const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist, aiAvailable: async () => false });
  const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  desktop.allowHost(host);
  const get = (path: string) => fetch(`http://${host}${path}`).then((r) => r.text());
  const answers = { legalForm: 'GmbH', vatRegistered: 'no', fiscalYear: 'calendar', start: 'new', sells: ['services'], foreignCustomers: 'no', imports: 'no', employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no' };
  const created = await fetch(`http://${host}/api/desktop/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: join(home, 'Books'), preset: 'custom', name: 'Seite GmbH', uid: 'CHE-153.004.184', owner: 'Erika Seite', language: 'de', answers, banks: [{ bank: 'UBS', currency: 'CHF' }] }) });
  assert.equal(created.status, 200, await created.text());
  for (const path of ['/', '/receipts', '/company/ai']) assert.match(await get(path), /this build/, `${path}: the desktop's own page`);
  assert.match(await get('/assets/app.js'), /this build/);
});
