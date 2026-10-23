/**
 * «Neue Buchhaltung anlegen» as one flow (#139): the setup conversation before the books exist
 * (src/onboarding/draft.ts) as a state machine, its draft on disk resumed after a break, the form
 * when no AI answers, and the same manifest from the conversation as from the form. Each test names
 * the wrong behaviour it catches.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import git from 'isomorphic-git';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { draftSteps, newDraft, requestOf, withPatch, type DraftPatch, type SetupDraft } from '../src/onboarding/draft.js';
import { draftFile } from '../src/onboarding/draft-store.js';
import { finishSetup, readProgress, setupView, startSetup } from '../src/onboarding/store.js';
import { APP_FOLDER, MANIFEST_FILE, workspaceAt } from '../src/workspace/workspace.js';

const NOW = '2026-10-23T09:00:00.000Z';
const FIRM = { name: 'Flow Test GmbH', uid: 'CHE-153.004.184', owner: 'Erika Flow' };
const at = (d: SetupDraft) => draftSteps(d).at(-1)!;
const play = (d: SetupDraft, ...patches: DraftPatch[]) => patches.reduce(withPatch, d);

test('the conversation stops at the first step not answered, and asks the VAT questions even when a preset answers the rest', () => {
  let d = newDraft('de', NOW);
  assert.deepEqual(draftSteps(d).map((s) => s.id), ['firm'], 'nothing is asked before the firm');
  d = play(d, { step: 'firm', value: FIRM });
  assert.equal(at(d).id, 'preset');
  d = play(d, { step: 'preset', value: 'consultant' });
  const vat = at(d);
  assert.ok(vat.id === 'question' && vat.key === 'vatRegistered', 'a preset does not settle the VAT setup');
  assert.equal(vat.suggested, 'yes', 'the preset suggests its VAT answer');
  assert.equal(d.answers.employees, 'owner', 'the preset fills the questions it answers');
  d = play(d, { step: 'question', key: 'vatRegistered', value: 'yes' }, { step: 'question', key: 'vatMethod', value: 'net-rate' }, { step: 'question', key: 'basis', value: 'received' });
  const period = at(d);
  assert.ok(period.id === 'question' && period.key === 'period' && period.suggested === 'half-yearly', 'the period follows the method');
  d = play(d, { step: 'question', key: 'period', value: 'half-yearly' });
  assert.equal(at(d).id, 'netRates', 'the net tax rate method asks its rates');
  assert.equal(requestOf(d), undefined, 'no request while a step waits');
  d = play(d, { step: 'netRates', value: [{ rate: 4.5, label: 'Beratung' }] });
  assert.equal(at(d).id, 'banks');
  d = play(d, { step: 'banks', value: [{ bank: 'UBS', currency: 'CHF', account: '1020' }] });
  const review = at(d);
  assert.equal(review.id, 'review');
  assert.equal(review.id === 'review' && review.request.netRates?.[0].rate, 4.5);
});

test('taking back an answer makes the steps after it wait and keeps their answers; one the preset gave turns the preset into custom', () => {
  const done = play(newDraft('de', NOW), { step: 'firm', value: FIRM }, { step: 'preset', value: 'consultant' },
    { step: 'question', key: 'vatRegistered', value: 'no' }, { step: 'banks', value: [{ bank: 'UBS', currency: 'CHF', account: '1020' }] });
  assert.equal(at(done).id, 'review');
  const back = withPatch(done, { step: 'firm', value: null });
  assert.deepEqual(draftSteps(back).map((s) => s.id), ['firm'], 'the steps after it wait');
  assert.equal(at(withPatch(back, { step: 'firm', value: FIRM })).id, 'review', 'their answers come back with it');

  const changed = withPatch(done, { step: 'question', key: 'imports', value: null });
  assert.equal(changed.preset, 'custom', 'a preset answer taken back makes the preset custom');
  const asked = at(changed);
  assert.ok(asked.id === 'question' && asked.key === 'imports', 'the question taken back is asked in the conversation');
  assert.ok(draftSteps(changed).some((s) => s.id === 'question' && s.key === 'foreignCustomers' && s.answer === 'yes'), 'the others the preset gave show as given');
});

test('a VAT method left over from «yes» does not reach the books after «no»', () => {
  const d = play(newDraft('de', NOW), { step: 'firm', value: FIRM }, { step: 'preset', value: 'consultant' },
    { step: 'question', key: 'vatRegistered', value: 'yes' }, { step: 'question', key: 'vatMethod', value: 'effective' },
    { step: 'question', key: 'vatRegistered', value: 'no' }, { step: 'banks', value: [{ bank: 'UBS', currency: 'CHF', account: '1020' }] });
  assert.equal(requestOf(d)?.answers.vatMethod, undefined);
});

// ─── The desktop server ──────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), 'vanilla-flow-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
let ai = true;
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function start() {
  const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist, aiAvailable: async () => ai });
  const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  desktop.allowHost(`127.0.0.1:${port}`);
  return {
    desktop,
    async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => undefined) };
    },
  };
}

const ANSWERS = {
  legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly', fiscalYear: 'calendar', start: 'new',
  sells: ['services'], foreignCustomers: 'yes', imports: 'no', employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
};
const BANKS = [{ bank: 'UBS', currency: 'CHF' }];

test('no AI on this computer: the start screen is told so, and takes the form', async () => {
  const { call } = await start();
  ai = false;
  assert.deepEqual((await call('GET', '/api/desktop/ai')).json, { available: false });
  ai = true;
  assert.deepEqual((await call('GET', '/api/desktop/ai')).json, { available: true });
});

test('a setup broken off resumes where it stood: the folder opens into it, from the recent list too, after a restart', async () => {
  const root = join(home, 'Buchhaltung 2026');
  let { call } = await start();
  const begun = await call('POST', '/api/desktop/setup', { root, language: 'fr' });
  assert.equal(begun.json.kind, 'draft');
  assert.ok(existsSync(draftFile(root)), 'the folder holds the draft from the first answer on');
  assert.ok(!existsSync(join(root, APP_FOLDER, MANIFEST_FILE)), 'and no manifest');
  const badUid = await call('PUT', '/api/desktop/setup', { root, patch: { step: 'firm', value: { ...FIRM, uid: 'CHE-123' } } });
  assert.deepEqual([badUid.status, badUid.json.params.reason], [400, 'uid'], 'an answer createWorkspace would refuse is refused as it is given');
  await call('PUT', '/api/desktop/setup', { root, patch: { step: 'firm', value: FIRM } });
  const agreed = await call('PUT', '/api/desktop/setup', { root, patch: { step: 'question', key: 'basis', value: 'agreed' } });
  assert.deepEqual(agreed.json.params, { reason: 'unsupported', question: 'basis', value: 'agreed' });
  await call('PUT', '/api/desktop/setup', { root, patch: { step: 'preset', value: 'consultant' } });

  ({ call } = await start());
  const recent = (await call('GET', '/api/desktop')).json.recent;
  assert.deepEqual(recent.map((b: { name?: string; setup?: boolean }) => [b.name, b.setup]), [[FIRM.name, true]], 'the recent list shows the setup by the firm\'s name');
  const opened = await call('POST', '/api/desktop/open', { root });
  assert.deepEqual([opened.status, opened.json.setup], [200, true], 'opening the folder answers with the setup, not a refusal');
  const view = (await call('GET', `/api/desktop/setup?root=${encodeURIComponent(root)}`)).json;
  assert.equal(view.draft.language, 'fr');
  const next = draftSteps(view.draft).at(-1)!;
  assert.ok(next.id === 'question' && next.key === 'vatRegistered', 'it stands at the step it stopped at');
  const again = await call('POST', '/api/desktop/setup', { root, language: 'de' });
  assert.deepEqual(again.json.view.draft, view.draft, '«Weiter» on the same folder continues the draft, never starts it anew');
});

test('the conversation and the form write the same manifest; the conversation\'s books carry no draft and open into the setup until «Los geht\'s»', async () => {
  const { call } = await start();
  const talked = join(home, 'Gespräch');
  await call('POST', '/api/desktop/setup', { root: talked, language: 'de' });
  const patches: DraftPatch[] = [
    { step: 'firm', value: FIRM }, { step: 'preset', value: 'consultant' },
    ...(['vatRegistered', 'vatMethod', 'basis', 'period'] as const).map((key): DraftPatch => ({ step: 'question', key, value: ANSWERS[key] })),
    { step: 'banks', value: BANKS },
  ];
  for (const patch of patches) assert.equal((await call('PUT', '/api/desktop/setup', { root: talked, patch })).status, 200);
  const created = await call('POST', '/api/desktop/setup/create', { root: talked });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.setup, undefined, 'the books are open, no setup draft any more');
  assert.equal((await call('GET', '/api/workspace')).json.company.name, FIRM.name);

  const byHand = join(home, 'Formular');
  const form = await call('POST', '/api/desktop/create', { root: byHand, preset: 'consultant', ...FIRM, language: 'de', answers: ANSWERS, banks: BANKS });
  assert.equal(form.status, 200, JSON.stringify(form.json));
  const manifest = (root: string) => readFileSync(join(root, APP_FOLDER, MANIFEST_FILE), 'utf8');
  assert.equal(manifest(talked), manifest(byHand));

  assert.ok(!existsSync(draftFile(talked)), 'the draft is gone once the books exist');
  const files = (await git.listFiles({ fs, dir: talked })).filter((f) => f.endsWith('setup-draft.json'));
  assert.deepEqual(files, [], 'the first commit never holds the draft');

  const ws = workspaceAt(talked);
  const progress = readProgress(ws);
  assert.deepEqual([progress.answers.company?.value, progress.answers.vat?.value, progress.answers.sells?.value], ['ok', 'effective', 'services'], 'what was asked before the books existed stands answered');
  const empty = { transactions: [], receipts: [], journalEntries: [] };
  assert.equal(setupView(ws, empty).opensItself, true);
  startSetup(ws, NOW);
  assert.equal(setupView(ws, empty).opensItself, true, 'opening and closing the setup does not end it');
  finishSetup(ws, NOW);
  assert.equal(setupView(ws, empty).opensItself, false, 'after «Los geht\'s» the books open as books');
  assert.equal(setupView(workspaceAt(byHand), { ...empty, transactions: [{}] as never }).opensItself, false, 'books set up by the form never open the setup once in use');
});

test('books that came into the folder of a setup are opened as they are, their setup untouched', async () => {
  const { call } = await start();
  const root = join(home, 'Beides');
  await call('POST', '/api/desktop/setup', { root, language: 'de' });
  for (const patch of [{ step: 'firm', value: FIRM }, { step: 'preset', value: 'freelancer' }, { step: 'question', key: 'vatRegistered', value: 'no' }, { step: 'banks', value: BANKS }]) await call('PUT', '/api/desktop/setup', { root, patch });
  const other = join(home, 'Andere');
  assert.equal((await call('POST', '/api/desktop/create', { root: other, preset: 'consultant', ...FIRM, name: 'Andere GmbH', language: 'de', answers: ANSWERS, banks: BANKS })).status, 200);
  fs.cpSync(join(other, APP_FOLDER), join(root, APP_FOLDER), { recursive: true, filter: (f) => !f.endsWith('setup-draft.json') });
  const opened = await call('POST', '/api/desktop/setup/create', { root });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.name, 'Andere GmbH');
  assert.equal(readProgress(workspaceAt(root)).created, undefined, 'books the conversation did not create are not marked as created by it');
});
