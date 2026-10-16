/**
 * The lifecycle of a «kein Umsatz» answer (r9n-20, r9n-21, r9n-22): the answer rebooks the sale
 * onto the owner's account and keeps a rule for the payer; the rule books the payer's next payment;
 * taking the answer back, from the question's «Zurücknehmen» or from Änderungen › «Rückgängig» on
 * the booking it changed, undoes all of it: the booking as before the answer, the rule gone, the
 * question open, and the rule's later bookings back to the app's proposal with their own question.
 * Answering again works also when the payment lost its booking meanwhile. On the real API server
 * and a temp copy of tests/fixtures/sale-vat-index.json.
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

test('the answer rebooks the sale, keeps a payer rule, and the rule books the next payment', async () => {
  const b = books();
  b.transactions.push(payment('L-1', 1500, '2026-08-20'));
  b.journalEntries.push({ id: 'e-l1', transactionRef: 'L-1', date: '2026-08-20', accountDebit: '1021', accountCredit: '3400', amount: 1500, vatCode: 'V81', description: 'Marta Beispiel, Verkauf', origin: 'classify' });
  saveBooks(api.ws, b);
  await bookingStep();
  const q = await answer('L-1', 'notSale');
  const owner = ownerAccountNumber(api.ws);
  assert.deepEqual([entriesOf('L-1')[0].accountCredit, entriesOf('L-1')[0].vatCode], [owner, undefined]);
  assert.equal(classifyRules().some((r) => r.id === `sale-${q.id}`), true, 'a rule for the payer');

  const next = books();
  next.transactions.push(payment('L-2', 800, '2026-09-05'));
  saveBooks(api.ws, next);
  await bookingStep();
  const [e2] = entriesOf('L-2');
  assert.deepEqual([e2.accountCredit, e2.vatCode, e2.rule], [owner, undefined, `sale-${q.id}`], 'the rule booked the payer\'s next payment');
});

test('Änderungen lists the answer\'s booking as the answer; «Rückgängig» takes the whole answer back (r9n-20, r9n-22)', async () => {
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
  assert.equal(classifyRules().some((r) => r.id === `sale-${q.id}`), false, 'the payer rule is gone');

  const [e2] = entriesOf('L-2');
  assert.deepEqual([e2.accountCredit, e2.vatCode, e2.rule, e2.origin], ['3400', 'V81', undefined, 'classify'], 'the rule\'s later booking is the app\'s proposal again');
  assert.doesNotMatch(e2.reason ?? '', /Regel/, 'no booking keeps a reason naming the withdrawn rule');
  assert.equal(questionOn('L-2')?.status, 'open', 'the owner is asked about that payment');
});

test('answering again works, also on a payment that lost its booking meanwhile, and keys the rule by the statement\'s IBAN (r9n-21)', async () => {
  const again = await answer('L-1', 'notSale');
  const owner = ownerAccountNumber(api.ws);
  assert.equal(entriesOf('L-1')[0].accountCredit, owner);
  assert.deepEqual(classifyRules().find((r) => r.id === `sale-${again.id}`)?.when, { payer: PAYER_IBAN, direction: 'in' });

  assert.equal((await api.send('DELETE', '/api/journal-entries/e-l1')).status, 200);
  assert.equal((await api.send('POST', `/api/questions/${again.id}/undo`, { by: OWNER })).status, 200);
  assert.equal(classifyRules().some((r) => r.id === `sale-${again.id}`), false);
  assert.deepEqual(entriesOf('L-1'), [], 'the payment has no booking');

  const third = await answer('L-1', 'notSale');
  const acted = third.answer?.acted;
  assert.ok(acted && 'booked' in acted && acted.booked.length === 1, `the answer books the unbooked payment: ${JSON.stringify(acted)}`);
  const [e] = entriesOf('L-1');
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode, e.amount], ['1021', owner, undefined, 1500], 'bank against the owner\'s account');
  assert.equal(acted.rule, `sale-${third.id}`, 'the rule is kept: the statement names the payer');
  assert.deepEqual(classifyRules().find((r) => r.id === `sale-${third.id}`)?.when, { payer: PAYER_IBAN, direction: 'in' });

  assert.equal((await api.send('POST', `/api/questions/${third.id}/undo`, { by: OWNER })).status, 200);
  assert.deepEqual(entriesOf('L-1'), [], 'the undo takes the answer\'s booking away again');
});

test('r10f-34, r10n-2: one «kein Umsatz» answer holds for the payer\'s other open question too; taking it back opens both again', async () => {
  // After the undo above: L-1 unbooked, L-2 booked as the app's proposal with its own open question (the state r10n-2 found).
  assert.equal(questionOn('L-2').status, 'open');
  const q = await answer('L-1', 'notSale');
  const owner = ownerAccountNumber(api.ws);
  const acted = q.answer?.acted;
  assert.ok(acted && 'also' in acted && acted.also?.length === 1 && acted.also[0] === 'L-2', `the answer names the payer's other payment it answered: ${JSON.stringify(acted)}`);
  const sibling = questionOn('L-2');
  assert.equal(sibling.status, 'answered', 'the same payer\'s open question is answered along');
  assert.equal(sibling.answer?.from, acted.rule, 'by the payer rule the answer kept');
  assert.deepEqual([entriesOf('L-2')[0].accountCredit, entriesOf('L-2')[0].vatCode], [owner, undefined], 'its booking left the turnover too');

  assert.equal((await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER })).status, 200);
  assert.equal(questionOn('L-2').status, 'open', 'the other question is open again with the answer');
  assert.deepEqual([entriesOf('L-2')[0].accountCredit, entriesOf('L-2')[0].vatCode], ['3400', 'V81'], 'its booking is back as before');
});

test('r10f-22: a question\'s state follows its payment\'s bookings: rebooked as a sale after «kein Umsatz», the card shows the correction, the rule and the mark follow, and «Zurücknehmen» keeps the booking', async () => {
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
  assert.ok(acted && 'correction' in acted && acted.correction && acted.vatCode === 'V81', `a correction answer: ${JSON.stringify(acted)}`);
  assert.equal(books().transactions.find((t) => t.ref === 'L-1')!.noReceiptNeeded, undefined, 'a sale may need its receipt again');
  const rule = classifyRules().find((x) => x.id === acted.rule);
  assert.deepEqual(rule?.then, { account: '3400', vat: 'V81' }, 'the payer rule says sale now');
  assert.equal(classifyRules().filter((x) => (x.when as { payer?: string }).payer === PAYER_IBAN).length, 1, 'one rule per payer');

  assert.equal((await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER })).status, 200);
  assert.deepEqual([entriesOf('L-1')[0].accountCredit, entriesOf('L-1')[0].vatCode], ['3400', 'V81'], 'the person\'s booking stays; only the rule goes');
  assert.equal(classifyRules().some((x) => x.id === acted.rule), false);
});
