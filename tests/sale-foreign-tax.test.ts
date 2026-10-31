/**
 * A customer payment without an invoice that was a sale abroad with a foreign VAT in it (OSS, IOSS, a
 * registration abroad): the answer «Ausland mit ausländischer MWST» books it as a sales report books
 * such an order (#206), the net at the export code and the tax onto the company's account for it
 * without a code, never the gross at V0. «Immer so?» keeps the split in the payer's rule
 * (`then.foreignTax`), which books the payer's next payment so. On the real API server and a temp
 * copy of tests/fixtures/sale-vat-index.json; the payers are made up.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, moduleActor, saveBooks } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { ruleBookingLines } from '../src/booking/classify.js';
import { parseRule, type RuleFacts } from '../src/booking/rules.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readQuestions } from '../src/questions/store.js';
import { foreignTaxAccount, foreignTaxIn, salesWithoutVat } from '../src/accounting/sales-without-vat.js';
import type { DraftView } from '../src/saving/rules.js';
import type { SaleRuleOffer } from '../src/saving/sale-rule.js';
import type { Question, QuestionsView } from '../src/questions/model.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import './support/jurisdiction.js';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const OWNER = 'Anna Muster';
const DE_IBAN = 'DE00370400440532013000';
let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json');
  appendFileSync(join(api.ws.paths.history, 'prior-year.Konten.txt'), '1023\tWise EUR\n3400\tDienstleistungsertrag\n2201\tAusländische MWST\n');
  await api.send('GET', '/api/automation');
});
after(() => api?.stop());

const books = () => loadBooks(api.ws);
/** A payment's entries, the sale before the tax line (the books keep their own order). */
const entriesOf = (ref: string) => books().journalEntries.filter((e) => e.transactionRef === ref).sort((a, b) => b.accountCredit.localeCompare(a.accountCredit));
const questionOn = (ref: string) => readQuestions(api.ws).find((q) => q.topic === 'saleVat' && q.on.id === ref)!;
const bookingStep = () => runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
const kept = () => (existsSync(join(api.root, GUIDE)) ? (parse(readFileSync(join(api.root, GUIDE), 'utf8')) as { steps?: { classify?: { rules?: Array<Record<string, unknown>> } } }).steps?.classify?.rules ?? [] : []);
const pay = (ref: string, date: string, amount: number, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Wise', date, amount, currency: 'EUR', direction: 'CRDT', description: `Received money from Kundin Muster with reference Bestellung ${ref}`, counterparty: 'Kundin Muster', counterpartyIban: DE_IBAN, ...over });
/** What the classifier books for a sale abroad without an invoice: the gross at the export code. */
const gross = (ref: string, date: string, amount: number): JournalEntry =>
  ({ id: `e-${ref}`, transactionRef: ref, date, accountDebit: '1023', accountCredit: '3400', amount, vatCode: 'V0', description: 'Kundenzahlung', origin: 'classify', exchangeCurrency: 'EUR', exchangeRate: 0.94 });
const send = (ref: string, body: Record<string, unknown>) => api.send('POST', `/api/questions/${questionOn(ref).id}/answer`, { by: OWNER, ...body });

async function asked(txs: BankTransaction[], entries: JournalEntry[]) {
  const b = books();
  b.transactions.push(...txs);
  b.journalEntries.push(...entries);
  saveBooks(api.ws, b);
  await bookingStep();
}

test('the foreign VAT inside a gross, to the cent', () => {
  assert.equal(foreignTaxIn(363.05, 19), 57.97, '305.08 net + 57.97 = 363.05');
  assert.equal(foreignTaxIn(238, 19), 38);
});

test('the account is the one the last answer booked, else the one the providers\' files name, else none', () => {
  const answered = (account: string, at: string) => ({ status: 'answered', answer: { at, acted: { booked: [], undo: [], foreignTax: { rate: 19, amount: 1, account } } } }) as unknown as Question;
  assert.equal(foreignTaxAccount(new Set(['2201']), []), '2201');
  assert.equal(foreignTaxAccount(new Set(['2201', '2202']), []), undefined, 'two providers, two accounts: the person names it');
  assert.equal(foreignTaxAccount(new Set(), [answered('2203', '2026-08-01'), answered('2204', '2026-09-01')]), '2204', 'the latest answer');
});

test('«Ausland mit ausländischer MWST» books the net at V0 and the tax onto its account without a code, never the gross at V0', async () => {
  await asked([pay('FT-1', '2026-08-06', 363.05)], [gross('FT-1', '2026-08-06', 363.05)]);
  assert.ok(questionOn('FT-1'), 'asked');
  const r = await send('FT-1', { choice: 'saleAbroad', foreignTax: { rate: 19, account: '2201' } });
  assert.equal(r.status, 200, String(r.json.error));
  const q = r.json as unknown as Question;
  const [sale, tax] = entriesOf('FT-1');
  assert.deepEqual([sale.accountDebit, sale.accountCredit, sale.amount, sale.vatCode, sale.origin], ['1023', '3400', 305.08, 'V0', 'manual']);
  assert.deepEqual([tax.accountDebit, tax.accountCredit, tax.amount, tax.vatCode, tax.origin, tax.exchangeCurrency, tax.exchangeRate], ['1023', '2201', 57.97, undefined, 'manual', 'EUR', 0.94]);
  assert.equal(tax.description, 'Kundenzahlung, ausländische MWST 19 %', 'the sale\'s text, then the tax');
  const acted = q.answer!.acted!;
  assert.ok('vatCode' in acted && acted.vatCode === 'V0');
  assert.deepEqual('foreignTax' in acted && acted.foreignTax, { rate: 19, amount: 57.97, account: '2201' });
  assert.deepEqual(q.answer!.answer, { choice: 'saleAbroad', foreignTax: { rate: 19, amount: 57.97, account: '2201' } }, 'the answer keeps the tax as booked');
  assert.ok(!salesWithoutVat(books(), true).some((s) => s.payment.ref === 'FT-1'), 'answered: no longer a sale without VAT');
});

test('the next question proposes the account the answer named', async () => {
  await asked([pay('FT-2', '2026-08-20', 238)], [gross('FT-2', '2026-08-20', 238)]);
  const view = (await api.send('GET', '/api/questions')).json as unknown as QuestionsView;
  assert.equal(view.foreignTax, '2201');
});

test('a foreign VAT the sale cannot hold is refused with a code and recorded nowhere: the question stays open', async () => {
  const refused = async (body: Record<string, unknown>, code: string) => {
    const r = await send('FT-2', body);
    assert.deepEqual([r.status, r.json.code], [400, code], JSON.stringify(body));
  };
  await refused({ choice: 'saleAbroad', foreignTax: { rate: 0, account: '2201' } }, 'foreignTaxInvalid');
  await refused({ choice: 'saleAbroad', foreignTax: { rate: 19 } }, 'foreignTaxInvalid');
  await refused({ choice: 'saleAbroad', foreignTax: { amount: 238, account: '2201' } }, 'foreignTaxInvalid');
  await refused({ choice: 'saleDomestic', foreignTax: { rate: 19, account: '2201' } }, 'foreignTaxInvalid');
  await refused({ choice: 'saleAbroad', foreignTax: { rate: 19, account: '2999' } }, 'unknownAccount');
  assert.equal(questionOn('FT-2').status, 'open');
  assert.deepEqual(entriesOf('FT-2').map((e) => [e.amount, e.vatCode, e.origin]), [[238, 'V0', 'classify']], 'nothing booked');
});

test('the tax amount alone gives the rate; undo deletes the tax line and puts the gross back', async () => {
  const r = await send('FT-2', { choice: 'saleAbroad', foreignTax: { amount: 38, account: '2201' } });
  assert.equal(r.status, 200, String(r.json.error));
  const q = r.json as unknown as Question;
  assert.deepEqual(q.answer!.answer, { choice: 'saleAbroad', foreignTax: { rate: 19, amount: 38, account: '2201' } });
  assert.deepEqual(entriesOf('FT-2').map((e) => [e.accountCredit, e.amount, e.vatCode ?? '']), [['3400', 200, 'V0'], ['2201', 38, '']]);
  const undone = await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER });
  assert.equal((undone.json as unknown as Question).status, 'open');
  assert.deepEqual(entriesOf('FT-2').map((e) => [e.accountCredit, e.amount, e.vatCode, e.origin]), [['3400', 238, 'V0', 'classify']]);
});

test('«Immer so?» keeps the split in the payer\'s rule, which books the payer\'s next payment so, without a question', async () => {
  // The payer's other open payment answered alike first: «Immer so?» drafts only for a payer booked one way.
  assert.equal((await send('FT-2', { choice: 'saleAbroad', foreignTax: { rate: 19, account: '2201' } })).status, 200);
  const offer = (await api.send('POST', '/api/rules/sale', { question: questionOn('FT-1').id })).json as unknown as SaleRuleOffer;
  assert.deepEqual(offer, { kind: 'rule', path: GUIDE });
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(GUIDE)}`)).json as unknown as DraftView;
  assert.equal((await api.send('POST', '/api/rules/draft', { kind: 'keep', path: GUIDE, basis: card.basis, confirm: card.confirm })).json.ok, true);
  const [rule] = kept();
  assert.deepEqual([rule.when, rule.then], [{ payer: DE_IBAN, direction: 'in' }, { account: '3400', vat: 'V0', foreignTax: { rate: 19, account: '2201' } }]);

  const b = books();
  b.transactions.push(pay('FT-3', '2026-09-03', 119));
  saveBooks(api.ws, b);
  await bookingStep();
  assert.deepEqual(entriesOf('FT-3').map((e) => [e.accountCredit, e.amount, e.vatCode ?? '', e.rule]), [['3400', 100, 'V0', rule.id], ['2201', 19, '', rule.id]]);
  assert.equal(questionOn('FT-3'), undefined, 'not asked');
});

const facts: RuleFacts = { account: (n) => ['3400', '2201', '1023'].includes(n), vat: () => 'taken', counterparty: () => false };
const rule = (then: Record<string, unknown>) => parseRule({ id: 'r', when: { payer: DE_IBAN }, then }, facts);

test('a rule\'s foreign VAT is { rate, account } beside a zero code only', () => {
  const ok = rule({ account: '3400', vat: 'V0', foreignTax: { rate: 19, account: '2201' } });
  assert.ok(ok.ok && ok.rule.then.kind === 'book' && ok.rule.then.booking.foreignTax?.rate === 19);
  for (const then of [
    { account: '3400', vat: 'V81', foreignTax: { rate: 19, account: '2201' } },
    { account: '3400', vat: 'V0', private: 50, foreignTax: { rate: 19, account: '2201' } },
    { account: '3400', vat: 'V0', foreignTax: { rate: 120, account: '2201' } },
    { account: '3400', vat: 'V0', foreignTax: 19 },
  ]) {
    const r = rule(then);
    assert.ok(!r.ok && r.refusal.code === 'foreignTax', JSON.stringify(then));
  }
  const unknown = rule({ account: '3400', vat: 'V0', foreignTax: { rate: 19, account: '2999' } });
  assert.ok(!unknown.ok && unknown.refusal.code === 'account');
});

test('a rule\'s lines with a foreign VAT add up to the payment; money back takes the tax back too', () => {
  const booking = { account: '3400', vat: 'V0', foreignTax: { rate: 19, account: '2201' } };
  assert.deepEqual(ruleBookingLines(pay('X', '2026-09-01', 363.05), booking, [], undefined), [{ account: '3400', vat: 'V0', amount: 305.08 }, { account: '2201', amount: 57.97 }]);
  assert.deepEqual(ruleBookingLines(pay('Y', '2026-09-01', 119, { direction: 'DBIT' }), booking, [], undefined), [{ account: '3400', vat: '-V0', amount: 100 }, { account: '2201', amount: 19 }]);
});
