/**
 * A person's correction of a customer payment without an invoice teaches (MISSION.md «Every
 * correction teaches»): fixed by hand or by a wish, it answers the app's question about the sale
 * (src/server/questions.ts learnFromCorrection) for that payment only, without a rule for the payer
 * (#38: «Immer so?» under the answer offers one); «Neu klassifizieren» › «Trotzdem neu buchen» books
 * the app's proposal, never the model's V0. Persona test 2026-10-15 corner-4. On the real API server, the model a stub that answers V0 as the test saw.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, moduleActor, saveBooks } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readQuestions } from '../src/questions/store.js';
import type { AssistantEvent } from '../src/types/assistant.js';
import type { Question } from '../src/questions/model.js';
import './support/jurisdiction.js';

const REPO = process.cwd();
const changes = join(mkdtempSync(join(tmpdir(), 'sale-correction-')), 'changes.json');
const V0 = (ref: string, amount: number) => ({ entries: [{ accountDebit: '', accountCredit: '3400', amount, vatCode: 'V0', description: 'Kunde, Arbeiten' }], reason: 'ohne Beleg und ohne MWST-Angabe gilt V0' });

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json', {
    PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`,
    CLAUDE_STUB_CLASSIFY: JSON.stringify({ 'S-CH': V0('S-CH', 1081), 'S-EU': V0('S-EU', 500), 'S-GEN': V0('S-GEN', 200), 'S-NEW': V0('S-NEW', 300) }),
    CLAUDE_STUB_CHANGES: changes,
  });
  appendFileSync(join(api.ws.paths.history, 'prior-year.Konten.txt'), '1023\tWise EUR\n3400\tDienstleistungsertrag\n');
});
after(() => api?.stop());

const OWNER = 'Anna Muster';
const entriesOf = (ref: string) => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref);
const questionOn = (ref: string) => readQuestions(api.ws).filter((q) => q.topic === 'saleVat' && q.on.id === ref);
const guide = () => join(api.root, 'knowledge/rules/booking.guide.yaml');
const rules = () => (existsSync(guide()) ? (parse(readFileSync(guide(), 'utf8')) as { steps?: { classify?: { rules?: Array<Record<string, unknown>> } } }).steps?.classify?.rules ?? [] : []);
const rebookAnyway = async (ref: string) => {
  const r = await api.send('POST', `/api/journal-entries/classify/${ref}`, { overwrite: true });
  assert.equal(r.status, 200, String(r.json.error));
};

test('a hand correction of a sale nobody asked about yet asks and answers the question, and keeps no rule (#38)', async () => {
  const r = await api.send('PATCH', '/api/journal-entries/e-ch', { vatCode: 'V81' });
  assert.equal(r.status, 200, String(r.json.error));
  const [q] = questionOn('S-CH');
  assert.deepEqual([q.status, q.answer?.by, q.answer?.answer], ['answered', OWNER, { choice: 'saleDomestic' }]);
  assert.deepEqual(q.answer?.acted, { booked: [], undo: [], vatCode: 'V81', correction: true });
  assert.deepEqual(rules(), [], 'no rule for the payer');
});

test('«Trotzdem neu buchen» after the correction books the app\'s proposal V81 for the domestic payer, not the model\'s V0', async () => {
  await rebookAnyway('S-CH');
  const [e] = entriesOf('S-CH');
  assert.deepEqual([e.vatCode, e.accountCredit, e.rule], ['V81', '3400', undefined]);
});

test('a correction to the abroad code is a «Ausland» answer, without a rule', async () => {
  await runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
  assert.equal(questionOn('S-EU')[0].status, 'open', 'the booking step asked');
  const r = await api.send('PATCH', '/api/journal-entries/e-eu', { vatCode: 'V0-E' });
  assert.equal(r.status, 200, String(r.json.error));
  const [q] = questionOn('S-EU');
  assert.deepEqual([q.status, q.answer?.answer], ['answered', { choice: 'saleAbroad' }]);
  assert.deepEqual(rules(), []);
  assert.deepEqual(entriesOf('S-EU').map((e) => e.vatCode), ['V0-E']);
});

test('a wish that fixes a generic payer\'s sale answers its question without a rule; the forced rebook still keeps V81', async () => {
  writeFileSync(changes, JSON.stringify([{ kind: 'entry', id: 'e-gen', set: { vatCode: 'V81' } }]));
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'das ist eine Arbeit hier in Wil, mit MWST', language: 'de', context: [] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  assert.ok(events.some((e) => e.type === 'changes'), JSON.stringify(events.at(-1)));
  const [q] = questionOn('S-GEN');
  assert.deepEqual([q.status, q.answer?.answer, q.answer?.acted && 'rule' in q.answer.acted ? q.answer.acted.rule : undefined], ['answered', { choice: 'saleDomestic' }, undefined], '«Gutschrift» names no payer');
  await rebookAnyway('S-GEN');
  const [e] = entriesOf('S-GEN');
  assert.deepEqual([e.vatCode, e.origin], ['V81', 'classify'], 'no rule, and still the proposal, never V0');
});

test('«Zurücknehmen» on an answer from a correction keeps her booking', async () => {
  const [q] = questionOn('S-EU');
  const r = await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER });
  assert.equal(r.status, 200, String(r.json.error));
  assert.equal(questionOn('S-EU')[0].status, 'open');
  assert.deepEqual(entriesOf('S-EU').map((e) => [e.vatCode, e.origin]), [['V0-E', 'manual']]);
});

test('then «mit MWST» books the payment at the normal rate, and no rule (r4c-28, #38)', async () => {
  const [q] = questionOn('S-EU');
  const r = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'saleDomestic' });
  assert.equal(r.status, 200, String(r.json.error));
  const acted = (r.json as unknown as Question).answer?.acted as { booked: string[]; vatCode: string; rule?: string };
  assert.deepEqual([acted.booked, acted.vatCode, acted.rule], [entriesOf('S-EU').map((e) => e.id), 'V81', undefined]);
  assert.equal(acted.booked.length, 1);
  assert.deepEqual(entriesOf('S-EU').map((e) => e.vatCode), ['V81']);
});

test('«Zurücknehmen» after the answer\'s booking was booked anew takes back what is still there: the question opens, the new booking stays', async () => {
  const [q] = questionOn('S-EU');
  await rebookAnyway('S-EU');
  const anew = entriesOf('S-EU').map((e) => [e.id, e.vatCode]);
  const r = await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER });
  assert.equal(r.status, 200, String(r.json.error));
  assert.equal(questionOn('S-EU')[0].status, 'open');
  assert.deepEqual(entriesOf('S-EU').map((e) => [e.id, e.vatCode]), anew);
});

test('a payment with no revenue booking the app may set is refused in words, not answered «0 Buchungen»', async () => {
  const b = loadBooks(api.ws);
  b.transactions.push({ ref: 'S-NONE', bank: 'Raiffeisen', date: '2026-08-20', amount: 90, currency: 'CHF', direction: 'CRDT', description: 'Rückzahlung', counterparty: 'Beispiel Kunde AG', counterpartyIban: 'CH0000762011623852957' });
  b.journalEntries.push({ id: 'e-none', transactionRef: 'S-NONE', date: '2026-08-20', accountDebit: '1021', accountCredit: '2451', amount: 90, description: 'Rückzahlung', origin: 'manual' });
  saveBooks(api.ws, b);
  const id = 'q-inj-none';
  appendFileSync(join(api.root, 'transactional-data/2026/questions.jsonl'), `${JSON.stringify({ v: 1, event: 'asked', id, at: new Date().toISOString(), by: 'app', to: OWNER, origin: 'booking', topic: 'saleVat', on: { kind: 'payment', id: 'S-NONE' }, text: '?', choices: ['saleDomestic', 'saleAbroad', 'notSale'] })}\n`);
  const r = await api.send('POST', `/api/questions/${id}/answer`, { by: OWNER, choice: 'saleDomestic' });
  assert.deepEqual((r.json as unknown as Question).answer?.acted, { refused: 'noSaleEntry', detail: 'Rückzahlung' });
});

test('her V0 on a payer at home is asked back, not taken as «Ausland»; her answer then books it, without a rule (r4c-35)', async () => {
  const b = loadBooks(api.ws);
  b.transactions.push({ ref: 'S-HOME', bank: 'Raiffeisen', date: '2026-08-21', amount: 3274.4, currency: 'CHF', direction: 'CRDT', description: 'Malerarbeiten', counterparty: 'Hans Muster', counterpartyIban: 'CH0000235099999999999' });
  b.journalEntries.push({ id: 'e-home', transactionRef: 'S-HOME', date: '2026-08-21', accountDebit: '1021', accountCredit: '3400', amount: 3274.4, vatCode: 'V81', description: 'Kundenzahlung Hans Muster', origin: 'classify' });
  saveBooks(api.ws, b);
  const r = await api.send('PATCH', '/api/journal-entries/e-home', { vatCode: 'V0' });
  assert.equal(r.status, 200, String(r.json.error));
  const [q] = questionOn('S-HOME');
  assert.equal(q.status, 'open', 'asked, not answered');
  assert.equal(rules().some((x) => x.id === `sale-${q.id}`), false, 'no export rule guessed');
  const a = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'saleAbroad' });
  const acted = (a.json as unknown as Question).answer?.acted as { booked: string[]; vatCode: string; rule?: string };
  assert.deepEqual([acted.booked, acted.vatCode, acted.rule], [['e-home'], 'V0', undefined]);
  assert.deepEqual(rules(), []);
});

test('«Neu klassifizieren» of a sale without an invoice asks its question at once, as the booking\'s reason says (r4c-36)', async () => {
  const b = loadBooks(api.ws);
  b.transactions.push({ ref: 'S-NEW', bank: 'Raiffeisen', date: '2026-08-22', amount: 300, currency: 'CHF', direction: 'CRDT', description: 'Reparatur', counterparty: 'Neukunde Beispiel GmbH' });
  saveBooks(api.ws, b);
  assert.equal(questionOn('S-NEW').length, 0);
  const r = await api.send('POST', '/api/journal-entries/classify/S-NEW', {});
  assert.equal(r.status, 200, String(r.json.error));
  assert.match(entriesOf('S-NEW')[0].reason ?? '', /Aufgaben/);
  assert.deepEqual(questionOn('S-NEW').map((q) => q.status), ['open']);
});

test('«Rückgängig» on the wish that answered a sale\'s question opens the question again, and the booking records the AI as its author (r5h-35, r5h-31)', async () => {
  const b = loadBooks(api.ws);
  b.transactions.push({ ref: 'S-UNDO', bank: 'Raiffeisen', date: '2026-08-23', amount: 540, currency: 'CHF', direction: 'CRDT', description: 'Malerarbeiten Küche', counterparty: 'Familie Beispiel' });
  b.journalEntries.push({ id: 'e-undo', transactionRef: 'S-UNDO', date: '2026-08-23', accountDebit: '1021', accountCredit: '3400', amount: 540, vatCode: 'V0', description: 'Familie Beispiel, Küche', origin: 'classify' });
  saveBooks(api.ws, b);
  writeFileSync(changes, JSON.stringify([{ kind: 'entry', id: 'e-undo', set: { vatCode: 'V81' } }]));
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'die küche war mit 8.1 % mwst', language: 'de', context: [] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const conversation = (events[0] as { id: string }).id;
  const made = (events.find((e) => e.type === 'changes') as Extract<AssistantEvent, { type: 'changes' }>).changes;
  const [q] = questionOn('S-UNDO');
  assert.equal(q.status, 'answered');
  assert.deepEqual(made[0].answered, [q.id], 'the change knows the question it answered');
  const by = entriesOf('S-UNDO')[0].by;
  assert.deepEqual(by && { ...by, at: '' }, { kind: 'assistant', at: '', conversation, was: { vatCode: 'V0' } }, 'the AI, on her wish, not «von Hand»');

  const undone = await api.send('POST', `/api/assistant/${conversation}/changes/${made[0].id}/undo`);
  assert.equal(undone.status, 200, String(undone.json.error));
  assert.deepEqual(entriesOf('S-UNDO').map((e) => [e.vatCode, e.origin, e.by]), [['V0', 'classify', undefined]]);
  assert.equal(questionOn('S-UNDO')[0].status, 'open', 'the question is open again');

  const r = await api.send('PATCH', '/api/journal-entries/e-undo', { vatCode: 'V81' });
  assert.equal(r.status, 200, String(r.json.error));
  assert.equal(entriesOf('S-UNDO')[0].by?.kind, 'person', 'her own edit afterwards is hers');
});
