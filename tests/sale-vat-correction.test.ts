/**
 * A person's correction of a customer payment without an invoice teaches (MISSION.md «Every
 * correction teaches»): fixed by hand or by a wish, it answers the app's question about the sale
 * (src/server/questions.ts learnFromCorrection) and is kept as a rule for the payer, so «Neu
 * klassifizieren» › «Trotzdem neu buchen» books what she set, not the model's V0. Persona test
 * 2026-10-15 corner-4. On the real API server, the model a stub that answers V0 as the test saw.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const rules = () => (parse(readFileSync(join(api.root, 'knowledge/rules/booking.guide.yaml'), 'utf8')) as { steps: { classify?: { rules?: Array<Record<string, unknown>> } } }).steps.classify?.rules ?? [];
const rebookAnyway = async (ref: string) => {
  const r = await api.send('POST', `/api/journal-entries/classify/${ref}`, { overwrite: true });
  assert.equal(r.status, 200, String(r.json.error));
};

test('a hand correction of a sale nobody asked about yet asks and answers the question, and keeps a rule for the payer', async () => {
  const r = await api.send('PATCH', '/api/journal-entries/e-ch', { vatCode: 'V81' });
  assert.equal(r.status, 200, String(r.json.error));
  const [q] = questionOn('S-CH');
  assert.deepEqual([q.status, q.answer?.by, q.answer?.answer], ['answered', OWNER, { choice: 'saleDomestic' }]);
  assert.deepEqual(q.answer?.acted, { booked: [], undo: [], vatCode: 'V81', correction: true, rule: `sale-${q.id}` });
  assert.deepEqual(rules().find((x) => x.id === `sale-${q.id}`)?.then, { account: '3400', vat: 'V81' });
});

test('«Trotzdem neu buchen» after the correction books her V81 by the rule, not the model\'s V0', async () => {
  await rebookAnyway('S-CH');
  const [e] = entriesOf('S-CH');
  assert.deepEqual([e.vatCode, e.accountCredit, e.rule?.startsWith('sale-')], ['V81', '3400', true]);
});

test('a correction to the abroad code is a «Ausland» answer; the rule keeps the code she set', async () => {
  await runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
  assert.equal(questionOn('S-EU')[0].status, 'open', 'the booking step asked');
  const r = await api.send('PATCH', '/api/journal-entries/e-eu', { vatCode: 'V0-E' });
  assert.equal(r.status, 200, String(r.json.error));
  const [q] = questionOn('S-EU');
  assert.deepEqual([q.status, q.answer?.answer], ['answered', { choice: 'saleAbroad' }]);
  assert.deepEqual(rules().find((x) => x.id === `sale-${q.id}`)?.then, { account: '3400', vat: 'V0-E' });
  await rebookAnyway('S-EU');
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

test('«Zurücknehmen» on an answer from a correction drops the rule and keeps the booking, no longer held by the rule', async () => {
  const [q] = questionOn('S-EU');
  assert.ok(entriesOf('S-EU')[0].rule, 'booked by the rule before');
  const r = await api.send('POST', `/api/questions/${q.id}/undo`, { by: OWNER });
  assert.equal(r.status, 200, String(r.json.error));
  assert.equal(questionOn('S-EU')[0].status, 'open');
  assert.equal(rules().some((x) => x.id === `sale-${q.id}`), false);
  assert.deepEqual(entriesOf('S-EU').map((e) => [e.vatCode, e.rule]), [['V0-E', undefined]]);
});

test('then «mit MWST» books the payment at the normal rate and keeps a rule (r4c-28)', async () => {
  const [q] = questionOn('S-EU');
  const r = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'saleDomestic' });
  assert.equal(r.status, 200, String(r.json.error));
  const acted = (r.json as unknown as Question).answer?.acted as { booked: string[]; vatCode: string; rule?: string };
  assert.deepEqual([acted.booked, acted.vatCode, acted.rule], [entriesOf('S-EU').map((e) => e.id), 'V81', `sale-${q.id}`]);
  assert.equal(acted.booked.length, 1);
  assert.deepEqual(entriesOf('S-EU').map((e) => e.vatCode), ['V81']);
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

test('her V0 on a payer at home is asked back, not taken as «Ausland»; her answer then keeps the rule from her booking (r4c-35)', async () => {
  const b = loadBooks(api.ws);
  b.transactions.push({ ref: 'S-HOME', bank: 'Raiffeisen', date: '2026-08-21', amount: 3274.4, currency: 'CHF', direction: 'CRDT', description: 'Malerarbeiten', counterparty: 'Hans Muster', counterpartyIban: 'CH5604835012345678009' });
  b.journalEntries.push({ id: 'e-home', transactionRef: 'S-HOME', date: '2026-08-21', accountDebit: '1021', accountCredit: '3400', amount: 3274.4, vatCode: 'V81', description: 'Kundenzahlung Hans Muster', origin: 'classify' });
  saveBooks(api.ws, b);
  const r = await api.send('PATCH', '/api/journal-entries/e-home', { vatCode: 'V0' });
  assert.equal(r.status, 200, String(r.json.error));
  const [q] = questionOn('S-HOME');
  assert.equal(q.status, 'open', 'asked, not answered');
  assert.equal(rules().some((x) => x.id === `sale-${q.id}`), false, 'no export rule guessed');
  const a = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'saleAbroad' });
  const acted = (a.json as unknown as Question).answer?.acted as { booked: string[]; vatCode: string; rule?: string };
  assert.deepEqual([acted.booked, acted.vatCode, acted.rule], [['e-home'], 'V0', `sale-${q.id}`]);
  assert.deepEqual(rules().find((x) => x.id === `sale-${q.id}`)?.then, { account: '3400', vat: 'V0' });
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
