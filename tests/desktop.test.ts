/**
 * The desktop app's server (src/desktop/server.ts) without Electron: the start screen's routes,
 * opening, creating and switching books in place, the demo copy, the host guard; the start
 * screen's words for every setup question; the claude CLI found through a PATH or refused clearly.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import git from 'isomorphic-git';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { programOn } from '../src/platform/login-path.js';
import { sealedStore } from '../src/secrets/sealed-store.js';
import { envSecrets, useSecretStore } from '../src/secrets/secrets.js';
import { ask, modelReady } from '../src/llm/ask.js';
import { NoClaudeError } from '../src/llm/providers/claude-cli.js';
import { PRESET_NAMES, QUESTIONS, QUESTION_ORDER } from '../src/workspace/setup.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE, workspaceAt } from '../src/workspace/workspace.js';
import { loadBooks, sealsOf } from '../src/books/store.js';
import { readState, writeState } from '../src/desktop/state.js';
import { writeOldLayout } from './support/old-layout.js';
import de from '../src/app/i18n/locales/de.js';
import { DEMO_ROOT } from './support/workspace.js';

const home = mkdtempSync(join(tmpdir(), 'vanilla-desktop-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'Documents'), dist });
const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
const port = (server.address() as { port: number }).port;
desktop.allowHost(`127.0.0.1:${port}`);
after(() => server.close());

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

const SETUP = {
  preset: 'consultant', name: 'Neu Test GmbH', uid: 'CHE-153.004.184', owner: 'Erika Test', language: 'de',
  answers: {
    legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly', fiscalYear: 'calendar', start: 'new',
    sells: ['services'], foreignCustomers: 'yes', imports: 'no', employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
  },
  banks: [{ bank: 'UBS', currency: 'CHF' }],
};

test('every setup question, option, stop and note has words on the start screen', () => {
  const keys = new Set(Object.keys(de.messages));
  const missing = [
    ...PRESET_NAMES.map((p) => `desktop.q.preset.${p}`),
    ...QUESTION_ORDER.flatMap((k) => [`desktop.q.${k}.ask`, `desktop.q.${k}.why`, ...QUESTIONS[k].options.flatMap((o) => [
      `desktop.q.${k}.${o.value}`,
      ...('unsupported' in o ? [`desktop.q.${k}.${o.value}.unsupported`] : []),
      ...('caveat' in o ? [`desktop.q.${k}.${o.value}.caveat`] : []),
    ])]),
  ].filter((k) => !keys.has(k));
  assert.deepEqual(missing, []);
});

test('without books: the start screen is served, the books API answers noWorkspace, a folder without a manifest is refused', async () => {
  assert.deepEqual((await call('GET', '/api/desktop')).json, { open: null, recent: [], booksHome: join(home, 'Documents'), folders: [] });
  assert.match((await call('GET', '/start')).text, /<title>app<\/title>/);
  const status = await call('GET', '/api/status');
  assert.deepEqual([status.status, status.json.code], [409, 'noWorkspace']);
  const empty = mkdtempSync(join(tmpdir(), 'not-books-'));
  const refused = await call('POST', '/api/desktop/open', { root: empty });
  assert.deepEqual([refused.status, refused.json.code], [400, 'notWorkspace']);
});

test('Demo: a copy in the user data folder opens; another workspace is created, opened and switched in place; the recent list follows', async () => {
  const demo = await call('POST', '/api/desktop/demo');
  assert.equal(demo.status, 200, demo.text);
  assert.ok(existsSync(join(home, 'Demo', APP_FOLDER, MANIFEST_FILE)), 'the demo was copied');
  assert.deepEqual((await call('GET', '/books.json')).json, JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT)))));
  const demoName = (await call('GET', '/api/workspace')).json.company.name;
  assert.equal((await call('GET', '/api/workspace')).json.demo, true, 'the demo copy says that it is a demo, by where it lies');
  const receipt = (await call('GET', '/books.json')).json.receipts.find((r: { location?: string }) => r.location === 'archived').filename;
  assert.equal((await call('GET', `/receipts/${encodeURIComponent(receipt)}`)).status, 200);

  const unsupported = await call('POST', '/api/desktop/create', { ...SETUP, root: join(home, 'Saldo'), answers: { ...SETUP.answers, period: 'monthly' } });
  assert.deepEqual([unsupported.status, unsupported.json.code, unsupported.json.params], [400, 'setup', { reason: 'unsupported', question: 'period', value: 'monthly' }]);
  assert.ok(!existsSync(join(home, 'Saldo')), 'a refused setup writes nothing');
  const noRate = await call('POST', '/api/desktop/create', { ...SETUP, root: join(home, 'Saldo'), answers: { ...SETUP.answers, vatMethod: 'net-rate', period: 'half-yearly' } });
  assert.deepEqual([noRate.status, noRate.json.code, noRate.json.params.reason], [400, 'setup', 'netRates']);
  const unknown = await call('POST', '/api/desktop/create', { ...SETUP, root: join(home, 'Saldo'), answers: { ...SETUP.answers, vatMethod: 'saldo' } });
  assert.deepEqual([unknown.status, unknown.json.params], [400, { reason: 'missing', question: 'vatMethod' }]);
  assert.ok(!existsSync(join(home, 'Saldo')), 'a refused setup writes nothing');
  const badIban = await call('POST', '/api/desktop/create', { ...SETUP, root: join(home, 'Iban'), banks: [{ bank: 'UBS', currency: 'CHF', iban: 'CH00 0000' }] });
  assert.equal(badIban.json.params.reason, 'iban');

  const created = await call('POST', '/api/desktop/create', { ...SETUP, root: join(home, 'Neu') });
  assert.equal(created.status, 200, created.text);
  assert.equal((await call('GET', '/api/workspace')).json.company.name, 'Neu Test GmbH');
  assert.equal((await call('GET', '/api/workspace')).json.demo, undefined, 'a person\'s own books are no demo');
  const commits = await git.log({ fs, dir: join(home, 'Neu') });
  assert.deepEqual(commits.map((c) => c.commit.message.trim()), ['Workspace set up'], 'new books are committed as npm run init commits them');
  assert.ok((await git.statusMatrix({ fs, dir: join(home, 'Neu') })).every(([, head, work, stage]) => head === 1 && work === 1 && stage === 1), 'everything written is in the commit');
  assert.equal((await call('GET', `/receipts/${encodeURIComponent(receipt)}`)).status, 404, 'files come from the books open now');
  assert.deepEqual((await call('GET', '/books.json')).json.journalEntries ?? [], []);

  const info = (await call('GET', '/api/desktop')).json;
  assert.deepEqual(info.recent.map((b: { name: string; demo: boolean }) => [b.name, b.demo]), [['Neu Test GmbH', false], [demoName, true]]);
  assert.equal((await call('POST', '/api/desktop/open', { root: join(home, 'Demo') })).status, 200);
  assert.equal((await call('GET', '/api/workspace')).json.company.name, demoName);
});

test('a request naming another host is refused (a page elsewhere cannot rebind its name to this port)', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path: '/books.json', headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
  });
  assert.equal(status, 403);
});

test('claude: found on the login PATH as a program, not as a name; without it, a model feature answers noClaude and the books stay as they were', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
  chmodSync(join(bin, 'claude'), 0o755);
  assert.equal(programOn(`/nonexistent:${bin}:/usr/bin`, 'claude'), join(bin, 'claude'));
  assert.equal(programOn('/nonexistent:relative/bin', 'claude'), undefined);

  // As the app runs: PATH /usr/bin:/bin, the CLI known only by CLAUDE_BIN, its node in its own folder.
  const path = process.env.PATH;
  const found = mkdtempSync(join(tmpdir(), 'login-bin-'));
  copyFileSync(join(APP_ROOT, 'tests/support/stub-bin/claude'), join(found, 'claude'));
  symlinkSync(process.execPath, join(found, 'node'));
  process.env.PATH = '/usr/bin:/bin';
  process.env.CLAUDE_BIN = join(found, 'claude');
  try {
    assert.equal(await modelReady(), true, 'the inbox job finds the CLI by CLAUDE_BIN');
    process.env.CLAUDE_BIN = join(home, 'no-such-claude');
    assert.equal(await modelReady(), false);
  } finally {
    process.env.PATH = path;
  }
  try {
    await assert.rejects(ask('hi', { step: 'receipt-titles' }), NoClaudeError);
    const before = (await call('GET', '/books.json')).text;
    const receipts = JSON.parse(before).receipts as Array<{ id: string }>;
    let answer: Awaited<ReturnType<typeof call>> | undefined;
    for (const r of receipts) {
      answer = await call('POST', '/api/vision/extract', { receiptId: r.id });
      if (answer.status !== 403) break;
    }
    assert.deepEqual([answer?.status, answer?.json.code], [503, 'noClaude']);
    assert.equal((await call('GET', '/books.json')).text, before);
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});

test('the SMTP password: npm start keeps it in .env; the app saves it through Firma into its sealed store, per books', async () => {
  const mail = { host: 'smtp.example.test', port: 587, security: 'starttls', user: 'rechnungen', fromAddress: 'rechnungen@example.test' };
  assert.equal((await call('PATCH', '/api/workspace', { outgoingMail: mail })).status, 200);
  assert.deepEqual((await call('GET', '/api/mail')).json, { configured: true, password: 'missing', where: 'VANILLA_SMTP_PASSWORD in .env', inApp: false });
  assert.equal((await call('PUT', '/api/mail/password', { password: 'geheim' })).status, 409, 'under npm start the password is not saved by the app');

  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const file = join(home, 'secrets.json');
  useSecretStore(sealedStore({ file, cipher: { isEncryptionAvailable: () => true, encryptString: (s) => xor(Buffer.from(s)), decryptString: (b) => xor(b).toString() }, books: () => desktop.current()?.root }));
  try {
    assert.equal((await call('GET', '/api/mail')).json.inApp, true);
    assert.equal((await call('PUT', '/api/mail/password', { password: '' })).status, 400);
    assert.equal((await call('PUT', '/api/mail/password', { password: 'geheim' })).status, 200);
    assert.equal((await call('GET', '/api/mail')).json.password, 'set');
    assert.ok(!readFileSync(file, 'utf8').includes('geheim'));
    assert.ok(!readFileSync(workspaceAt(desktop.current()!.root).paths.manifest, 'utf8').includes('geheim'), 'the books never hold it');
  } finally {
    useSecretStore(envSecrets);
  }
});

test('the recent list says why books cannot be opened: a folder that is gone has no name, a refused manifest carries the reader\'s words', async () => {
  const refused = join(home, 'Refused');
  mkdirSync(join(refused, APP_FOLDER), { recursive: true });
  writeFileSync(join(refused, APP_FOLDER, MANIFEST_FILE), readFileSync(join(DEMO_ROOT, MANIFEST_FILE), 'utf8').replace('uid: CHE-123.456.789', 'uid: nicht'));
  const was = readState(join(home, 'desktop.json'));
  writeState(join(home, 'desktop.json'), { ...was, recent: [refused, join(home, 'Gone'), ...was.recent] });
  const [problem, gone, ...rest] = (await call('GET', '/api/desktop')).json.recent as { root: string; name?: string; problem?: string }[];
  assert.equal(problem.name, undefined);
  assert.match(problem.problem!, /company\.uid "nicht" must look like CHE-/);
  assert.deepEqual(gone, { root: join(home, 'Gone'), demo: false }, 'neither a name nor a problem: the folder is gone');
  assert.ok(rest.every((b) => b.name && !b.problem));
  mkdirSync(join(home, 'Documents', 'Buchhaltung 2026'), { recursive: true });
  assert.deepEqual((await call('GET', '/api/desktop')).json.folders, ['Buchhaltung 2026'], 'the folders in the books home, so a new default name steps aside');
});

test('a demo copy an app before 0.4.0 made (books.json at its top) is replaced by a fresh copy when the demo is opened', async () => {
  rmSync(join(home, 'Demo'), { recursive: true, force: true });
  writeOldLayout(DEMO_ROOT, join(home, 'Demo'));
  assert.ok(existsSync(join(home, 'Demo', 'books.json')));
  const demo = await call('POST', '/api/desktop/demo');
  assert.equal(demo.status, 200, demo.text);
  assert.ok(!existsSync(join(home, 'Demo', 'books.json')), 'the old copy is gone');
  assert.deepEqual((await call('GET', '/books.json')).json, JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT)))));
});

test('books in the layout before 0.4.0 are refused with oldLayout; /api/desktop/upgrade moves them as npm run update does, seals intact, and opens them', async () => {
  const repo = join(home, 'Alt');
  writeOldLayout(DEMO_ROOT, repo);
  const refused = await call('POST', '/api/desktop/open', { root: repo });
  assert.deepEqual([refused.status, refused.json.code, refused.json.params], [400, 'oldLayout', { root: repo }]);
  assert.ok(existsSync(join(repo, 'books.json')), 'a refusal moves nothing');
  const upgraded = await call('POST', '/api/desktop/upgrade', { root: repo });
  assert.equal(upgraded.status, 200, upgraded.text);
  assert.equal(upgraded.json.name, workspaceAt(DEMO_ROOT).company.name);
  assert.ok(!existsSync(join(repo, 'books.json')) && existsSync(join(repo, APP_FOLDER, 'ledger.json')), 'the books moved into vanilla-accounting/');
  assert.ok(existsSync(join(repo, APP_FOLDER, 'data', 'backups', 'books.json.schema-none')), 'books.json stays as a backup');
  const books = loadBooks(workspaceAt(repo));
  assert.ok(sealsOf(books).checks.length > 0 && sealsOf(books).checks.every((c) => c.status === 'intact'), 'every filed quarter\'s seal holds');
  assert.deepEqual((await call('GET', '/books.json')).json.journalEntries.length, books.journalEntries.length);
  assert.equal((await call('GET', '/api/desktop')).json.recent[0].name, upgraded.json.name, 'the moved books lead the recent list');
});
