/**
 * Belege's list and link dialog (src/app/areas/receipts/model.ts): what a period shows, what
 * needs you, what is locked by a filed quarter, and which payments rank first for a receipt.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { parseIban } from '../src/workspace/banks.js';
import { badgeCount, candidates, groups, ledgerOf, lockedRefuses, needsYou, suggestion, visible, type ToChf } from '../src/app/areas/receipts/model.js';

const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'archived', currency: 'CHF', ...x,
});
const tx = (ref: string, date: string, amount: number, x: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: 'DBIT', description: ref, ...x });

const books: Index = {
  config: { closedThrough: '2026-06-30' },
  receipts: [
    receipt('paper', { date: '2026-09-12', amount: 58.4, description: 'Muster Büro AG, Druckerpapier' }),
    receipt('linked', { date: '2026-09-02', amount: 20 }),
    receipt('filed', { date: '2026-06-10', amount: 10 }),
    receipt('undated', { amount: 7 }),
    receipt('brochure', { date: '2026-09-05', amount: 0 }),
    receipt('eur', { date: '2026-08-20', amount: 100, currency: 'EUR' }),
    receipt('late', { date: '2026-06-12', amount: 30 }),
  ],
  transactions: [
    tx('T-paper', '2026-09-13', 58.4),
    tx('T-near', '2026-09-12', 61),
    tx('T-linked', '2026-09-03', 20),
    tx('T-closed', '2026-06-11', 10),
    tx('T-fee', '2026-09-12', 58.4, { type: 'wise-fee' }),
    tx('T-eur', '2026-08-21', 100, { currency: 'EUR' }),
    tx('T-chf-for-eur', '2026-08-21', 94),
    tx('T-filed', '2026-06-12', 30),
  ],
  mappings: [
    { receiptId: 'linked', transactionRef: 'T-linked' },
    { receiptId: 'filed', transactionRef: 'T-closed' },
  ],
  bankStatements: [],
};
const l = ledgerOf(books, '2026-07-01');
const q3 = parsePeriod('2026-Q3', '2026-10-11')!;
const flat: ToChf = (amount, currency) => amount * (currency === 'EUR' ? 0.94 : 1);
const view = (id: string) => l.byId.get(id)!;

test('a receipt linked to a payment of a filed quarter is locked; the vendor comes from the description', () => {
  assert.equal(view('filed').locked, true);
  assert.equal(view('paper').locked, false);
  assert.deepEqual([view('paper').vendor, view('paper').desc], ['Muster Büro AG', 'Druckerpapier']);
});

test('a locked receipt refuses a link and a delete; its date, words and kind still change (#151)', () => {
  assert.deepEqual((['link', 'edit', 'del', 'mark', 'notreceipt'] as const).filter(lockedRefuses), ['link', 'del']);
});

test('a period shows its receipts, counts them per filter, and hides what is no receipt', () => {
  const v = visible(l, q3, undefined, undefined);
  assert.deepEqual(v.rows.map((x) => x.r.id).sort(), ['eur', 'linked', 'paper', 'undated']);
  assert.deepEqual(v.counts, { alle: 4, zugeordnet: 1, offen: 3, ohneDatum: 1 });
  assert.deepEqual(v.hidden.map((x) => x.r.id), ['brochure']);
  assert.deepEqual(visible(l, q3, 'offen', 'druckerpapier').rows.map((x) => x.r.id), ['paper']);
});

test('what needs you comes first, an open receipt without a date with it, then each month', () => {
  const { rows } = visible(l, q3, undefined, undefined);
  const g = groups(rows, l, undefined, (x) => x.r.id === 'eur');
  assert.deepEqual(g.groups.map((x) => [x.key, x.rows.map((r) => r.r.id)]), [
    ['need', ['eur', 'paper', 'undated']],
    ['month:2026-09', ['linked']],
  ]);
  assert.deepEqual(g.later.map((x) => x.r.id), []);
  assert.equal(badgeCount(l), 3);
});

test('the payment of the same amount and the nearest date ranks first; fees, closed and linked payments never show', () => {
  const { best, more } = candidates(view('paper'), l, flat);
  const refs = [...best, ...more].map((c) => c.tx.ref);
  assert.equal(best[0].tx.ref, 'T-paper');
  assert.ok(best[0].sameAmount);
  assert.equal(best[0].days, 1);
  for (const gone of ['T-fee', 'T-closed']) assert.ok(!refs.includes(gone), gone);
  assert.deepEqual(candidates(view('linked'), l, flat).best.map((c) => c.tx.ref).includes('T-linked'), false);
});

test('a late receipt sees the filed payment it fits, marked, never as the one-key suggestion; a filed payment that fits nothing stays out (corner-33)', () => {
  const { best } = candidates(view('late'), l, flat);
  assert.equal(best[0].tx.ref, 'T-filed');
  assert.equal(best[0].filed, true);
  assert.equal(suggestion(view('late'), l, flat), undefined);
  const all = candidates(view('paper'), l, flat);
  assert.ok(![...all.best, ...all.more].some((c) => c.tx.ref === 'T-filed'));
  assert.deepEqual(candidates(view('paper'), l, flat, 't-filed').more.map((c) => [c.tx.ref, c.filed]), [['T-filed', true]], 'a search finds it');
});

test('a foreign receipt ranks its own currency above a CHF payment of the same value', () => {
  const { best } = candidates(view('eur'), l, flat);
  assert.deepEqual(best.slice(0, 2).map((c) => c.tx.ref), ['T-eur', 'T-chf-for-eur']);
});

test('a search finds payments by text; one exact fit becomes the suggestion', () => {
  assert.deepEqual(candidates(view('paper'), l, flat, 't-near').more.map((c) => c.tx.ref), ['T-near']);
  assert.equal(suggestion(view('paper'), l, flat)?.tx.ref, 'T-paper');
  assert.equal(suggestion(view('linked'), l, flat), undefined);
});

test('books that never filed: an open receipt dated before the working period needs you there, in its list and its badge', () => {
  const fresh: Index = {
    receipts: [receipt('june', { date: '2026-06-28', amount: 1243.55 }), receipt('july', { date: '2026-07-10', amount: 88.98 })],
    transactions: [tx('T-june', '2026-07-03', 1243.55)], mappings: [], bankStatements: [],
  };
  const lf = ledgerOf(fresh, '2026-07-01');
  const v = visible(lf, q3, undefined, undefined);
  assert.deepEqual(v.rows.map((x) => x.r.id).sort(), ['july', 'june']);
  assert.deepEqual(groups(v.rows, lf, undefined, () => false).groups.map((g) => [g.key, g.rows.map((r) => r.r.id)]), [['need', ['july', 'june']]]);
  assert.equal(badgeCount(lf), 2);
  assert.deepEqual(visible(lf, parsePeriod('2026-Q2', '2026-10-11')!, undefined, undefined).rows.map((x) => x.r.id), ['june'], 'its own quarter still shows it');
});

test('a receipt linked to a payment of the period shows there too: a June invoice paid in July is in Q3 and still in Q2', () => {
  const paid: Index = {
    config: { closedThrough: '2026-03-31' },
    receipts: [receipt('june', { date: '2026-06-28', amount: 1243.55 }), receipt('may', { date: '2026-05-20', amount: 30 })],
    transactions: [tx('T-june', '2026-07-03', 1243.55), tx('T-may', '2026-05-21', 30)],
    mappings: [{ receiptId: 'june', transactionRef: 'T-june' }, { receiptId: 'may', transactionRef: 'T-may' }], bankStatements: [],
  };
  const lp = ledgerOf(paid, '2026-04-01');
  assert.deepEqual(visible(lp, q3, undefined, undefined).rows.map((x) => x.r.id), ['june'], 'paid in Q3, so in Q3; the May one, paid in May, is not');
  assert.deepEqual(visible(lp, q3, undefined, undefined).counts.zugeordnet, 1);
  assert.deepEqual(visible(lp, parsePeriod('2026-Q2', '2026-10-11')!, undefined, undefined).rows.map((x) => x.r.id).sort(), ['june', 'may']);
});

test('a bank statement among the receipts never needs you; Belege hides one Kontoauszüge places and lists the others as no receipt (#151)', () => {
  const head = (iban: string) => ['Kontoauszug 01.07.2026 - 31.07.2026', `IBAN ${iban}`, 'Saldovortrag 01.07.2026: 1 000.00', 'Schlusssaldo 31.07.2026: 950.00'].join('\n');
  const accounts = [{ bank: 'Bank', currency: 'CHF', account: '1021', iban: parseIban('CH6580808000000000001') }];
  const ls = ledgerOf({ ...books, receipts: [...books.receipts,
    receipt('placed', { kind: 'statement', date: '2026-07-31', extractedText: head('CH65 8080 8000 0000 0000 1') }),
    receipt('stranger', { kind: 'statement', date: '2026-07-31', extractedText: head('CH00 1234 5678 9012 3456 7') }),
    receipt('nodate', { kind: 'statement', extractedText: head('CH00 1234 5678 9012 3456 7') }),
  ] }, '2026-07-01');
  const v = visible(ls, q3, undefined, undefined, accounts);
  const ids = (xs: { r: Receipt }[]) => xs.map((x) => x.r.id);
  assert.equal(ls.byId.get('placed')!.statement?.to, '2026-07-31');
  assert.ok(!ids(v.rows).some((id) => ['placed', 'stranger', 'nodate'].includes(id)), 'no statement is a receipt row');
  assert.ok(!ids(v.hidden).includes('placed'), 'the placed one lives with the bank');
  assert.deepEqual(v.hidden.filter((x) => x.r.id === 'stranger').map((x) => x.noneWhy), ['statement'], 'one no account fits stays under Belege, said to be a statement');
  assert.deepEqual(v.counts, visible(l, q3, undefined, undefined).counts, 'they count in no filter, «ohne Datum» neither');
  assert.ok(['placed', 'stranger', 'nodate'].every((id) => !needsYou(ls.byId.get(id)!, ls)));
  assert.equal(badgeCount(ls), badgeCount(l));
  assert.ok(ids(visible(ls, q3, undefined, undefined).hidden).includes('placed'), 'without the manifest\'s accounts nothing places it');
});
