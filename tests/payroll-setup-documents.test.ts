/**
 * docs/specs/payroll.md §6.1 step 2, §8.1: the Sozialversicherungen set up from the funds' documents. Code reads what a
 * document states plainly, the AI only the rest, from lines without a salary or a birth date; a card proposes, and only
 * «Übernehmen» writes, as the forms do, each entry naming the document. Invented funds and people only.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ch, firm, owner } from './support/payroll.js';
import { linesForModel, parseSetupAnswer, readSetupDocument, setupCards, setupPrompt, withModel } from '../src/payroll/setup-documents.js';
import { keepSetupCard } from '../src/payroll/settings.js';
import { emptyPayroll } from '../src/payroll/store.js';
import type { Receipt } from '../src/types/index.js';

const data = ch.payroll!;
const SSN = ['756', '1234', '5678', '97'].join('.');
const DECISION = `Ausgleichskasse Beispiel\nBahnhofstrasse 1, 6300 Zug\nBeitragsverfügung 2026\nAbrechnungsnummer: 100.2345\nVerwaltungskosten 2.5 % der AHV/IV/EO-Beiträge\nFamilienausgleichskasse FAK 1.6 %\nAkontobeiträge auf der Lohnsumme CHF 120'000.00`;
const POLICY = 'Unfallversicherung Beispiel AG\nUVG-Police 2026\nPolicennummer: UV-55.123\nBerufsunfall BU 0.120 %\nNichtberufsunfall NBU 1.350 %';
const CERT = `Vorsorgestiftung Beispiel\nVorsorgeausweis per 1.1.2026\nVertragsnummer: V-77\nVersicherte Person: Mila Beispiel\nGeburtsdatum 12.05.1980\nAHV-Nr. ${SSN}\nVersicherter Lohn CHF 92'000.00\nBeitrag Arbeitnehmer pro Monat 300.00\nBeitrag Arbeitgeber pro Monat 300.00`;

test('§6.1 code reads a compensation fund\'s decision: the fund, its number, the administration cost, and the family allowances beside it', () => {
  const [ahv, fak] = readSetupDocument(DECISION, data);
  assert.deepEqual([ahv.kind, ahv.name, ahv.memberNumber, ahv.rates], ['ahv', 'Ausgleichskasse Beispiel', '100.2345', { adminCost: 2.5 }]);
  assert.deepEqual([fak.kind, fak.rates], ['fak', { employer: 1.6 }]);
  assert.equal(ahv.by['rates.adminCost'], 'code');
});

test('§6.1 an accident policy: its contract number and both premiums, each on its own line', () => {
  const [uvg] = readSetupDocument(POLICY, data);
  assert.deepEqual([uvg.kind, uvg.contractNumber, uvg.rates], ['uvg', 'UV-55.123', { bu: 0.12, nbu: 1.35 }]);
});

test('§6.1 a pension certificate: the model gets no salary, no birth date; the social security number is masked on the way (src/llm/ask.ts)', () => {
  const [bvg] = readSetupDocument(CERT, data);
  assert.deepEqual([bvg.kind, bvg.contractNumber, bvg.person], ['bvg', 'V-77', undefined], 'the person\'s contributions are the AI\'s or the person\'s');
  const lines = linesForModel(CERT, data);
  assert.doesNotMatch(lines, /92'000|Geburtsdatum|12\.05\.1980/);
  assert.match(lines, /Beitrag Arbeitnehmer pro Monat 300\.00/);
  assert.doesNotMatch(setupPrompt(CERT, ['bvg'], data), /92'000/);
});

test('§6.1 the AI\'s answer is checked by code: known kinds and rate keys within their ranges; code\'s reading stands, the AI fills the rest', () => {
  const ai = parseSetupAnswer('{"items":[{"kind":"bvg","name":"Vorsorgestiftung Beispiel","person":{"name":"Mila Beispiel","employee":300,"employer":300}},{"kind":"ahv","rates":{"adminCost":9}},{"kind":"lottery"}]}', ['bvg', 'ahv'], data);
  assert.deepEqual(ai.map((p) => [p.kind, p.rates, p.person?.employee]), [['bvg', {}, 300], ['ahv', {}, undefined]], 'a rate outside its range is no reading');
  const merged = withModel(readSetupDocument(CERT, data), ai);
  assert.deepEqual([merged[0].contractNumber, merged[0].by.contractNumber, merged[0].person?.name, merged[0].by.person], ['V-77', 'code', 'Mila Beispiel', 'ai']);
});

test('§6.1 a card until it is kept: keeping writes the insurance and the person\'s contributions, each naming the document; then the card goes', () => {
  const store = firm([owner()]);
  store.insurances = store.insurances.filter((i) => i.kind !== 'bvg' && i.kind !== 'ahv');
  const receipts = [{ id: 'cert', filename: 'vorsorgeausweis.pdf', date: '2026-01-05', extractedText: CERT }, { id: 'dec', filename: 'verfuegung.pdf', date: '2026-01-10', extractedText: DECISION }, { id: 'bill', filename: 'r.pdf', extractedText: 'Rechnung 1\nTotal 10.00' }] as Receipt[];
  assert.deepEqual(setupCards(receipts, store, data, {}).map((c) => c.receipt), ['dec', 'cert'], 'newest first; an invoice proposes nothing');
  let n = 0;
  const kept = keepSetupCard(store, data, 'cert', [{ kind: 'bvg', name: 'Vorsorgestiftung Beispiel', contractNumber: 'V-77', validFrom: '2026-01-01', person: { name: 'Mila Beispiel', employee: 310, employer: 320 } }], () => `in${n++}`, '2026-01-06T00:00:00.000Z');
  assert.deepEqual(kept.persons, []);
  const ins = store.insurances.find((i) => i.kind === 'bvg')!;
  assert.deepEqual([ins.name, ins.contractNumber, ins.source?.receiptId], ['Vorsorgestiftung Beispiel', 'V-77', 'cert']);
  const entry = store.employees[0].insurances.at(-1)!;
  assert.deepEqual([entry.value.bvg, entry.source?.receiptId], [{ insurance: ins.id, employee: 310, employer: 320 }, 'cert']);
  assert.deepEqual(setupCards(receipts, store, data, {}).map((c) => c.receipt), ['dec']);
  keepSetupCard(store, data, 'dec', [{ kind: 'ahv', name: 'Ausgleichskasse Beispiel', memberNumber: '100.2345', code: 'A', rates: { adminCost: 2.5 }, validFrom: '2026-01-01' }, { kind: 'fak', code: 'A', rates: { employer: 1.6 }, validFrom: '2026-01-01' }], () => `in${n++}`, '2026-01-11T00:00:00.000Z');
  const fak = store.insurances.find((i) => i.kind === 'fak')!;
  assert.deepEqual(fak.solutions[0].rates.at(-1)!.value, { employer: 1.6 }, 'the firm\'s FAK gets the rate as a dated entry');
  assert.equal(fak.solutions[0].rates.at(-1)!.source?.receiptId, 'dec');
  assert.deepEqual(setupCards(receipts, store, data, {}), []);
});

test('§6.1 nothing without the person: an empty payroll.json stays empty while cards are shown; a person the certificate names that payroll.json lacks is said', () => {
  const store = emptyPayroll();
  const cards = setupCards([{ id: 'p', filename: 'p.pdf', extractedText: POLICY } as Receipt], store, data, {});
  assert.equal(cards.length, 1);
  assert.equal(store.insurances.length, 0);
  const kept = keepSetupCard(store, data, 'x', [{ kind: 'bvg', name: 'Vorsorgestiftung Beispiel', validFrom: '2026-01-01', person: { name: 'Nina Muster', employee: 1, employer: 1 } }], () => 'in9', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(kept.persons, ['Nina Muster']);
});

test('§6.1 routes: the cards from Belege, «Übernehmen» writes payroll.json naming the document, «Nicht verwenden» hides one; without a model nothing is read', async () => {
  const { startApi } = await import('./support/api-server.js');
  const { loadBooks, saveBooks, update, PERSON } = await import('../src/books/store.js');
  const { loadPayroll, savePayroll } = await import('../src/payroll/store.js');
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const store = firm([owner()]);
    store.insurances = store.insurances.filter((i) => i.kind !== 'uvg');
    savePayroll(api.ws, store);
    const books = loadBooks(api.ws);
    update(books, PERSON, (b) => {
      b.receipts.push({ id: 'pol', filename: 'uvg-police.pdf', date: '2026-01-04', extractedText: POLICY, location: 'archived', indexedAt: '', fileSize: 1, extractionMethod: 'pdftotext' } as unknown as Receipt);
      b.receipts.push({ id: 'cert', filename: 'ausweis.pdf', date: '2026-01-05', extractedText: CERT, location: 'archived', indexedAt: '', fileSize: 1, extractionMethod: 'pdftotext' } as unknown as Receipt);
    });
    saveBooks(api.ws, books);
    const cards = await api.send('GET', '/api/payroll/setup-cards');
    assert.deepEqual((cards.json.cards as Array<{ receipt: string }>).map((c) => c.receipt), ['cert', 'pol']);
    assert.ok(!JSON.stringify(cards.json).includes(SSN), 'the card carries no social security number');
    const keep = await api.send('POST', '/api/payroll/setup-cards/pol/keep', { items: [{ kind: 'uvg', name: 'Unfallversicherung Beispiel AG', contractNumber: 'UV-55.123', code: 'A1', rates: { bu: 0.12, nbu: 1.35 }, validFrom: '2026-01-01' }] });
    assert.equal(keep.json.saved, true);
    const uvg = loadPayroll(api.ws).insurances.find((i) => i.kind === 'uvg')!;
    assert.deepEqual([uvg.contractNumber, uvg.solutions[0].rates[0].value, uvg.solutions[0].rates[0].source?.receiptId], ['UV-55.123', { bu: 0.12, nbu: 1.35 }, 'pol']);
    const read = await api.send('POST', '/api/payroll/setup-cards/cert/read');
    assert.notEqual(read.status, 200, 'no model: nothing read');
    await api.send('POST', '/api/payroll/setup-cards/cert/dismiss');
    assert.deepEqual((await api.send('GET', '/api/payroll/setup-cards')).json.cards, []);
  } finally { await api.stop(); }
});
