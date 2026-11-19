/**
 * The third persona walk (docs/specs/payroll.md §22 decision 108): a fund's decision, a policy and a pension certificate
 * dropped into Belege are documents no payment belongs to (kind `supporting`, kindRule `document:payroll-setup`), never a
 * receipt «wartet auf dich: Datum, Betrag fehlt», never shown to a model, and still each a card in Löhne › Einstellungen;
 * a fund's bill stays a receipt. Contributions typed on a pension certificate's card without a person are refused with
 * the field `person`, never dropped. Invented firm and people.
 */
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import type { Ask } from '../src/intake/pipeline.js';
import { cleanUp, drop, firm, pay, run } from './support/payslip-firm.js';
import { textPdf } from './support/text-pdf.js';
import { SETUP_DOCUMENT_RULE, setupCards } from '../src/payroll/setup-documents.js';
import { keepSetupCard } from '../src/payroll/settings.js';
import { PayrollRefusal } from '../src/payroll/close.js';
import { emptyPayroll } from '../src/payroll/store.js';
import { receiptStateOf, closingGroupOf } from '../src/app/shell/drop-summary.js';
import { isNoReceipt } from '../src/books/discard.js';
import { ch } from './support/payroll.js';
import { documents } from '../src/engines/index.js';

after(cleanUp);

const DECISION = ['Ausgleichskasse Beispiel', 'Bahnhofstrasse 1, 6300 Zug', 'Beitragsverfügung 2026', 'Abrechnungsnummer: 100.2345', 'Verwaltungskosten 2.5 % der AHV/IV/EO-Beiträge', 'Familienausgleichskasse FAK 1.6 %', "Akontobeiträge auf der Lohnsumme CHF 120'000.00", 'Datum: 05.01.2026'];
const POLICY = ['Unfallversicherung Beispiel AG', 'UVG-Police 2026', 'Policennummer: UV-55.123', 'Berufsunfall BU 0.120 %', 'Nichtberufsunfall NBU 1.350 %', 'Prämie pro Jahr CHF 1\'770.00'];
const CERT = ['Vorsorgestiftung Beispiel', 'Vorsorgeausweis per 1.1.2026', 'Vertragsnummer: V-77', 'Versicherte Person: Mila Beispiel', 'Geburtsdatum 12.05.1980', "Versicherter Lohn CHF 92'000.00", 'Beitrag Arbeitnehmer pro Monat 300.00', 'Beitrag Arbeitgeber pro Monat 300.00'];
// The fund's bill names the certificate further down: its title comes first, so it stays a receipt.
const BILL = ['Vorsorgestiftung Beispiel', 'Beitragsrechnung Q3 2026 PK-26-3-1180', 'Datum: 01.07.2026', 'Teegarten Wyss GmbH', 'Beiträge gemäss Vorsorgeausweis 2026', "Total CHF 1'800.00", 'Zahlbar bis 31.07.2026', 'IBAN CH93 0076 2011 6238 5295 7'];

test('walk 3 / decision 108: a fund\'s decision, a policy, a pension certificate are documents without a payment, cards in Löhne; never in a prompt; the fund\'s bill stays a receipt', async () => {
  const prompts: string[] = [];
  const ask: Ask = async (prompt) => { prompts.push(prompt); return '{}'; };
  const ws = firm('Teegarten Wyss GmbH', [pay('PK', '2026-07-10', 1800, 'Vorsorgestiftung Beispiel', 'Beiträge Q3 2026 PK-26-3-1180')]);
  await drop(ws, [['Beitragsverfuegung_2026.pdf', textPdf(DECISION)], ['UVG_Police_2026.pdf', textPdf(POLICY)], ['Vorsorgeausweis_Beispiel_2026.pdf', textPdf(CERT)], ['Beitragsrechnung_Q3.pdf', textPdf(BILL)]]);
  await run(ws, ask);
  const books = loadBooks(ws);
  const setup = books.receipts.filter((r) => r.kindRule === SETUP_DOCUMENT_RULE);
  assert.equal(setup.length, 3, 'the decision, the policy and the certificate');
  for (const r of setup) {
    assert.equal(r.kind, 'supporting');
    assert.ok(isNoReceipt(r, 0), 'no receipt of a payment: never «Braucht dich»');
    assert.equal(receiptStateOf(r, 0, false), 'supporting', 'never «wartet auf dich: Datum, Betrag fehlt»');
  }
  const bill = books.receipts.find((r) => r.kindRule !== SETUP_DOCUMENT_RULE && /Beitragsrechnung/.test(r.extractedText ?? ''));
  assert.ok(bill && bill.kind !== 'supporting', 'the fund\'s bill is a receipt to pay');
  assert.ok(prompts.every((p) => !p.includes('Mila') && !p.includes('92\'000') && !p.includes('Vorsorgeausweis per')), 'nothing of the funds\' documents reached a prompt');
  assert.deepEqual(setupCards(books.receipts, emptyPayroll(), ch.payroll!, {}, documents().receipt.title).map((c) => c.items[0].kind).sort(), ['ahv', 'bvg', 'uvg'], 'each still a card in Löhne › Einstellungen');
  assert.equal(closingGroupOf({ state: 'taken' } as Parameters<typeof closingGroupOf>[0], { kind: 'payrollSetup' }), 'payrollSetup', 'the drop says it apart');
});

test('walk 3 / decision 108: contributions typed on a pension certificate\'s card without a person are refused with «Person wählen», never dropped', () => {
  const store = emptyPayroll();
  let n = 0;
  const keep = (person: { name: string; employee?: number; employer?: number }) => keepSetupCard(store, ch.payroll!, 'cert', [{ kind: 'bvg', name: 'Vorsorgestiftung Beispiel', validFrom: '2026-01-01', person }], () => `in${n++}`, '2026-01-06T00:00:00.000Z');
  assert.throws(() => keep({ name: '', employee: 300, employer: 300 }), (e: unknown) => e instanceof PayrollRefusal && e.code === 'badInput' && e.field === 'person' && /Person wählen/.test(e.message));
  assert.throws(() => keep({ name: '  ', employee: 300 }), (e: unknown) => e instanceof PayrollRefusal && e.field === 'person');
});
