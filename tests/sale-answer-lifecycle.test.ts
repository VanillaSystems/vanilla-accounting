/**
 * The lifecycle of a «kein Umsatz» answer (r9n-20, r9n-21, #38): the answer rebooks that one sale
 * onto the owner's account and keeps no rule, so the payer's next payment is asked again; taking the
 * answer back, from the question's «Zurücknehmen» or from Änderungen › «Rückgängig» on the booking
 * it changed, undoes it: the booking as before the answer, the question open. Answering again works
 * also when the payment lost its booking meanwhile. On the real API server and a temp copy of
 * tests/fixtures/sale-vat-index.json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { initRepository } from '../src/workspace/git.js';
import { loadBooks, moduleActor, saveBooks } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readQuestions } from '../src/questions/store.js';
import { ownerAccountNumber } from '../src/accounting/bank-accounts.js';
import type { Question } from '../src/questions/model.js';
import type { ChangesView } from '../src/saving/model.js';
import type { BankTransaction } from '../src/types/index.js';
import './support/jurisdiction.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json');
  appendFileSync(join(api.ws.paths.history, 'prior-year.Konten.txt'), `3400\tDienstleistungsertrag\n${ownerAccountNumber(api.ws)}\tKontokorrent Inhaberin\n`);
  await initRepository(api.ws.paths.repository, 'Workspace set up');
  await api.send('GET', '/api/automation');
});
after(() => api?.stop());

const OWNER = 'Anna Muster';
const PAYER_IBAN = 'CH0000762011623852958';
const books = () => loadBooks(api.ws);
const entriesOf = (ref: string) => books().journalEntries.filter((e) => e.transactionRef === ref);
const questionOn = (ref: string) => readQuestions(api.ws).filter((q) => q.topic === 'saleVat' && q.on.id === ref).at(-1)!;
const bookingStep = () => runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
const guide = () => join(api.root, 'knowledge/rules/booking.guide.yaml');
const classifyRules = () => (existsSync(guide()) ? (parse(readFileSync(guide(), 'utf8')) as { steps: { classify?: { rules?: Array<Record<string, unknown>> } } }).steps.classify?.rules ?? [] : []);
const payment = (ref: string, amount: number, date: string): BankTransaction => ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'CRDT', description: `Zahlung ${ref}`, counterparty: 'Marta Beispiel', counterpartyIban: PAYER_IBAN });
const answer = async (ref: string, choice: string) => {
  const r = await api.send('POST', `/api/questions/${questionOn(ref).id}/answer`, { by: OWNER, choice });
  assert.equal(r.status, 200, String(r.json.error));
  return r.json as unknown as Question;
};
const hand = async () => ((await api.send('GET', '/api/changes')).json as unknown as ChangesView).books.hand;

test('the answer rebooks the sale and keeps no rule: the payer\'s next payment is asked, not booked by a rule (#38)', async () => {
  const b = books();
  b.transactions.push(payment('L-1', 1500, '2026-08-20'));
  b.journalEntries.push({ id: 'e-l1', transactionRef: 'L-1', date: '2026-08-20', accountDebit: '1021', accountCredit: '3400', amount: 1500, vatCode: 'V81', description: 'Marta Beispiel, Verkauf', origin: 'classify' });
  saveBooks(api.ws, b);
  await bookingStep();
  const q = await answer('L-1', 'notSale');
  const owner = ownerAccountNumber(api.ws);
  assert.deepEqual([entriesOf('L-1')[0].accountCredit, entriesOf('L-1')[0].vatCode], [owner, undefined]);
  const acted = q.answer?.acted;
  assert.ok(acted && 'booked' in acted && !acted.rule && !acted.also, `the answer names no rule: ${JSON.stringify(acted)}`);
  assert.deepEqual(classifyRules(), [], 'no rule for the payer');

  const next = books();
  next.transactions.push(payment('L-2', 800, '2026-09-05'));
  next.journalEntries.push({ id: 'e-l2', transactionRef: 'L-2', date: '2026-09-05', accountDebit: '1021', accountCredit: '3400', amount: 800, vatCode: 'V81', description: 'Marta Beispiel, Verkauf', origin: 'classify' });
  saveBooks(api.ws, next);
  await bookingStep();
  const [e2] = entriesOf('L-2');
  assert.deepEqual([e2.accountCredit, e2.vatCode, e2.rule], ['3400', 'V81', undefined], 'the payer\'s next payment keeps the app\'s proposal');
  assert.equal(questionOn('L-2').status, 'open', 'and is asked');
});

test('Änderungen lists the answer\'s booking as the answer; «Rückgängig» takes the answer back (r9n-20)', async () => {
  const q = questionOn('L-1');
  const row = (await hand()).find((h) => h.id === 'e-l1');
  assert.ok(row, 'the booking the answer changed is listed');
  assert.equal(row.answer, q.id, 'and named as the answer\'s');

  const undone = await api.send('POST', '/api/journal-entries/e-l1/as-saved');
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  const [back] = entriesOf('L-1');
  assert.ok(back, 'the booking is not deleted');
  assert.deepEqual([back.accountCredit, back.vatCode, back.origin], ['3400', 'V81', 'classify'], 'back as it stood before the answer');
  assert.equal(questionOn('L-1').status, 'open', 'the question is open again');
  assert.equal(books().transactions.find((t) => t.ref === 'L-1')!.noReceiptNeeded, undefined);
  assert.equal(questionOn('L-2').status, 'open', 'the other payment\'s question is untouched');
});

test('answering again works, also on a payment that lost its booking meanwhile (r9n-21)', async () => {
  const again = await answer('L-1', 'notSale');
  const owner = ownerAccountNumber(api.ws);
  assert.equal(entriesOf('L-1')[0].accountCredit, owner);

  assert.equal((await api.send('DELETE', '/api/journal-entries/e-l1')).status, 200);
  assert.equal((await api.send('POST', `/api/questions/${again.id}/undo`, { by: OWNER })).status, 200);
  assert.deepEqual(entriesOf('L-1'), [], 'the payment has no booking');

  const third = await answer('L-1', 'notSale');
  const acted = third.answer?.acted;
  assert.ok(acted && 'booked' in acted && acted.booked.length === 1, `the answer books the unbooked payment: ${JSON.stringify(acted)}`);
  const [e] = entriesOf('L-1');
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode, e.amount], ['1021', owner, undefined, 1500], 'bank against the owner\'s account');
  assert.equal(acted.rule, undefined, 'no rule');

  assert.equal((await api.send('POST', `/api/questions/${third.id}/undo`, { by: OWNER })).status, 200);
  assert.deepEqual(entriesOf('L-1'), [], 'the undo takes the answer\'s booking away again');
});

test('#38: one «kein Umsatz» answer books only its payment: the payer\'s other open question stays open, its booking unchanged', async () => {
  assert.equal(questionOn('L-2').status, 'open');
  const q = await answer('L-1', 'notSale');
  const acted = q.answer?.acted;
  assert.ok(acted && 'booked' in acted && !acted.also, `the answer answers nothing along: ${JSON.stringify(acted)}`);
  assert.equal(questionOn('L-2').status, 'open', 'the same payer\'s question is still asked');
  assert.deepEqual([entriesOf('L-2')[0].accountCredit, entriesOf('L-2')[0].vatCode], ['3400', 'V81'], 'its booking is the app\'s proposal still');
  assert.equal((await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER })).status, 200);
});

test('r10f-22: a question\'s state follows its payment\'s bookings: rebooked as a sale after «kein Umsatz», the card shows the correction and the mark follows, no rule; «Zurücknehmen» keeps the booking', async () => {
  const first = await answer('L-1', 'notSale');
  const [e] = entriesOf('L-1');
  assert.equal(books().transactions.find((t) => t.ref === 'L-1')!.noReceiptNeeded, true);
  // A person (or the KI on her wish) rebooks the payment as a sale with VAT.
  const r = await api.send('PATCH', `/api/journal-entries/${e.id}`, { accountCredit: '3400', vatCode: 'V81' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const q = questionOn('L-1');
  assert.equal(q.id, first.id, 'the same question, not a new one');
  assert.equal(q.status, 'answered');
  assert.deepEqual(q.answer?.answer, { choice: 'saleDomestic' }, 'the answer is what the booking says now');
  const acted = q.answer?.acted;
  assert.ok(acted && 'correction' in acted && acted.correction && acted.vatCode === 'V81' && !acted.rule, `a correction answer without a rule: ${JSON.stringify(acted)}`);
  assert.equal(books().transactions.find((t) => t.ref === 'L-1')!.noReceiptNeeded, undefined, 'a sale may need its receipt again');
  assert.deepEqual(classifyRules(), [], 'no rule for the payer');

  assert.equal((await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER })).status, 200);
  assert.deepEqual([entriesOf('L-1')[0].accountCredit, entriesOf('L-1')[0].vatCode], ['3400', 'V81'], 'the person\'s booking stays');
});
