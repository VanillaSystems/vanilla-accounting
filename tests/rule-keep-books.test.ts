/**
 * #383 on the real API server: a rule kept books the open payments it decides at once (no inbox run
 * needed), once: a second inbox run books nothing more. A rule for wages on the wage account asks no
 * VAT and books without a code; a payment that waits for its receipt is shown waiting on the card and
 * is not booked by the keep; «Rückgängig» takes the rule and its bookings back.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { PERSON, loadBooks, saveBooks, update } from '../src/books/store.js';
import type { DraftView, KeepResult } from '../src/saving/rules.js';
import type { WageOffer } from '../src/saving/wage-rule.js';

const servers: ApiServer[] = [];
const dirs: string[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The demo's manifest on a firm with staff, so the wages need no receipt (ev-exempt-wages). */
function employer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'employer-manifest-'));
  dirs.push(dir);
  const demo = readFileSync(join(APP_ROOT, 'demo', APP_FOLDER, 'belege.workspace.yaml'), 'utf8');
  writeFileSync(join(dir, 'belege.workspace.yaml'), `${demo.trimEnd()}
profile:
  preset: trades
  fiscalYear: calendar
  start: new
  sells: services
  foreignCustomers: no
  imports: no
  employees: staff
  ownerPaysPrivately: no
  privateUse: []
  payouts: no
`);
  return dir;
}

const WAGES = ['L1', 'L2', 'L3', 'L4'];

test('a wage rule asks no VAT, shows the four open wages it books, and keeping it books them at once and once', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: employer() });
  servers.push(api);
  assert.equal((await api.send('PUT', '/api/accounts/5000', { name: 'Lohnaufwand' })).status, 200);
  const inbox = async () => {
    assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } })).json.ok, true);
    await api.rest();
  };
  const wageTasks = async () => ((await api.send('GET', '/api/automation')).json as unknown as { tasks: Array<{ item: { id: string } }> }).tasks.filter((t) => WAGES.includes(t.item.id)).length;
  // Each wage a task «Zahlung von Hand buchen», as the inbox run leaves it without an AI (workflows/ask, noModel).
  for (const id of WAGES) assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'ask', item: { kind: 'transaction', id } })).json.ok, true);
  await api.rest();
  assert.equal(await wageTasks(), 4);
  const made = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: '\\bLohn\\b' }, direction: 'out', account: '5000' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const path = String(made.json.path);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as unknown as DraftView;
  assert.deepEqual(card.vatAsks, [], 'a wage account takes no VAT code: nothing to ask');
  assert.equal(card.added[0].rule?.then.booking?.vat, null, 'booked without a code');
  assert.deepEqual([...card.preview[0].open!.book].sort(), WAGES);
  assert.deepEqual(card.preview[0].open!.waits, []);

  const kept = (await api.send('POST', '/api/rules/draft', { kind: 'keep', path, basis: card.basis, confirm: true })).json as unknown as KeepResult;
  assert.ok(kept.ok, JSON.stringify(kept));
  assert.deepEqual([...kept.booked!.refs].sort(), WAGES, JSON.stringify(kept));
  assert.deepEqual(kept.booked!.notBooked, []);
  const books = loadBooks(api.ws);
  const wages = books.journalEntries.filter((e) => WAGES.includes(e.transactionRef));
  assert.equal(wages.length, 4);
  assert.ok(wages.every((e) => e.accountDebit === '5000' && !e.vatCode && e.rule), JSON.stringify(wages));
  assert.deepEqual([...kept.booked!.entries].sort(), wages.map((e) => e.id).sort());
  assert.equal(await wageTasks(), 0, 'their tasks closed');

  // A second inbox run, and a booking run per wage, find nothing of theirs to book.
  const before = books.journalEntries.length;
  await inbox();
  for (const id of WAGES) assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'booking', item: { kind: 'transaction', id } })).json.ok, true);
  await api.rest();
  const again = loadBooks(api.ws);
  assert.equal(again.journalEntries.filter((e) => WAGES.includes(e.transactionRef)).length, 4, 'booked once');
  assert.equal(again.journalEntries.length, before);
});

test('«Rückgängig» of a keep: the rule file goes (it was the first), the keep\'s bookings go, one the person changed since stays and is named, the others are tasks again', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: employer() });
  servers.push(api);
  assert.equal((await api.send('PUT', '/api/accounts/5000', { name: 'Lohnaufwand' })).status, 200);
  // Each wage a task «Zahlung von Hand buchen», as the inbox run leaves it without an AI.
  for (const id of WAGES) assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'ask', item: { kind: 'transaction', id } })).json.ok, true);
  await api.rest();
  const path = String((await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: '\\bLohn\\b' }, direction: 'out', account: '5000' })).json.path);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as unknown as DraftView;
  const kept = (await api.send('POST', '/api/rules/draft', { kind: 'keep', path, basis: card.basis, confirm: true })).json as unknown as KeepResult;
  assert.ok(kept.ok && kept.booked && kept.undo, JSON.stringify(kept));
  assert.equal(kept.undo.before, '', 'no rules file before');
  assert.deepEqual([kept.booked.entries.length, kept.booked.running], [4, 0]);
  assert.deepEqual(((await api.send('POST', '/api/rules/kept', { keep: kept.keep!.id })).json.booked as { refs: string[] }).refs, kept.booked.refs, 'asked again: the same state');
  // She changes one of the rule's bookings by hand (its id stays).
  const changed = loadBooks(api.ws).journalEntries.find((e) => e.transactionRef === 'L1')!;
  assert.equal((await api.send('PATCH', `/api/journal-entries/${changed.id}`, { description: 'Lohn Juli Max' })).status, 200);

  const undone = (await api.send('POST', '/api/rules/kept/undo', { keep: kept.keep!.id })).json;
  assert.deepEqual([undone.ok, undone.removed, undone.left], [true, 3, { changed: 1, closed: 0, gone: 0, other: 0 }], JSON.stringify(undone));
  assert.equal(existsSync(join(api.ws.paths.root, path)), false, 'the first rules file is gone again, not left empty');
  const books = loadBooks(api.ws);
  assert.deepEqual(books.journalEntries.map((e) => e.transactionRef), ['L1'], 'only the changed booking stays');
  assert.ok(books.transactions.every((t) => !t.waitsForPerson), 'no mark of a deletion');
  await api.rest();
  const tasks = ((await api.send('GET', '/api/automation')).json as unknown as { tasks: Array<{ item: { id: string } }> }).tasks.map((t) => t.item.id).sort();
  assert.deepEqual(tasks, ['L2', 'L3', 'L4'], 'their tasks are there again');
});

test('the open wages of a firm with staff: code offers their rule (text, money out, the wage account, no code); one decision on the card books them', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: employer() });
  servers.push(api);
  assert.equal((await api.send('GET', '/api/rules/wages')).json.offer, null, 'no wage account in the chart: nothing offered');
  assert.equal((await api.send('PUT', '/api/accounts/5000', { name: 'Lohnaufwand' })).status, 200);
  const offer = (await api.send('GET', '/api/rules/wages')).json.offer as unknown as WageOffer;
  assert.deepEqual([offer.text, offer.account, [...offer.refs].sort(), offer.rule], ['Lohn', '5000', WAGES, { match: { kind: 'text', text: '\\bLohn\\b' }, direction: 'out', account: '5000', vat: null }], '«Lohnausweis Druck» is no wage');
  const path = String((await api.send('POST', '/api/rules/hand', offer.rule)).json.path);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as unknown as DraftView;
  assert.deepEqual([card.vatAsks, card.confirm, [...card.preview[0].open!.book].sort()], [[], true, WAGES], 'a rule on one word: «Trotzdem behalten», with its payments shown');
  const kept = (await api.send('POST', '/api/rules/draft', { kind: 'keep', path, basis: card.basis, confirm: true })).json as unknown as KeepResult;
  assert.ok(kept.ok && kept.booked?.refs.length === 4, JSON.stringify(kept));
  assert.equal((await api.send('GET', '/api/rules/wages')).json.offer, null, 'booked: nothing left to offer');
});

test('a firm without staff: no wage rule is offered', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json');
  servers.push(api);
  assert.equal((await api.send('PUT', '/api/accounts/5000', { name: 'Lohnaufwand' })).status, 200);
  assert.equal((await api.send('GET', '/api/rules/wages')).json.offer, null);
});

test('payments that wait for their receipt: the card says they wait, the keep books none of them', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: employer() });
  servers.push(api);
  // «Belastung E-Banking Auftrag» of six suppliers: purchases that need a receipt, none linked.
  const made = await api.send('POST', '/api/rules/hand', { match: { kind: 'payer', payer: 'Garage Huber' }, direction: 'out', account: '6570', vat: '0' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const path = String(made.json.path);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as unknown as DraftView;
  const p = card.preview[0];
  assert.deepEqual([p.open!.book, p.open!.waits], [[], ['B2']]);
  assert.equal(p.examples[0].waits, true, JSON.stringify(p.examples[0]));
  const kept = (await api.send('POST', '/api/rules/draft', { kind: 'keep', path, basis: card.basis, confirm: true })).json as unknown as KeepResult;
  assert.ok(kept.ok, JSON.stringify(kept));
  assert.equal(kept.booked, undefined, 'nothing to book at the keep');
  assert.equal(loadBooks(api.ws).journalEntries.length, 0);
});

// ─── #396, #392: the server records each keep; its line and its undo go by the keep's id alone ─────

type Kept = Extract<KeepResult, { ok: true }>;
type KeptLine = { id: string; file: string; rules: string[]; booked: { refs: string[]; running: number }; waits: number; blocked?: string; ended?: string };

/** A rule drafted by hand and kept as its card shows it. */
async function keepRule(api: ApiServer, rule: unknown): Promise<Kept> {
  const made = await api.send('POST', '/api/rules/hand', rule);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const path = String(made.json.path);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as unknown as DraftView;
  const kept = (await api.send('POST', '/api/rules/draft', { kind: 'keep', path, basis: card.basis, confirm: true })).json as unknown as KeepResult;
  assert.ok(kept.ok, JSON.stringify(kept));
  await api.rest();
  return kept;
}

const lines = async (api: ApiServer) => ((await api.send('GET', '/api/rules/kept')).json as unknown as { kept: KeptLine[] }).kept;
const WAGE_RULE = { match: { kind: 'text', text: '\\bLohn\\b' }, direction: 'out', account: '5000' };
const DEPOSIT_RULE = { match: { kind: 'text', text: 'Einlage' }, direction: 'in', account: '2850' };

async function employerApi(): Promise<ApiServer> {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: employer() });
  servers.push(api);
  assert.equal((await api.send('PUT', '/api/accounts/5000', { name: 'Lohnaufwand' })).status, 200);
  assert.equal((await api.send('PUT', '/api/accounts/2850', { name: 'Privat' })).status, 200);
  assert.equal((await api.send('PUT', '/api/accounts/6570', { name: 'Informatikaufwand' })).status, 200);
  return api;
}

test('two keeps of one rules file: each has its own line, the first one\'s undo waits for the second\'s, and the second\'s undo takes back only its rule and its booking', async () => {
  const api = await employerApi();
  const wages = await keepRule(api, WAGE_RULE);
  const deposit = await keepRule(api, DEPOSIT_RULE);
  assert.ok(wages.keep && deposit.keep, 'the server records each keep');
  assert.equal(wages.undo?.file, deposit.undo?.file, 'both rules in the same file');
  const shown = await lines(api);
  assert.deepEqual(shown.map((l) => [l.id, [...l.booked.refs].sort(), l.blocked]), [[wages.keep.id, WAGES, 'later'], [deposit.keep.id, ['K2'], undefined]], 'one line per keep, true to its own numbers');

  const refused = (await api.send('POST', '/api/rules/kept/undo', { keep: wages.keep.id })).json;
  assert.deepEqual([refused.ok, refused.refusal], [false, 'later'], JSON.stringify(refused));
  assert.equal(loadBooks(api.ws).journalEntries.length, 5, 'nothing taken back');

  const undone = (await api.send('POST', '/api/rules/kept/undo', { keep: deposit.keep.id })).json;
  assert.deepEqual([undone.ok, undone.removed], [true, 1], JSON.stringify(undone));
  await api.rest();
  const books = loadBooks(api.ws);
  assert.deepEqual(books.journalEntries.map((e) => e.transactionRef).sort(), WAGES, 'the wages stay booked, the deposit is not');
  const file = readFileSync(join(api.ws.paths.root, wages.undo!.file), 'utf8');
  assert.match(file, /5000/);
  assert.doesNotMatch(file, /2850/, 'the deposit rule is gone, the wage rule stays');
  assert.deepEqual((await lines(api)).map((l) => [l.id, l.blocked]), [[wages.keep.id, undefined]], 'the first keep\'s line stays, its undo free now');
  // The undo's deletion is recorded for Änderungen as a deletion by hand is.
  assert.ok(existsSync(join(api.ws.paths.data, 'trash', 'entries')), 'recorded for Änderungen');
  const again = await api.send('POST', '/api/rules/kept/undo', { keep: deposit.keep.id });
  assert.equal(again.status, 404, 'a keep taken back is gone');
});

test('the undo of a keep puts back the mark of a booking she deleted before it', async () => {
  const api = await employerApi();
  const made = await api.send('POST', '/api/journal-entries', { date: '2026-08-05', description: 'Einlage', accountDebit: '1020', accountCredit: '2850', amount: 3000, transactionRef: 'K2' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = String((made.json.entry as { id: string } | undefined)?.id ?? made.json.id);
  assert.equal((await api.send('DELETE', `/api/journal-entries/${id}`)).status, 200);
  const mark = loadBooks(api.ws).transactions.find((t) => t.ref === 'K2')!.waitsForPerson;
  assert.equal(mark?.why, 'bookingDeleted');
  const deposit = await keepRule(api, DEPOSIT_RULE);
  assert.deepEqual(deposit.booked?.refs, ['K2'], JSON.stringify(deposit));
  const undone = (await api.send('POST', '/api/rules/kept/undo', { keep: deposit.keep!.id })).json;
  assert.equal(undone.ok, true, JSON.stringify(undone));
  await api.rest();
  const books = loadBooks(api.ws);
  assert.ok(!books.journalEntries.some((e) => e.transactionRef === 'K2'));
  assert.deepEqual(books.transactions.find((x) => x.ref === 'K2')!.waitsForPerson, mark, 'the mark is there again');
});

test('a period closed between the keep and its undo: the undo is gone, said why, and nothing is taken back', async () => {
  const api = await employerApi();
  const wages = await keepRule(api, WAGE_RULE);
  assert.deepEqual([...wages.booked!.refs].sort(), WAGES);
  const ledger = JSON.parse(readFileSync(api.ws.paths.ledger, 'utf8')) as { config: Record<string, unknown> };
  writeFileSync(api.ws.paths.ledger, JSON.stringify({ ...ledger, config: { ...ledger.config, closedThrough: '2026-07-31' } }, null, 2) + '\n');
  const undone = (await api.send('POST', '/api/rules/kept/undo', { keep: wages.keep!.id })).json;
  assert.deepEqual([undone.ok, undone.refusal], [false, 'closed'], JSON.stringify(undone));
  assert.equal((await lines(api))[0]?.ended, 'closed', 'the line says why');
  await api.rest();
  assert.deepEqual(loadBooks(api.ws).journalEntries.map((e) => e.transactionRef).sort(), WAGES, 'the rule and all four bookings stay: the undo would take back only part');
});

const tasksOf = async (api: ApiServer) => ((await api.send('GET', '/api/automation')).json as unknown as { tasks: Array<{ item: { id: string }; why?: unknown }> }).tasks;

test('a payment a kept rule decides is no task «keine Regel der Firma passte»: booked by the rule, or, waiting for its receipt, no task at all', async () => {
  const api = await employerApi();
  // Garage Huber's payment (B2) waits for its receipt; its question «von Hand buchen» stands, as the inbox run leaves it without an AI.
  assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'ask', item: { kind: 'transaction', id: 'B2' } })).json.ok, true);
  await api.rest();
  assert.deepEqual((await tasksOf(api)).map((t) => t.item.id), ['B2']);
  const garage = await keepRule(api, { match: { kind: 'payer', payer: 'Garage Huber' }, direction: 'out', account: '6570', vat: '0' });
  assert.deepEqual([garage.booked, garage.keep?.waits], [undefined, 1], JSON.stringify(garage));
  assert.deepEqual(await tasksOf(api), [], 'the rule books it once its receipt is there: nothing for her to book by hand');
  // Its question asked again (an undo elsewhere, a later run): it ends without a task.
  assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'ask', item: { kind: 'transaction', id: 'B2' } })).json.ok, true);
  await api.rest();
  assert.deepEqual(await tasksOf(api), [], 'waits for its receipt, no «keine Regel passte»');
  const runs = ((await api.send('GET', '/api/automation')).json as unknown as { runs: Array<{ status: string; error?: string }> }).runs;
  assert.deepEqual(runs.filter((r) => r.status === 'stuck').map((r) => r.error), [], 'its run ended, it did not stick');

  // A wage the wage rule decides, unbooked again: the question books it by the rule.
  await keepRule(api, WAGE_RULE);
  const books = loadBooks(api.ws);
  update(books, PERSON, (b) => { b.journalEntries = b.journalEntries.filter((e) => e.transactionRef !== 'L1'); });
  saveBooks(api.ws, books);
  assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'ask', item: { kind: 'transaction', id: 'L1' } })).json.ok, true);
  await api.rest();
  assert.deepEqual(await tasksOf(api), []);
  const l1 = loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'L1');
  assert.ok(l1.length === 1 && l1[0].accountDebit === '5000' && l1[0].rule, JSON.stringify(l1));
});
