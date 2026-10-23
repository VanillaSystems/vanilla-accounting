/**
 * #38: an answer to the app's sale question books only its payment; «Immer so?» under it reads the
 * payer's other payments first (src/saving/sale-rule.ts). A consistent payer gets the usual rule
 * card, which, kept, books the payer's next payment; a payer booked otherwise before, or a payment
 * provider whose payouts are split per order (#26), is mixed: the card says so and nothing is
 * drafted. On the real API server and a temp copy of tests/fixtures/sale-vat-index.json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, moduleActor, saveBooks } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readQuestions } from '../src/questions/store.js';
import { draftDir } from '../src/saving/changes.js';
import type { DraftView } from '../src/saving/rules.js';
import type { SaleRuleOffer } from '../src/saving/sale-rule.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import './support/jurisdiction.js';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const OWNER = 'Anna Muster';
let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json');
  appendFileSync(join(api.ws.paths.history, 'prior-year.Konten.txt'), '1023\tWise EUR\n3400\tDienstleistungsertrag\n');
  await api.send('GET', '/api/automation');
});
after(() => api?.stop());

const entriesOf = (ref: string) => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref);
const questionOn = (ref: string) => readQuestions(api.ws).find((q) => q.topic === 'saleVat' && q.on.id === ref)!;
const bookingStep = () => runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
const drafted = () => existsSync(join(draftDir(api.ws), GUIDE));
const kept = () => (existsSync(join(api.root, GUIDE)) ? (parse(readFileSync(join(api.root, GUIDE), 'utf8')) as { steps?: { classify?: { rules?: Array<Record<string, unknown>> } } }).steps?.classify?.rules ?? [] : []);
const alwaysSo = async (ref: string) => (await api.send('POST', '/api/rules/sale', { question: questionOn(ref).id })).json as unknown as SaleRuleOffer;
const pay = (ref: string, date: string, counterparty: string, iban: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount: 650, currency: 'CHF', direction: 'CRDT', description: `Zahlung ${counterparty}`, counterparty, counterpartyIban: iban });
const sale = (ref: string, date: string, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `e-${ref}`, transactionRef: ref, date, accountDebit: '1021', accountCredit: '3400', amount: 650, vatCode: 'V0', description: 'Kundenzahlung', origin: 'classify', ...over });

/** Adds the payments and their bookings, runs the booking step (which asks), and answers `ref` with `choice`. */
async function answered(txs: BankTransaction[], entries: JournalEntry[], ref: string, choice: string) {
  const b = loadBooks(api.ws);
  b.transactions.push(...txs);
  b.journalEntries.push(...entries);
  saveBooks(api.ws, b);
  await bookingStep();
  const r = await api.send('POST', `/api/questions/${questionOn(ref).id}/answer`, { by: OWNER, choice });
  assert.equal(r.status, 200, String(r.json.error));
}

test('an answer books its payment only: no rule file written, nothing drafted', async () => {
  await answered([pay('K-1', '2026-08-03', 'Kundin Beispiel', 'CH0000762011623852959')], [sale('K-1', '2026-08-03')], 'K-1', 'saleDomestic');
  assert.deepEqual(entriesOf('K-1').map((e) => [e.vatCode, e.origin]), [['V81', 'manual']]);
  assert.deepEqual([existsSync(join(api.root, GUIDE)), drafted()], [false, false]);
});

test('«Immer so?» on a consistent payer drafts the rule for its card; kept, it books the payer\'s next payment, named as Firma › Regeln names it (r4w-8)', async () => {
  assert.deepEqual(await alwaysSo('K-1'), { kind: 'rule', path: GUIDE });
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(GUIDE)}`)).json as unknown as DraftView;
  assert.equal(card.added.length, 1, 'one rule on the card');
  assert.equal((await api.send('POST', '/api/rules/draft', { kind: 'keep', path: GUIDE, basis: card.basis, confirm: card.confirm })).json.ok, true);
  const [rule] = kept();
  assert.deepEqual([rule.when, rule.then], [{ payer: 'CH0000762011623852959', direction: 'in' }, { account: '3400', vat: 'V81' }]);
  assert.match(String(rule.source), /^correction \d{4}-\d{2}-\d{2}$/);

  const b = loadBooks(api.ws);
  b.transactions.push(pay('K-2', '2026-09-03', 'Kundin Beispiel', 'CH0000762011623852959'));
  saveBooks(api.ws, b);
  await bookingStep();
  const [e] = entriesOf('K-2');
  assert.deepEqual([e.accountCredit, e.vatCode, e.rule], ['3400', 'V81', rule.id], 'the kept rule booked it, in code');
  assert.match(e.reason ?? '', /^Regel: .*Zahler Kundin Beispiel/, 'by the payer\'s name, not its key');
  assert.equal(questionOn('K-2'), undefined, 'not asked');
});

test('«Immer so?» on a payer whose earlier payment is booked otherwise says it is mixed and drafts nothing', async () => {
  const before = readFileSync(join(api.root, GUIDE), 'utf8');
  const iban = 'CH0000483501234567800';
  await answered(
    [pay('M-1', '2026-07-10', 'Mischkunde AG', iban), pay('M-2', '2026-08-10', 'Mischkunde AG', iban)],
    [sale('M-1', '2026-07-10', { origin: 'manual' }), sale('M-2', '2026-08-10')],
    'M-2', 'saleDomestic',
  );
  assert.deepEqual(await alwaysSo('M-2'), { kind: 'mixed', why: 'bookings', name: 'Mischkunde AG', other: 1 });
  assert.equal(drafted(), false, 'no draft');
  assert.equal(readFileSync(join(api.root, GUIDE), 'utf8'), before, 'no rule');
});

test('«Immer so?» on a payment provider\'s payout says it is mixed, better split per order (#26), and drafts nothing', async () => {
  const iban = 'IE00IRCE92050112345678';
  await answered(
    [pay('P-1', '2026-07-12', 'Zahlungsanbieter Beispiel Ltd', iban), pay('P-2', '2026-08-12', 'Zahlungsanbieter Beispiel Ltd', iban)],
    [sale('P-1', '2026-07-12', { vatCode: 'V81', by: { kind: 'code', check: 'payoutOrders' } }), sale('P-2', '2026-08-12', { vatCode: 'V81' })],
    'P-2', 'saleDomestic',
  );
  assert.deepEqual(await alwaysSo('P-2'), { kind: 'mixed', why: 'payout', name: 'Zahlungsanbieter Beispiel Ltd', other: 0 });
  assert.equal(drafted(), false, 'no draft');
});
