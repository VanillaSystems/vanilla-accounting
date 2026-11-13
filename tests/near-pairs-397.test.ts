/**
 * Near pairs without a model (#397): the persona's supplier invoices whose payment names their
 * number with a rounding or a stated cash discount, or comes from the same supplier with the exact
 * amount within the invoice's terms, are linked by code; everything less sure (a rounded amount
 * without a number, an undated till slip, two candidates) is offered with what differs, never
 * linked. The negatives the reviews of #370 taught: two payments naming the number, two receipts
 * with it, a part payment, a refund, a year or a customer number, another supplier with the same
 * amount, a receipt after the payment, a filed period, a pair a person took apart.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textFacts } from '../src/parsers/receipt-text.js';
import { runPairChain } from '../src/intake/pair-chain.js';
import { discountsIn, gapOf, namesSupplier, nearPairs, offersInBooks, termsOf } from '../src/intake/near-pairs.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import type { Firm } from '../src/intake/own-invoice.js';

const TEXTS: Record<string, string> = JSON.parse(readFileSync(new URL('./fixtures/persona-receipt-texts.json', import.meta.url), 'utf8')).huber;
// The firm of the persona under another UID than the fixture's suppliers (the fixture prints one placeholder UID for all).
const FIRM: Firm = { uid: 'CHE-111.222.333', name: 'Malerei Huber GmbH' };
const toChf = (a: number) => a;

/** A persona PDF as the drop reads it without a model: its text and what code reads off it. */
function read(file: string, over: Partial<Receipt> = {}): Receipt {
  const text = TEXTS[file];
  const { vatId: _v, noSwissVat: _n, ...facts } = textFacts(text);
  return { id: file, filename: file, originalFilename: file, extractedText: text, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', ...facts, ...(facts.vatSummary ? { hasSwissVat: true } : {}), ...over } as Receipt;
}
const pay = (ref: string, date: string, amount: number, counterparty: string, description: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description, ...over }) as BankTransaction;

// The persona's payments (persona-files/huber.mjs), the ones that matter here.
const P = {
  fm78230: pay('RB-2026-0010', '2026-08-06', 2410.8, 'Farbmix AG', 'Rechnung FM-78230'),
  fm79010: pay('RB-2026-1003', '2026-10-08', 1506.45, 'Farbmix AG', 'Rechnung FM-79010 abzgl. 2% Skonto'),
  geruest: pay('RB-2026-0012', '2026-08-14', 1120, 'Gerüstbau Thurtal GmbH', 'Miete Gerüst August'),
  swisscomJul: pay('RB-2026-0005', '2026-07-15', 89, 'Swisscom (Schweiz) AG', 'Rechnung Juli Natel'),
  swisscomAug: pay('RB-2026-0013', '2026-08-15', 89, 'Swisscom (Schweiz) AG', 'Rechnung August Natel'),
  baucenter: pay('RB-2026-1002', '2026-10-05', 187.35, 'Baucenter Gossau', 'Karte 5412 Einkauf'),
  wage: pay('RB-2026-0006', '2026-07-25', 4800, 'Sandra Huber', 'Lohn Juli 2026'),
};
const books = (receipts: Receipt[], transactions: BankTransaction[], closedThrough = '2026-06-30'): Books =>
  ({ receipts, transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough } }) as unknown as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const run = (b: Books) => runPairChain(port(b), { toChf, firm: FIRM });
const links = (b: Books) => b.mappings.map((m) => [m.receiptId, m.transactionRef]);
const near = (b: Books) => nearPairs(b, { isClosed: (d) => d <= (b.config?.closedThrough ?? ''), firm: FIRM });

test('the persona\'s files read as they are: FM-78230 2410.85, FM-79010 1537.22 offering 2 % Skonto, the scaffold invoice 1120.00 payable in 30 days', () => {
  assert.equal(read('Farbmix_Rechnung_FM-78230.pdf').amount, 2410.85);
  assert.equal(read('Farbmix_Rechnung_FM-79010.pdf').amount, 1537.22);
  assert.deepEqual(gapOf(read('Farbmix_Rechnung_FM-79010.pdf'), P.fm79010), { kind: 'discount', percent: 2, discount: 30.77, by: 'payment' });
  assert.deepEqual(gapOf(read('Farbmix_Rechnung_FM-78230.pdf'), P.fm78230), { kind: 'rounded', diff: -0.05 });
  assert.equal(termsOf(read('Geruest_August.pdf')), 30);
  assert.equal(termsOf(read('Farbmix_Rechnung_FM-79010.pdf')), 30, 'the longer of «innert 10 Tagen mit Skonto, sonst innert 30 Tagen»');
});

test('FM-78230: the payment names the number, 5 Rappen less: linked by code, without a model', async () => {
  const b = books([read('Farbmix_Rechnung_FM-78230.pdf')], [P.fm78230, P.wage, P.swisscomJul]);
  const r = await run(b);
  assert.deepEqual(links(b), [['Farbmix_Rechnung_FM-78230.pdf', 'RB-2026-0010']]);
  assert.equal(r.linked[0].by, 'code');
  assert.match(b.mappings[0].rule!, /^pair:rounded\+.*number/);
});

test('FM-79010: the payment names the number and states the 2 % Skonto it took: linked by code, the discount named in the link', async () => {
  const b = books([read('Farbmix_Rechnung_FM-79010.pdf')], [P.fm79010, P.baucenter]);
  await run(b);
  assert.deepEqual(links(b), [['Farbmix_Rechnung_FM-79010.pdf', 'RB-2026-1003']]);
  assert.match(b.mappings[0].rule!, /discount/);
});

test('a discount the invoice offers counts too, when the payment names its number; a payment less by another share does not', async () => {
  const offered = books([read('Farbmix_Rechnung_FM-79010.pdf')], [pay('x', '2026-10-08', 1506.45, 'Farbmix AG', 'Rechnung FM-79010')]);
  await run(offered);
  assert.equal(offered.mappings.length, 1);
  const part = books([read('Farbmix_Rechnung_FM-79010.pdf')], [pay('x', '2026-10-08', 1000, 'Farbmix AG', 'Rechnung FM-79010 Teilzahlung')]);
  await run(part);
  assert.deepEqual(part.mappings, [], 'a part payment is no stated discount');
  assert.deepEqual(near(part), [], 'and nothing is offered either');
});

test('the scaffold invoice: same supplier, the exact amount, 13 days after its date and within its 30 days: linked by code', async () => {
  const b = books([read('Geruest_August.pdf')], [P.geruest, P.wage]);
  const r = await run(b);
  assert.deepEqual(links(b), [['Geruest_August.pdf', 'RB-2026-0012']]);
  assert.equal(r.linked[0].by, 'code');
});

test('the Swisscom bill 88.98 against 89.00, no number: offered with what differs, never linked', async () => {
  const b = books([read('swisscom_juli.pdf')], [P.swisscomJul, P.swisscomAug]);
  await run(b);
  assert.deepEqual(b.mappings, []);
  const offers = near(b);
  assert.deepEqual(offers.map((p) => [p.payment, p.gap.kind, p.days, !!p.sure]), [['RB-2026-0005', 'rounded', 5, false], ['RB-2026-0013', 'rounded', 36, false]]);
});

test('an undated till slip of the payment\'s amount at the same shop is offered «ohne Datum», never linked', async () => {
  const slip = { id: 'IMG_4733.jpg', filename: 'IMG_4733.jpg', extractedText: 'Baucenter Gossau\nTOTAL CHF 187.35', extractionMethod: 'claude-vision', location: 'archived', amount: 187.35, currency: 'CHF', title: { vendor: 'Baucenter Gossau', what: 'Material' }, indexedAt: '', fileSize: 1 } as unknown as Receipt;
  const b = books([slip], [P.baucenter]);
  await run(b);
  assert.deepEqual(b.mappings, []);
  assert.deepEqual(near(b).map((p) => [p.payment, p.gap.kind, p.days]), [['RB-2026-1002', 'same', undefined]]);
});

test('negatives: two payments naming the number, two receipts with it, a refund, a year as the number, another supplier with the same amount, a receipt after the payment', async () => {
  const fm = () => read('Farbmix_Rechnung_FM-78230.pdf');
  const twice = books([fm()], [P.fm78230, pay('y', '2026-08-20', 2410.8, 'Farbmix AG', 'Rechnung FM-78230 nochmals')]);
  await run(twice);
  assert.deepEqual(twice.mappings, [], 'two payments name the number');
  const twoReceipts = books([fm(), read('Farbmix_Rechnung_FM-78230.pdf', { id: 'copy', filename: 'copy.pdf' })], [P.fm78230]);
  await run(twoReceipts);
  assert.deepEqual(twoReceipts.mappings, [], 'two receipts carry the number');
  const refund = books([fm()], [{ ...P.fm78230, direction: 'CRDT' }]);
  await run(refund);
  assert.deepEqual(refund.mappings, [], 'money in never pays a supplier invoice');
  const year = books([read('Farbmix_Rechnung_FM-78230.pdf', { extractedText: TEXTS['Farbmix_Rechnung_FM-78230.pdf'].replace('Rechnung FM-78230', 'Rechnung 2026\nKunden-Nr. 4471') })], [pay('z', '2026-08-06', 2410.8, 'Farbmix AG', 'Rechnung 2026 Kunde 4471')]);
  await run(year);
  assert.deepEqual(year.mappings, [], 'a year or a customer number is no invoice number');
  const other = books([read('Geruest_August.pdf')], [pay('o', '2026-08-14', 1120, 'Malerbedarf Konstanz GmbH', 'Einkauf')]);
  await run(other);
  assert.deepEqual(other.mappings, [], 'another supplier with the same amount');
  assert.deepEqual(near(other), []);
  const after = books([read('Geruest_August.pdf', { date: '2026-08-20' })], [P.geruest]);
  await run(after);
  assert.deepEqual(after.mappings, [], 'a receipt dated after its payment');
  const late = books([read('Geruest_August.pdf')], [{ ...P.geruest, date: '2026-09-15' }]);
  await run(late);
  assert.deepEqual(late.mappings, [], 'paid after the invoice\'s 30 days: offered, not linked');
  assert.equal(near(late).length, 1);
  const twoGeruest = books([read('Geruest_August.pdf')], [P.geruest, { ...P.geruest, ref: 'g2', date: '2026-08-20' }]);
  await run(twoGeruest);
  assert.deepEqual(twoGeruest.mappings, [], 'two payments of the supplier fit: the person decides');
});

test('a filed payment is never linked; a pair a person took apart is never linked again nor offered', async () => {
  const filed = books([read('Farbmix_Rechnung_FM-78230.pdf')], [P.fm78230], '2026-09-30');
  await run(filed);
  assert.deepEqual(filed.mappings, []);
  assert.equal(filed.receipts[0].filedPayment, undefined, 'not pointed at by a near pair either');
  const apart = books([read('Farbmix_Rechnung_FM-78230.pdf', { notPaidBy: ['RB-2026-0010'] })], [P.fm78230]);
  await run(apart);
  assert.deepEqual(apart.mappings, []);
  assert.deepEqual(near(apart), []);
});

test('the wage of the firm\'s owner is no supplier of a receipt that names the firm as addressee', () => {
  const b = books([read('Geruest_August.pdf', { amount: 4800 })], [P.wage]);
  assert.deepEqual(near(b), []);
});

// Review of #400.
const OWNER: Firm = { ...FIRM, owner: 'Sandra Huber' };
const runAs = (b: Books, firm: Firm, ask?: Parameters<typeof runPairChain>[1]['ask']) => runPairChain(port(b), { toChf, firm, ...(ask && { ask }) });

test('only the issuer tells a supplier: the owner under the addressee is none, nor one short common word, nor the firm itself', async () => {
  const addressed = TEXTS['Geruest_August.pdf'].replace('Malerei Huber GmbH', 'Malerei Huber GmbH\nSandra Huber');
  const toOwner = books([read('Geruest_August.pdf', { extractedText: addressed })], [pay('w', '2026-08-25', 1120, 'Sandra Huber', 'Spesen August')]);
  await runAs(toOwner, OWNER);
  assert.deepEqual(toOwner.mappings, [], 'a payment to the owner named in the address block');
  assert.deepEqual(nearPairs(toOwner, { isClosed: () => false, firm: OWNER }), []);
  const post = TEXTS['Geruest_August.pdf'].replace('Thurstrasse 88, 9500 Wil', 'Thurstrasse 88, 9500 Wil\nVersand per Post');
  const byPost = books([read('Geruest_August.pdf', { extractedText: post })], [pay('w', '2026-08-10', 1120, 'Die Post', 'Einzahlung am Schalter')]);
  await runAs(byPost, OWNER);
  assert.deepEqual(byPost.mappings, [], '«Die Post»: one short word');
  assert.deepEqual(nearPairs(byPost, { isClosed: () => false, firm: OWNER }), []);
  const own = books([read('Geruest_August.pdf')], [pay('w', '2026-08-10', 1120, 'Malerei Huber GmbH', 'Übertrag')]);
  await run(own);
  assert.deepEqual(own.mappings, [], 'the firm itself is no supplier');
  assert.deepEqual(near(own), []);
  // A supplier whose name holds the firm's words, as read: the firm's words tell no payee.
  const alike = read('Geruest_August.pdf', { title: { vendor: 'Malerei Huber Bedarf AG', what: 'Material' } });
  assert.equal(namesSupplier(alike, { counterparty: 'Malerei Huber GmbH' }, FIRM), false);
});

test('the app\'s own offers take only payments the server says wait for their receipt (a wage takes none)', () => {
  const b = books([read('swisscom_juli.pdf')], [{ ...P.swisscomJul, waitsForReceipt: { since: '2026-07-15' } }, P.swisscomAug]);
  assert.deepEqual(offersInBooks(b, { receipt: 'swisscom_juli.pdf' }, FIRM).map((o) => o.payment), ['RB-2026-0005']);
});

test('by the supplier alone, held back and offered: another month named, a recurring amount, a receipt before the books', async () => {
  const juni = TEXTS['Geruest_August.pdf'].replace('01.08.2026', '20.06.2026').replace('August', 'Juni');
  const month = books([read('Geruest_August.pdf', { extractedText: juni, date: '2026-06-20' })], [pay('jul', '2026-07-14', 1120, 'Gerüstbau Thurtal GmbH', 'Miete Gerüst Juli'), pay('x', '2026-06-01', 50, 'Tankstelle', 'Tanken')]);
  await run(month);
  assert.deepEqual(month.mappings, [], 'June\'s bill against July\'s charge');
  assert.equal(near(month).length, 1, 'offered');
  const recurring = books([read('Geruest_August.pdf')], [{ ...P.geruest, description: 'Miete Gerüst' }, pay('jul', '2026-07-14', 1120, 'Gerüstbau Thurtal GmbH', 'Miete Gerüst')]);
  recurring.mappings.push({ receiptId: 'other', transactionRef: 'jul' });
  await run(recurring);
  assert.ok(!recurring.mappings.some((m) => m.receiptId === 'Geruest_August.pdf'), 'paid this amount twice: a series');
  const early = books([read('Geruest_August.pdf')], [P.geruest, pay('first', '2026-08-05', 10, 'Bank', 'Gebühr')]);
  await run(early);
  assert.deepEqual(early.mappings, [], 'the receipt lies before the books\' first payment');
});

test('terms: a number counts only right before a day word, never past 90 days', () => {
  const t = (text: string) => termsOf({ extractedText: text, date: '2026-08-01' });
  assert.equal(t('Zahlungsfrist 30 Tage, Betrag 150 CHF'), 30);
  assert.equal(t('Zahlbar innert 30 Tagen auf Konto 80-1234-5'), 30);
  assert.equal(t('Zahlbar innert 10 Tagen, Kunde 120'), 10);
  assert.equal(t('zahlbar bis 31.12.2026'), 90);
});

test('discounts: right beside the word, never negated, never a VAT rate, an invoice offers at most 5 %', () => {
  assert.deepEqual(discountsIn('ohne Skonto. Verzugszins 5 %'), []);
  assert.deepEqual(discountsIn('Kein Skontoabzug. MWST 8.1 %'), []);
  assert.deepEqual(discountsIn('110% Skonto'), []);
  assert.deepEqual(discountsIn('MWST 8.1% Skonto 2 %'), [2]);
  assert.deepEqual(discountsIn('abzgl. 2% Skonto'), [2]);
  assert.deepEqual(discountsIn('8 % Skonto innert 10 Tagen', undefined, 5), []);
  const text = TEXTS['Farbmix_Rechnung_FM-78230.pdf'].replace(/Zahlbar[^\n]*/, 'Zahlbar innert 30 Tagen netto, ohne Skonto. Verzugszins 5 %.');
  const r = read('Farbmix_Rechnung_FM-78230.pdf', { extractedText: text });
  assert.equal(gapOf(r, pay('x', '2026-08-06', 2290.31, 'Farbmix AG', 'Rechnung FM-78230 Teilzahlung')), undefined, '«ohne Skonto. Verzugszins 5 %» is no discount');
});

test('guards: an instalment naming the number, a second receipt carrying it, a collective payment, the model\'s doubt, a receipt in the inbox', async () => {
  const fm = () => read('Farbmix_Rechnung_FM-78230.pdf');
  const instalment = books([fm()], [P.fm78230, pay('rest', '2026-08-20', 1000, 'Farbmix AG', 'Rechnung FM-78230 Rest')]);
  await run(instalment);
  assert.deepEqual(instalment.mappings, [], 'another payment of another amount names the number');
  const second = books([fm(), read('Farbmix_Rechnung_FM-78230.pdf', { id: 'copy', filename: 'copy.pdf', amount: 999 })], [P.fm78230]);
  await run(second);
  assert.deepEqual(second.mappings, [], 'a second receipt of another amount carries the number');
  const collective = books([fm()], [{ ...P.fm78230, parts: [{ counterparty: 'Farbmix AG', amount: 1500, currency: 'CHF', reference: 'FM-78230' }, { counterparty: 'Farbmix AG', amount: 910.8, currency: 'CHF', reference: 'FM-78230' }] } as BankTransaction]);
  await run(collective);
  assert.deepEqual(collective.mappings, [], 'a collective payment is the chain\'s');
  const doubted = books([read('Geruest_August.pdf')], [P.geruest, P.wage]);
  await runAs(doubted, FIRM, async (prompt) => (prompt.includes('"payments"') ? '[{"i":0,"k":null,"confidence":0.9}]' : '[{"i":0,"fits":false}]'));
  assert.deepEqual(doubted.mappings, [], 'the model said it does not fit');
  const inbox = books([read('Farbmix_Rechnung_FM-78230.pdf', { location: 'staged' })], [P.fm78230]);
  await run(inbox);
  assert.deepEqual(inbox.mappings, [], 'a receipt still in the inbox is not linked by this rule');
  assert.deepEqual(near(inbox).map((p) => [p.payment, p.sure]), [['RB-2026-0010', undefined]], 'but offered, not marked sure');
});
