/**
 * A customer payment without an invoice, booked without VAT (src/accounting/sales-without-vat.ts),
 * is a question to the owner, asked once by the booking step with the app's proposal
 * (src/questions/sale-vat.ts); the answer rebooks it and becomes a rule for the payer
 * (src/server/questions.ts), so the payer's next payment is booked by the rule in code, without a
 * question. On the real API server and a temp copy of tests/fixtures/sale-vat-index.json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, moduleActor, saveBooks } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readQuestions } from '../src/questions/store.js';
import { saleProposal, saleVatCode, salesWithoutInvoice, salesWithoutVat } from '../src/accounting/sales-without-vat.js';
import { ownerAccountNumber } from '../src/accounting/bank-accounts.js';
import { yearPaths } from '../src/workspace/workspace.js';
import type { Question } from '../src/questions/model.js';
import type { BankTransaction } from '../src/types/index.js';
import './support/jurisdiction.js';

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json');
  appendFileSync(join(api.ws.paths.history, 'prior-year.Konten.txt'), '1023\tWise EUR\n3400\tDienstleistungsertrag\n');
  // The first look at the automation takes what the workspace runs today as switched on (the baseline).
  await api.send('GET', '/api/automation');
});
after(() => api?.stop());

const OWNER = 'Anna Muster';
const CH_IBAN = 'CH0000762011623852957';
const books = () => loadBooks(api.ws);
const entriesOf = (ref: string) => books().journalEntries.filter((e) => e.transactionRef === ref);
const saleQuestions = () => readQuestions(api.ws).filter((q) => q.topic === 'saleVat');
const questionOn = (ref: string) => saleQuestions().find((q) => q.on.id === ref)!;
const bookingStep = () => runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
const answer = async (ref: string, choice: string) => {
  const r = await api.send('POST', `/api/questions/${questionOn(ref).id}/answer`, { by: OWNER, choice });
  assert.equal(r.status, 200, String(r.json.error));
  return r.json as unknown as Question;
};
const classifyRules = () => (parse(readFileSync(join(api.root, 'knowledge/rules/booking.guide.yaml'), 'utf8')) as { steps: { classify?: { rules?: Array<Record<string, unknown>> } } }).steps.classify?.rules ?? [];
const pending = () => salesWithoutVat(books(), true).map((s) => s.payment.ref);
/** The workflows waiting to be switched on, by id (GET /api/automation). */
const waiting = async () => ((await api.send('GET', '/api/automation')).json as unknown as { pending: Array<{ workflow: string; files: string[] }> }).pending.map((p) => p.workflow);

test('the proposal: CHF from a domestic IBAN is a sale at the normal rate; a foreign currency or IBAN an export', () => {
  const p = (currency: string, iban?: string) => saleProposal({ currency, ...(iban ? { counterpartyIban: iban } : {}) });
  assert.deepEqual(p('CHF', CH_IBAN), { choice: 'saleDomestic', why: 'domesticIban' });
  assert.deepEqual(p('CHF', 'LI00088100002324013AA'), { choice: 'saleDomestic', why: 'domesticIban' }, 'Liechtenstein is in the VAT territory');
  assert.deepEqual(p('CHF'), { choice: 'saleDomestic', why: 'domesticCurrency' });
  assert.deepEqual(p('CHF', 'DE00370400440532013000'), { choice: 'saleAbroad', why: 'foreignIban' });
  assert.deepEqual(p('EUR', CH_IBAN), { choice: 'saleAbroad', why: 'foreignCurrency' });
  assert.deepEqual([saleVatCode('saleDomestic'), saleVatCode('saleAbroad'), saleVatCode('notSale')], ['V81', 'V0', null], 'the codes come from the engines');
});

test('the booking step asks once per payment, to the owner, with the proposal; not a filed quarter, not a payment with a receipt', async () => {
  const before = readFileSync(join(yearPaths(api.ws.paths, '2026').books, 'entries.jsonl'), 'utf8');
  await bookingStep();
  const qs = saleQuestions();
  assert.deepEqual(qs.map((q) => q.on.id).sort(), ['S-CH', 'S-EU', 'S-GEN']);
  assert.deepEqual(questionOn('S-CH').proposal, { choice: 'saleDomestic', why: 'domesticIban' });
  assert.deepEqual(questionOn('S-EU').proposal, { choice: 'saleAbroad', why: 'foreignCurrency' });
  assert.deepEqual(questionOn('S-CH').choices, ['saleDomestic', 'saleAbroad', 'notSale']);
  assert.deepEqual([questionOn('S-CH').to, questionOn('S-CH').origin, questionOn('S-CH').status], [OWNER, 'booking', 'open']);
  await bookingStep();
  assert.equal(saleQuestions().length, 3, 'asked once: the next run asks nothing again');
  assert.equal(readFileSync(join(yearPaths(api.ws.paths, '2026').books, 'entries.jsonl'), 'utf8'), before, 'asking books nothing');
  assert.deepEqual(pending().sort(), ['S-CH', 'S-EU', 'S-GEN'], 'the warning stays until it is answered');
});

test('«mit MWST» books the sale at the normal rate and keeps a rule for the payer, keyed by the IBAN', async () => {
  const q = await answer('S-CH', 'saleDomestic');
  assert.equal(q.status, 'answered');
  const [e] = entriesOf('S-CH');
  assert.deepEqual([e.accountCredit, e.vatCode, e.origin], ['3400', 'V81', 'manual']);
  const rule = classifyRules().find((r) => r.id === `sale-${q.id}`);
  assert.deepEqual([rule?.when, rule?.then], [{ payer: CH_IBAN, direction: 'in' }, { account: '3400', vat: 'V81' }]);
  assert.ok(!pending().includes('S-CH'), 'answered: no longer a sale without VAT');
  // Her answer is her switching on: the rule it wrote into the guide leaves no workflow waiting (r6h-24).
  assert.deepEqual(await waiting(), [], 'the rule the answer kept is live');
  const start = await api.send('POST', '/api/automation', { kind: 'start', workflow: 'booking', item: { kind: 'transaction', id: 'S-CH' } });
  assert.equal(start.json.ok, true, `«Automatisch buchen» after an answer: ${JSON.stringify(start.json)}`);
});

test('«ohne MWST (Ausland)» keeps the export code, booked by hand, and keeps a rule; undo takes both back', async () => {
  const q = await answer('S-EU', 'saleAbroad');
  const [e] = entriesOf('S-EU');
  assert.deepEqual([e.vatCode, e.origin], ['V0', 'manual']);
  assert.deepEqual(classifyRules().find((r) => r.id === `sale-${q.id}`)?.then, { account: '3400', vat: 'V0' });
  assert.ok(!pending().includes('S-EU'));
  const undone = await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER });
  assert.equal((undone.json as unknown as Question).status, 'open');
  assert.deepEqual([entriesOf('S-EU')[0].vatCode, entriesOf('S-EU')[0].origin], ['V0', 'classify']);
  assert.equal(classifyRules().some((r) => r.id === `sale-${q.id}`), false, 'the rule went with the undo');
  assert.ok(pending().includes('S-EU'), 'open again: the warning is back');
  assert.deepEqual(await waiting(), [], 'the undo changed the guide as the person: nothing waits');
  await answer('S-EU', 'saleAbroad');
});

test('«kein Umsatz» takes the payment out of the turnover: its revenue entry goes to the owner\'s account without a code, the payment is marked; a generic payer text becomes no rule (r7f-28)', async () => {
  const q = await answer('S-GEN', 'notSale');
  const tx = books().transactions.find((t) => t.ref === 'S-GEN')!;
  assert.equal(tx.noReceiptNeeded, true);
  const owner = ownerAccountNumber(api.ws);
  const [e] = entriesOf('S-GEN');
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode, e.origin], ['1021', owner, undefined, 'manual'], 'no longer revenue, no VAT code, decided by a person');
  const acted = q.answer?.acted;
  assert.ok(acted && 'marked' in acted && acted.marked && !acted.rule, '«Gutschrift» names no payer');
  assert.deepEqual([acted.booked, acted.undo.length, acted.account], [['e-gen'], 1, owner], 'the card says what changed');
  assert.ok(!pending().includes('S-GEN'));
  assert.equal(salesWithoutInvoice(books(), true).some((s) => s.payment.ref === 'S-GEN'), false);
  const undone = await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER });
  assert.equal((undone.json as unknown as Question).status, 'open');
  const [back] = entriesOf('S-GEN');
  assert.deepEqual([back.accountCredit, back.vatCode, back.origin, books().transactions.find((t) => t.ref === 'S-GEN')!.noReceiptNeeded], ['3400', 'V0', 'classify', undefined], 'undo puts the sale back as the classifier booked it');
  await answer('S-GEN', 'notSale');
});

test('the payer\'s next payment is booked by the rule in code, without a question; a generic payer is asked again', async () => {
  const b = books();
  const next = (ref: string, over: Partial<BankTransaction>): BankTransaction => ({ ref, bank: 'Raiffeisen', date: '2026-09-10', amount: 540.5, currency: 'CHF', direction: 'CRDT', description: 'Beratung September', ...over });
  b.transactions.push(
    next('N-CH', { counterparty: 'Beispiel Kunde AG', counterpartyIban: CH_IBAN }),
    next('N-EU', { bank: 'Wise', currency: 'EUR', description: 'Received money from Exemple SARL with reference 43', counterparty: 'Exemple SARL', counterpartyIban: 'FR0030006000011234567890189' }),
    next('N-GEN', { description: 'Gutschrift' }),
  );
  // What the model would book for the generic payment: revenue at the zero code.
  b.journalEntries.push({ id: 'e-ngen', transactionRef: 'N-GEN', date: '2026-09-10', accountDebit: '1021', accountCredit: '3400', amount: 540.5, vatCode: 'V0', origin: 'classify' });
  saveBooks(api.ws, b);
  await bookingStep();
  const [ch] = entriesOf('N-CH');
  assert.deepEqual([ch.accountDebit, ch.accountCredit, ch.vatCode, ch.origin, ch.rule?.startsWith('sale-')], ['1021', '3400', 'V81', 'classify', true]);
  assert.match(ch.reason ?? '', /^Regel: .*Zahler Beispiel Kunde AG/, 'the reason names the payer as Firma › Regeln does (r4w-8)');
  assert.doesNotMatch(ch.reason ?? '', new RegExp(CH_IBAN), 'not by its key');
  const [eu] = entriesOf('N-EU');
  assert.deepEqual([eu.accountDebit, eu.accountCredit, eu.vatCode, eu.exchangeCurrency], ['1023', '3400', 'V0', 'EUR']);
  assert.deepEqual(saleQuestions().filter((q) => q.on.id.startsWith('N-')).map((q) => q.on.id), ['N-GEN'], 'only the generic payer is asked');
  assert.deepEqual(pending(), ['N-GEN']);
});

test('a filed quarter is never asked about nor changed; a payment with a receipt is never changed: the question is closed, saying why (r4c-29)', async () => {
  const filed = { tx: books().transactions.find((t) => t.ref === 'S-OLD'), entries: entriesOf('S-OLD') };
  const inject = (ref: string) => {
    const id = `q-inj-${ref}`;
    appendFileSync(yearPaths(api.ws.paths, '2026').questions, `${JSON.stringify({ v: 1, event: 'asked', id, at: new Date().toISOString(), by: 'app', to: OWNER, origin: 'booking', topic: 'saleVat', on: { kind: 'payment', id: ref }, text: '?', choices: ['saleDomestic', 'saleAbroad', 'notSale'] })}\n`);
    return id;
  };
  assert.equal(saleQuestions().some((q) => q.on.id === 'S-OLD' || q.on.id === 'S-DOC'), false, 'not asked');
  const oldId = inject('S-OLD');
  const old = await api.send('POST', `/api/questions/${oldId}/answer`, { by: OWNER, choice: 'saleDomestic' });
  assert.equal(old.status, 409);
  assert.deepEqual([old.json.code, (old.json.params as { why: string }).why], ['questionGone', 'closed']);
  assert.match(String(old.json.error), /eingereicht/);
  assert.deepEqual(saleQuestions().find((q) => q.id === oldId)?.closed?.why, 'closed', 'closed, saying why');
  assert.deepEqual({ tx: books().transactions.find((t) => t.ref === 'S-OLD'), entries: entriesOf('S-OLD') }, filed, 'the filed quarter stays as filed');
  const docId = inject('S-DOC');
  const listed = (await api.send('GET', '/api/questions')).json as unknown as { questions: Question[] };
  assert.deepEqual([listed.questions.find((q) => q.id === docId)?.status, listed.questions.find((q) => q.id === docId)?.closed?.why], ['closed', 'hasReceipt'], 'closed when the list is read, before anyone answers');
  const doc = await api.send('POST', `/api/questions/${docId}/answer`, { by: OWNER, choice: 'notSale' });
  assert.equal(doc.status, 409, 'a closed question takes no answer');
  assert.equal(books().transactions.find((t) => t.ref === 'S-DOC')?.noReceiptNeeded, undefined);
  assert.equal(entriesOf('S-DOC')[0].vatCode, 'V0');
  assert.equal(classifyRules().filter((r) => String(r.id).startsWith('sale-q-inj')).length, 0, 'a refused answer keeps no rule');
});

test('an answer while the period is held (approved, not filed) is refused with the hold\'s reason and the question stays open, nothing booked, no rule; after «Zurück» the same answer goes through (r8h-24)', async () => {
  const held = loadBooks(api.ws);
  held.transactions.push({ ref: 'S-HELD', bank: 'Raiffeisen', date: '2026-08-20', amount: 540.5, currency: 'CHF', direction: 'CRDT', description: 'Beratung Keller', counterparty: 'Keller AG', counterpartyIban: 'CH0000762011623852958' });
  held.journalEntries.push({ id: 'e-held', transactionRef: 'S-HELD', date: '2026-08-20', accountDebit: '1021', accountCredit: '3400', amount: 540.5, vatCode: 'V0', description: 'Kundenzahlung', origin: 'classify' });
  held.config.approvedReturn = { period: '2026-Q3', through: '2026-09-30' };
  saveBooks(api.ws, held);
  const id = 'q-inj-S-HELD';
  appendFileSync(yearPaths(api.ws.paths, '2026').questions, `${JSON.stringify({ v: 1, event: 'asked', id, at: new Date().toISOString(), by: 'app', to: OWNER, origin: 'booking', topic: 'saleVat', on: { kind: 'payment', id: 'S-HELD' }, text: '?', choices: ['saleDomestic', 'saleAbroad', 'notSale'] })}\n`);

  const r = await api.send('POST', `/api/questions/${id}/answer`, { by: OWNER, choice: 'saleDomestic' });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.deepEqual([r.json.code, (r.json.params as { approved?: string }).approved], ['periodClosed', '2026-Q3'], 'the hold\'s own refusal, which names «Zurück»');
  const q = saleQuestions().find((x) => x.id === id)!;
  assert.deepEqual([q.status, q.answer], ['open', undefined], 'not stored as answered and refused: still asked');
  assert.equal(entriesOf('S-HELD')[0].vatCode, 'V0', 'nothing booked');
  assert.equal(classifyRules().some((x) => x.id === `sale-${id}`), false, 'no rule kept');

  const free = loadBooks(api.ws);
  delete free.config.approvedReturn;
  saveBooks(api.ws, free);
  const answered = await answer('S-HELD', 'saleDomestic');
  assert.equal(answered.status, 'answered');
  assert.equal(entriesOf('S-HELD')[0].vatCode, 'V81', 'booked as the owner said, once the period is free');
});
