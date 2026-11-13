/**
 * #396 / #392, the review of PR #399 on the real API server: every keep that can hold another keep's
 * undo has a line; an undo is offered while it still means what it says («Rückgängig bis …»), and its
 * line says why when it is gone; keeps of two files stand apart; the undo restores exactly the tasks
 * the keep closed; a waiting payment counts as no question of its rule; a payment whose receipt cannot
 * be read is a task, never booked by a rule's ask run; «Automatisch buchen» for all books only what a
 * rule decides and names what it left.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { PERSON, loadBooks, saveBooks, update } from '../src/books/store.js';
import type { DraftView, KeepResult } from '../src/saving/rules.js';
import type { Receipt } from '../src/types/index.js';

const servers: ApiServer[] = [];
const dirs: string[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

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

type Kept = Extract<KeepResult, { ok: true }>;
type KeptLine = { id: string; booked: { refs: string[] }; waits: number; blocked?: string; blockedBy?: string[]; until?: string; ended?: string };

async function employerApi(): Promise<ApiServer> {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: employer() });
  servers.push(api);
  for (const [n, name] of [['5000', 'Lohnaufwand'], ['6570', 'Informatikaufwand']]) assert.equal((await api.send('PUT', `/api/accounts/${n}`, { name })).status, 200);
  return api;
}

async function keepRule(api: ApiServer, rule: unknown): Promise<Kept> {
  const made = await api.send('POST', '/api/rules/hand', rule);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const path = String(made.json.path);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as unknown as DraftView;
  const kept = (await api.send('POST', '/api/rules/draft', { kind: 'keep', path, basis: card.basis, confirm: true })).json as unknown as KeepResult;
  assert.ok(kept.ok && kept.keep, JSON.stringify(kept));
  await api.rest();
  return kept;
}

const lines = async (api: ApiServer) => ((await api.send('GET', '/api/rules/kept')).json as unknown as { kept: KeptLine[] }).kept;
const tasks = async (api: ApiServer) => ((await api.send('GET', '/api/automation')).json as unknown as { tasks: Array<{ item: { id: string } }> }).tasks.map((t) => t.item.id).sort();
const stuck = async (api: ApiServer) => ((await api.send('GET', '/api/automation')).json as unknown as { runs: Array<{ id: string; status: string; error?: string }> }).runs.filter((r) => r.status === 'stuck').map((r) => `${r.id}: ${r.error}`);
const ask = async (api: ApiServer, id: string) => { assert.equal((await api.send('POST', '/api/automation', { kind: 'start', workflow: 'ask', item: { kind: 'transaction', id } })).json.ok, true); await api.rest(); };
const WAGES = ['L1', 'L2', 'L3', 'L4'];
const WAGE_RULE = { match: { kind: 'text', text: '\\bLohn\\b' }, direction: 'out', account: '5000' };
const GARAGE_RULE = { match: { kind: 'payer', payer: 'Garage Huber' }, direction: 'out', account: '6570', vat: '0' };

/** Takes the bookings of these payments out of the books, as an edit outside the app would (no mark of a deletion). */
function unbook(api: ApiServer, refs: string[], mark?: string[]): void {
  const books = loadBooks(api.ws);
  update(books, PERSON, (b) => {
    b.journalEntries = b.journalEntries.filter((e) => !refs.includes(e.transactionRef));
    for (const t of b.transactions) if (mark?.includes(t.ref)) t.waitsForPerson = { since: '2026-11-01T00:00:00.000Z', why: 'bookingDeleted' };
  });
  saveBooks(api.ws, books);
}

test('a keep that books nothing has its line; closed, it stays while it holds an earlier keep, whose line names it and takes both back newest first', async () => {
  const api = await employerApi();
  const wages = await keepRule(api, WAGE_RULE);
  const none = await keepRule(api, { match: { kind: 'text', text: 'Nirgendwo' }, direction: 'out', account: '5000' });
  assert.equal(none.undo?.file, wages.undo?.file);
  let shown = await lines(api);
  assert.deepEqual(shown.map((l) => [l.id, l.booked.refs.length, l.blockedBy ?? []]), [[wages.keep!.id, 4, [none.keep!.id]], [none.keep!.id, 0, []]], JSON.stringify(shown));
  assert.equal((await api.send('POST', '/api/rules/kept/close', { keep: none.keep!.id })).status, 200);
  shown = await lines(api);
  assert.deepEqual(shown.map((l) => l.id), [wages.keep!.id, none.keep!.id], 'closed, it still holds the wage line: it stays');
  const both = (await api.send('POST', '/api/rules/kept/undo', { keep: wages.keep!.id, withLater: true })).json;
  assert.deepEqual([both.ok, both.removed], [true, 4], JSON.stringify(both));
  await api.rest();
  assert.equal(existsSync(join(api.ws.paths.root, wages.undo!.file)), false, 'both rules gone: the file was the first');
  assert.equal(loadBooks(api.ws).journalEntries.length, 0);
  assert.deepEqual(await lines(api), []);
});

test('the undo is offered until a day it names, and is gone, said why, once another run booked by the rule', async () => {
  const api = await employerApi();
  const wages = await keepRule(api, WAGE_RULE);
  let [line] = await lines(api);
  assert.match(line.until ?? '', /^\d{4}-\d{2}-\d{2}/, JSON.stringify(line));
  assert.equal(line.ended, undefined);
  // L1's booking replaced later: taken out, and booked again by the rule through «Automatisch buchen» for all.
  unbook(api, ['L1']);
  assert.equal((await api.send('POST', '/api/rules/book-open', {})).json.booked, 1);
  await api.rest();
  const l1 = loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'L1');
  assert.ok(l1.length === 1 && l1[0].rule && !wages.booked!.entries.includes(l1[0].id), JSON.stringify(l1));
  [line] = await lines(api);
  assert.equal(line.ended, 'bookedSince', JSON.stringify(line));
  const undo = (await api.send('POST', '/api/rules/kept/undo', { keep: wages.keep!.id })).json;
  assert.deepEqual([undo.ok, undo.refusal], [false, 'bookedSince'], JSON.stringify(undo));
  assert.equal(loadBooks(api.ws).journalEntries.length, 4, 'nothing taken back');
});

test('a rules file edited by hand between keeps: the line says the undo is gone and why', async () => {
  const api = await employerApi();
  const wages = await keepRule(api, WAGE_RULE);
  appendFileSync(join(api.ws.paths.root, wages.undo!.file), '# von Hand\n');
  const [line] = await lines(api);
  assert.deepEqual([line?.id, line?.ended], [wages.keep!.id, 'file'], JSON.stringify(line));
  const undo = (await api.send('POST', '/api/rules/kept/undo', { keep: wages.keep!.id })).json;
  assert.deepEqual([undo.ok, undo.refusal], [false, 'file'], JSON.stringify(undo));
});

test('keeps of two files stand apart: the earlier one is taken back while the later stays', async () => {
  const api = await employerApi();
  const file = join(api.ws.paths.root, 'knowledge', 'suppliers', 'garage-huber.yaml');
  mkdirSync(join(api.ws.paths.root, 'knowledge', 'suppliers'), { recursive: true });
  writeFileSync(file, 'id: garage-huber\nname: Garage Huber\nmatch:\n  tx: ["Garage Huber"]\n');
  const wages = await keepRule(api, WAGE_RULE);
  const garage = await keepRule(api, { match: { kind: 'business', id: 'garage-huber' }, direction: 'out', account: '6570', vat: '0' });
  assert.notEqual(garage.undo?.file, wages.undo?.file);
  assert.deepEqual((await lines(api)).map((l) => [l.id, l.blockedBy ?? []]), [[wages.keep!.id, []], [garage.keep!.id, []]]);
  const undone = (await api.send('POST', '/api/rules/kept/undo', { keep: wages.keep!.id })).json;
  assert.deepEqual([undone.ok, undone.removed], [true, 4], JSON.stringify(undone));
  assert.match(readFileSync(file, 'utf8'), /6570/, 'the garage rule stays');
  assert.deepEqual((await lines(api)).map((l) => l.id), [garage.keep!.id]);
});

test('the undo restores exactly the tasks the keep closed; a waiting payment is no question of its rule', async () => {
  const api = await employerApi();
  await ask(api, 'B2');
  assert.deepEqual(await tasks(api), ['B2']);
  const kept = await keepRule(api, { match: { kind: 'text', text: 'Garage Huber|Elektro Meier' }, direction: 'out', account: '6570', vat: '0' });
  assert.deepEqual([kept.keep!.waits, await tasks(api)], [2, []]);
  // Asked again, the waiting payment ends without a task, and Firma › Regeln counts no question of the rule.
  await ask(api, 'B2');
  assert.deepEqual([await tasks(api), await stuck(api)], [[], []], 'it ends, not stuck');
  const rules = (await api.send('GET', '/api/rules')).json as unknown as { rules: Array<{ rules?: never; asked: number; kind: string }> };
  assert.deepEqual(rules.rules.filter((r) => r.kind === 'rule').map((r) => r.asked), [0], 'a booking rule asked nothing');
  const undone = (await api.send('POST', '/api/rules/kept/undo', { keep: kept.keep!.id })).json;
  assert.equal(undone.ok, true, JSON.stringify(undone));
  await api.rest();
  assert.deepEqual(await tasks(api), ['B2'], 'B2 had its task before the keep, B3 none');
  assert.deepEqual(await stuck(api), [], 'no run stuck on the way');
});

test('a payment whose only receipt cannot be read: the rule\'s ask run leaves it to the person, never booked on a guessed rate', async () => {
  const api = await employerApi();
  const books = loadBooks(api.ws);
  update(books, PERSON, (b) => {
    b.receipts.push({ id: 'rU', filename: 'rU.pdf', location: 'archived', kind: 'invoice', date: '2026-08-12', amount: 200, currency: 'CHF', extractedText: '', needsVisionReview: true } as Receipt);
    b.mappings.push({ receiptId: 'rU', transactionRef: 'B2' } as (typeof b.mappings)[number]);
  });
  saveBooks(api.ws, books);
  await keepRule(api, GARAGE_RULE);
  await ask(api, 'B2');
  assert.deepEqual(await tasks(api), ['B2'], 'a task for the person');
  assert.ok(!loadBooks(api.ws).journalEntries.some((e) => e.transactionRef === 'B2'));
});

test('«Automatisch buchen» for all: books only what a rule decides, no model asked, and names what it left and why', async () => {
  const api = await employerApi();
  await keepRule(api, WAGE_RULE);
  await keepRule(api, GARAGE_RULE);
  // L1 and L2 unbooked again; L3's booking she deleted on purpose.
  unbook(api, ['L1', 'L2', 'L3'], ['L3']);
  const r = (await api.send('POST', '/api/rules/book-open', {})).json as Record<string, number>;
  await api.rest();
  assert.equal(r.booked, 2, JSON.stringify(r));
  assert.equal(r.deleted, 1, JSON.stringify(r));
  assert.deepEqual([r.receipt, r.model > 0, r.question, r.unread, r.later], [1, true, 0, 0, 0], 'Garage Huber waits for its receipt; the rest no rule decides');
  const booked = loadBooks(api.ws).journalEntries.map((e) => e.transactionRef).sort();
  assert.deepEqual(booked, ['L1', 'L2', 'L4']);
});

test('a rule kept, taken back and kept again books the same payments again', async () => {
  const api = await employerApi();
  const first = await keepRule(api, WAGE_RULE);
  assert.equal((await api.send('POST', '/api/rules/kept/undo', { keep: first.keep!.id })).json.ok, true);
  await api.rest();
  assert.equal(loadBooks(api.ws).journalEntries.length, 0);
  const again = await keepRule(api, WAGE_RULE);
  assert.deepEqual([...(again.booked?.refs ?? [])].sort(), WAGES, JSON.stringify(again.booked));
  assert.deepEqual(loadBooks(api.ws).journalEntries.map((e) => e.transactionRef).sort(), WAGES);
});

test('a payment an account\'s reconciliation holds: the card says it waits for it, neither the keep nor «Automatisch buchen» books it', async () => {
  const api = await employerApi();
  const books = loadBooks(api.ws);
  update(books, PERSON, (b) => {
    b.reconciliations = [{ account: '1020', from: '2026-07-01', to: '2026-07-31', since: '2026-11-01', covered: [], read: ['L1'], bank: [], pairs: [] }];
  });
  saveBooks(api.ws, books);
  const made = await api.send('POST', '/api/rules/hand', WAGE_RULE);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(String(made.json.path))}`)).json as unknown as DraftView;
  const open = card.preview[0].open!;
  assert.deepEqual([[...open.book].sort(), open.reconcile], [['L2', 'L3', 'L4'], ['L1']], JSON.stringify(open));
  assert.equal(card.preview[0].examples.find((x) => x.ref === 'L1')?.reconcile, true);
  const kept = await keepRule(api, WAGE_RULE);
  assert.deepEqual([...kept.booked!.refs].sort(), ['L2', 'L3', 'L4']);
  const r = (await api.send('POST', '/api/rules/book-open', {})).json as Record<string, number>;
  assert.deepEqual([r.booked, r.reconcile], [0, 1], JSON.stringify(r));
  assert.ok(!loadBooks(api.ws).journalEntries.some((e) => e.transactionRef === 'L1'), 'L1 waits for the reconciliation');
});

test('«take both back» with a keep in between whose undo is gone: nothing is taken back', async () => {
  const api = await employerApi();
  assert.equal((await api.send('PUT', '/api/accounts/2850', { name: 'Privat' })).status, 200);
  const wages = await keepRule(api, WAGE_RULE);
  await keepRule(api, { match: { kind: 'text', text: 'Einlage' }, direction: 'in', account: '2850' });
  const newest = await keepRule(api, { match: { kind: 'text', text: 'Nirgendwo' }, direction: 'out', account: '5000' });
  // The middle keep's undo goes: its rule booked K2 again since, outside the keep.
  unbook(api, ['K2']);
  assert.equal(((await api.send('POST', '/api/rules/book-open', {})).json as Record<string, number>).booked, 1);
  const r = (await api.send('POST', '/api/rules/kept/undo', { keep: wages.keep!.id, withLater: true })).json;
  assert.deepEqual([r.ok, r.refusal], [false, 'bookedSince'], JSON.stringify(r));
  assert.match(readFileSync(join(api.ws.paths.root, newest.undo!.file), 'utf8'), /Nirgendwo/, 'the newest keep stands: all or nothing');
  assert.equal(loadBooks(api.ws).journalEntries.length, 5);
});

test('a rule\'s question that finds its payment decided books it, also a second time after it was taken back', async () => {
  const api = await employerApi();
  await keepRule(api, WAGE_RULE);
  for (let i = 0; i < 2; i++) {
    unbook(api, ['L1']);
    await ask(api, 'L1');
    const l1 = loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'L1');
    assert.ok(l1.length === 1 && l1[0].rule, `round ${i + 1}: the run said booked, and the books hold it: ${JSON.stringify(l1)}`);
    assert.deepEqual(await stuck(api), []);
  }
});

test('a keep id that is no id is refused; one that is gone answers 404', async () => {
  const api = await employerApi();
  assert.equal((await api.send('POST', '/api/rules/kept/close', { keep: '../../x' })).status, 400);
  assert.equal((await api.send('POST', '/api/rules/kept/undo', { keep: '../x' })).status, 400);
  assert.equal((await api.send('POST', '/api/rules/kept/undo', { keep: 'zzzzzzzz-001-abcdef' })).status, 404);
});
