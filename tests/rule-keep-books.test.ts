/**
 * #383 on the real API server: a rule kept books the open payments it decides at once (no inbox run
 * needed), once: a second inbox run books nothing more. A rule for wages on the wage account asks no
 * VAT and books without a code; a payment that waits for its receipt is shown waiting on the card and
 * is not booked by the keep; «Rückgängig» takes the rule and its bookings back.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
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
