/**
 * The setup asks only what the books need (#452): no UID, and none of the answers that book nothing
 * differently. The books open without a UID; what needs it asks for it then, naming why and where:
 * the VAT return's XML (the review, the workflow's XML step, npm run vat-xml) and an invoice with VAT.
 * The answers the setup no longer asks take one that books nothing differently, marked as assumed in
 * the books, and are asked where they first matter.
 */
import { test, after } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { desktopServer } from '../src/desktop/server.js';
import { draftSteps, type DraftPatch } from '../src/onboarding/draft.js';
import { readProgress } from '../src/onboarding/store.js';
import { patchManifest } from '../src/workspace/manifest-write.js';
import { PRESETS, QUESTION_ORDER, SETUP_QUESTIONS, laterAnswer, type QuestionKey } from '../src/workspace/setup.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE, workspaceAt } from '../src/workspace/workspace.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED } from '../src/workspace/vat-setup.js';
import { missingForIssue } from '../src/invoices/rules.js';
import { openEngine } from '../src/workflows/engine.js';
import { filingXml } from '../src/workflows/filing.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { taskOf } from '../src/workflows/model.js';
import { approvalWithheld } from '../src/app/areas/automation/filing-summary.js';
import { loadBooks } from '../src/books/store.js';
import { messages as de } from '../src/app/i18n/locales/de.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'setup-essentials-runs-'));

const home = mkdtempSync(join(tmpdir(), 'vanilla-essentials-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function start() {
  const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist, aiAvailable: async () => false });
  const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  desktop.allowHost(`127.0.0.1:${port}`);
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => undefined) };
  };
}

const FIRM = { name: 'Malerei Essentials GmbH', owner: 'Sandra Beispiel' };
const BANKS = [{ bank: 'UBS', currency: 'CHF' }];
/** The answers the setup no longer asks (#452): none of them changes what is booked. */
const LATER: QuestionKey[] = ['fiscalYear', 'start', 'foreignCustomers', 'ownerPaysPrivately', 'privateUse', 'payouts'];
/** Of those, the ones nothing in the app changes (ANSWER_HAND null): not marked assumed, as nothing would let her change them. */
const NO_PLACE: QuestionKey[] = ['fiscalYear', 'foreignCustomers'];
const manifestOf = (root: string) => readFileSync(join(root, APP_FOLDER, MANIFEST_FILE), 'utf8');

test('the setup asks only what the books need: the UID and the answers that book nothing differently are not among its questions', () => {
  assert.deepEqual(QUESTION_ORDER.filter((k) => !SETUP_QUESTIONS.includes(k)), LATER);
  assert.deepEqual(LATER.map((k) => laterAnswer(k)), ['calendar', 'new', 'no', 'yes', [], 'no'], 'each takes the answer that books nothing differently');
});

test('the form without a UID and without the later answers: the books open, the manifest holds no UID, the later answers are assumed', async () => {
  const call = await start();
  const root = join(home, 'Formular');
  const essentials = Object.fromEntries(Object.entries(PRESETS.consultant.answers).filter(([k]) => !LATER.includes(k as QuestionKey)));
  const made = await call('POST', '/api/desktop/create', {
    root, preset: 'consultant', ...FIRM, uid: '', language: 'de', answers: { ...essentials, vatMethod: 'effective', basis: 'received' }, banks: BANKS,
    assumed: { by: 'consultant', answers: essentials },
  });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const ws = workspaceAt(root);
  assert.equal(ws.company.uid, undefined, 'no UID: the books open all the same');
  assert.doesNotMatch(manifestOf(root), /uid:/);
  const profile = parse(manifestOf(root)).profile;
  assert.deepEqual(LATER.map((k) => profile[k]), ['calendar', 'new', 'no', 'yes', [], 'no'], 'the later answers in the manifest as it always kept them');
  assert.ok(ws.bankAccounts.some((a) => a.role === 'owner'), 'the owner\'s account is there: an account more books nothing differently');
  const accounts = (JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string }>).map((a) => a.number);
  assert.ok(!accounts.includes('1093'), 'no clearing account: the drop row asks for it with the first payout report');
  const assumed = readProgress(ws).assumed?.answers ?? {};
  for (const k of LATER) assert.equal(k in assumed, !NO_PLACE.includes(k), `${k}: assumed in the books where she can change it; the fiscal year and the customers abroad have no place`);

  patchManifest(ws.paths.manifest, { company: { uid: 'CHE-153.004.184' } });
  assert.equal(workspaceAt(root).company.uid, 'CHE-153.004.184', 'entered later under Firma, it is kept');
  patchManifest(ws.paths.manifest, { company: { uid: '' } });
  assert.equal(workspaceAt(root).company.uid, undefined, 'and emptied there, it is gone again');
});

test('the conversation: the firm is its name and its owner; «Etwas anderes» asks only the legal form, what it sells, imports and staff besides the VAT', async () => {
  const call = await start();
  const root = join(home, 'Gespräch');
  await call('POST', '/api/desktop/setup', { root, language: 'de' });
  const put = async (patch: DraftPatch) => {
    const r = await call('PUT', '/api/desktop/setup', { root, patch });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  await put({ step: 'firm', value: FIRM as never });
  let view = await put({ step: 'preset', value: 'custom' });
  const asked: string[] = [];
  const answers: Record<string, string | string[]> = { vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly', legalForm: 'GmbH', sells: ['made', 'services'], imports: 'no', employees: 'staff' };
  for (;;) {
    const step = draftSteps(view.draft).at(-1)!;
    if (step.id !== 'question') break;
    asked.push(step.key);
    view = await put({ step: 'question', key: step.key, value: answers[step.key] });
  }
  assert.deepEqual(asked.sort(), ['basis', 'employees', 'imports', 'legalForm', 'period', 'sells', 'vatMethod', 'vatRegistered']);
  view = await put({ step: 'banks', value: BANKS });
  assert.equal(draftSteps(view.draft).at(-1)!.id, 'review');
  const created = await call('POST', '/api/desktop/setup/create', { root });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const ws = workspaceAt(root);
  assert.equal(ws.company.uid, undefined);
  assert.equal(ws.profile?.start, 'new');
  const assumed = readProgress(ws).assumed?.answers ?? {};
  for (const k of LATER) assert.equal(k in assumed, !NO_PLACE.includes(k), `${k}: assumed in the books only where she can change it`);
});

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;

test('an invoice with VAT asks for the UID, naming where it goes; an invoice of a firm not registered needs none', () => {
  const sender = { name: 'Malerei AG', uid: '', address: { street: 'Dorfstrasse', number: '3', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo: { account: '1020', iban: 'CH6580808000000000001', bank: 'UBS' } };
  const customer = { id: 'cu_1', createdAt: '', origin: 'manual' as const, deleted: false, name: 'Kunde AG', address: { street: 'Weg', number: '1', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
  const draft = (vatRate: 0 | 8.1) => ({ id: 'in_d', createdAt: '', origin: 'manual' as const, deleted: false, status: 'draft' as const, kind: 'invoice' as const, customerId: 'cu_1', date: '2026-10-05', currency: 'CHF' as const, language: 'de' as const, lines: [{ text: 'Malen', quantity: 1, price: 100, vatRate }], comments: [] });
  try {
    setJurisdiction(ch, EFFECTIVE_QUARTERLY);
    assert.ok(missingForIssue(draft(8.1), { customer, sender, invoices: [] }).some((m) => m.field === 'sender.uid'));
    assert.match(de['invoice.missing.sender.uid'], /Firma › Firma/, 'the words say where she enters it');
    setJurisdiction(ch, NOT_REGISTERED);
    assert.ok(!missingForIssue(draft(0), { customer, sender, invoices: [] }).some((m) => m.field === 'sender.uid'), 'no VAT on the invoice, no VAT number needed');
  } finally {
    setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  }
});

test('the VAT return without a UID: the review withholds the approval and names Firma; the XML step refuses in a code with words; npm run vat-xml refuses; entered, the run goes on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'essentials-filing-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const manifest = join(dir, MANIFEST_FILE);
  const uid = 'CHE-153.004.184';
  patchManifest(manifest, { company: { uid: '' } });
  let ws = workspaceAt(dir);
  assert.equal(ws.company.uid, undefined);

  const cli = spawnSync(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli/vat-ech0217.ts'), '2026-Q2'], { cwd: APP_ROOT, encoding: 'utf8', env: { ...process.env, VANILLA_WORKSPACE: dir } });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /UID/);
  assert.match(cli.stderr, /Firma › Firma/, 'the refusal says where to enter it');

  const w = loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((x) => x.id === 'vat-filing')!;
  const engine = openEngine(() => ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: '2026-Q2' }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const run = () => engine.run(r.run!)!;
  const review = taskOf(w, run())!;
  assert.equal(approvalWithheld(review, [], loadBooks(ws), undefined, { uid: undefined })?.uid, true, 'the review withholds «Freigegeben» and says why');
  assert.equal(approvalWithheld(review, [], loadBooks(ws), undefined, { uid }), undefined, 'with a UID it withholds nothing');
  assert.match(de['automation.uidMissing'], /Firma › Firma|Firma/);

  await engine.command({ kind: 'answer', run: r.run!, outcome: 'approved' });
  await engine.idle();
  const stuck = run().state;
  assert.equal(stuck.status, 'stuck');
  assert.deepEqual(stuck.status === 'stuck' ? stuck.why : undefined, { code: 'uidMissing', params: {} });
  assert.match(de['runWhy.uidMissing'], /Firma › Firma/);
  assert.equal(filingXml(ws, '2026-Q2'), undefined, 'no XML without the UID');

  patchManifest(manifest, { company: { uid } });
  ws = workspaceAt(dir);
  const resumed = await engine.command({ kind: 'resume', run: r.run! });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  await engine.idle();
  const st = run().state;
  assert.deepEqual([st.status, 'at' in st ? st.at : ''], ['waiting', 'submit'], JSON.stringify(st));
  assert.match(readFileSync(filingXml(ws, '2026-Q2')!, 'utf8'), /<eCH-0217:uid>CHE153004184<\/eCH-0217:uid>/);
});
