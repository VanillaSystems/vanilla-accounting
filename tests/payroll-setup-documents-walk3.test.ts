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
import { loadBooks, moduleActor, PERSON, saveBooks, update } from '../src/books/store.js';
import { classifyInput, loadClassifyContext } from '../src/booking/classify.js';
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
const BILL = ['Vorsorgestiftung Beispiel', 'Beitragsrechnung Q3 2026 PK-26-3-1180', 'Datum: 01.07.2026', 'Teegarten Wyss GmbH', 'Beiträge gemäss Vorsorgeausweis 2026', "Total CHF 1'800.00", 'Zahlbar bis 31.07.2026'];

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
  assert.deepEqual(setupCards(books.receipts, emptyPayroll(), ch.payroll!, {}, documents()).map((c) => c.items[0].kind).sort(), ['ahv', 'bvg', 'uvg'], 'each still a card in Löhne › Einstellungen');
  assert.equal(closingGroupOf({ state: 'taken' } as Parameters<typeof closingGroupOf>[0], { kind: 'payrollSetup' }), 'payrollSetup', 'the drop says it apart');
});

test('walk 3 / decision 108: contributions typed on a pension certificate\'s card without a person are refused with «Person wählen», never dropped', () => {
  const store = emptyPayroll();
  let n = 0;
  const keep = (person: { name: string; employee?: number; employer?: number }) => keepSetupCard(store, ch.payroll!, 'cert', [{ kind: 'bvg', name: 'Vorsorgestiftung Beispiel', validFrom: '2026-01-01', person }], () => `in${n++}`, '2026-01-06T00:00:00.000Z');
  assert.throws(() => keep({ name: '', employee: 300, employer: 300 }), (e: unknown) => e instanceof PayrollRefusal && e.code === 'badInput' && e.field === 'person' && /Person wählen/.test(e.message));
  assert.throws(() => keep({ name: '  ', employee: 300 }), (e: unknown) => e instanceof PayrollRefusal && e.field === 'person');
});

// Bills of funds and insurers that name their product, a policy or a decision before their title (review of walk 3).
const KTG_BILL = ['Beispiel Versicherungen AG', 'Kollektiv-Krankentaggeldversicherung', 'Police Nr. 44.555', 'Prämienrechnung 2026', 'Datum: 01.07.2026', 'Teegarten Wyss GmbH', "Total CHF 1'250.00", 'Zahlbar bis 31.07.2026'];
const UVG_BILL = ['Unfall Beispiel AG', 'Unfallversicherung nach UVG', 'Rechnung Nr. 2026-771', 'Datum: 02.07.2026', "Prämie 2026 Total CHF 1'770.00", 'Zahlbar bis 31.07.2026'];
const AHV_BILL = ['Ausgleichskasse Beispiel', 'Akontobeiträge 3. Quartal 2026', 'Gestützt auf die Beitragsverfügung vom 12.01.2026', 'Rechnung Nr. 5512', 'Datum: 03.07.2026', "Total CHF 2'400.00", 'Zahlbar bis 10.08.2026'];

test('review of walk 3: a fund\'s or insurer\'s bill that names its policy or decision first is a receipt, no card; a certificate linked to a payment never reaches the booking prompt', async () => {
  const prompts: string[] = [];
  const ask: Ask = async (prompt) => { prompts.push(prompt); return '{}'; };
  const ws = firm('Teegarten Wyss GmbH', [pay('P1', '2026-07-23', 600, 'Vorsorgestiftung Beispiel', 'Beitrag Juli')]);
  await drop(ws, [['ktg.pdf', textPdf(KTG_BILL)], ['uvg.pdf', textPdf(UVG_BILL)], ['ahv.pdf', textPdf(AHV_BILL)], ['cert.pdf', textPdf(CERT)]]);
  await run(ws, ask);
  let books = loadBooks(ws);
  const of = (word: string) => books.receipts.find((r) => (r.extractedText ?? '').includes(word))!;
  for (const w of ['Kollektiv-Krankentaggeld', 'Unfallversicherung nach UVG', 'Akontobeiträge 3. Quartal']) assert.notEqual(of(w).kindRule, SETUP_DOCUMENT_RULE, `${w}: a bill`);
  assert.equal(of('Vorsorgeausweis').kindRule, SETUP_DOCUMENT_RULE);
  assert.deepEqual(setupCards(books.receipts, emptyPayroll(), ch.payroll!, {}, documents()).map((c) => c.items[0].kind), ['bvg'], 'the bills are no cards');
  // She links the certificate to the fund's payment: the booking's prompt still never carries it.
  update(books, PERSON, (b) => { b.mappings.push({ transactionRef: 'P1', receiptId: of('Vorsorgeausweis').id, rule: 'manual' } as never); });
  saveBooks(ws, books);
  books = loadBooks(ws);
  const tx = books.transactions.find((t) => t.ref === 'P1')!;
  const input = JSON.stringify(classifyInput(books, tx, [tx], loadClassifyContext(ws).counterparties ?? []));
  assert.ok(!input.includes('Mila') && !input.includes("92'000"), 'no name, no insured wage in the prompt input');
  prompts.length = 0;
  await run(ws, ask);
  assert.ok(prompts.every((p) => !p.includes('Mila') && !p.includes("92'000")), 'nor in any prompt of the next run');
});

test('review of walk 3: a certificate read before code told such documents apart is kinded once, unlinked and in an open period, and no model reads it after', async () => {
  const prompts: string[] = [];
  const ask: Ask = async (prompt) => { prompts.push(prompt); return '{}'; };
  const ws = firm('Teegarten Wyss GmbH', [pay('P1', '2026-07-23', 600, 'Vorsorgestiftung Beispiel', 'Beitrag Juli')]);
  await drop(ws, [['cert.pdf', textPdf([...CERT.slice(0, 1), 'Vorsorgeausweis per 1.7.2026', ...CERT.slice(2)])]]);
  await run(ws);
  // As an earlier version read it: a receipt waiting for its date and amount.
  const books = loadBooks(ws);
  update(books, moduleActor('test'), (b) => { for (const r of b.receipts) { delete r.kind; delete r.kindBy; delete r.kindRule; } });
  saveBooks(ws, books);
  await run(ws, ask);
  const r = loadBooks(ws).receipts.find((x) => (x.extractedText ?? '').includes('Vorsorgeausweis'))!;
  assert.deepEqual([r.kind, r.kindRule], ['supporting', SETUP_DOCUMENT_RULE]);
  assert.ok(prompts.every((p) => !p.includes('Mila') && !p.includes("92'000")), 'no model reads it');
  // Once per receipt: taken back to no kind, the next run leaves it so.
  const again = loadBooks(ws);
  update(again, moduleActor('test'), (b) => { for (const x of b.receipts) { delete x.kind; delete x.kindBy; delete x.kindRule; } });
  saveBooks(ws, again);
  await run(ws);
  assert.equal(loadBooks(ws).receipts.find((x) => x.id === r.id)!.kind, undefined, 'looked at once, never again');
});

test('second review of walk 3: a linked certificate is kinded too (its link stays); a model\'s invoice with its date and amount read is left as it is', async () => {
  const ws = firm('Teegarten Wyss GmbH', [pay('P1', '2026-07-23', 600, 'Vorsorgestiftung Beispiel', 'Beitrag Juli')]);
  await drop(ws, [['a.pdf', textPdf([...CERT.slice(0, 1), 'Vorsorgeausweis per 1.7.2026', ...CERT.slice(2)])], ['b.pdf', textPdf([...CERT.slice(0, 1), 'Vorsorgeausweis per 2.7.2026', ...CERT.slice(2), 'Kopie'])]]);
  await run(ws);
  const books = loadBooks(ws);
  const [a, b] = ['1.7.2026', '2.7.2026'].map((d) => books.receipts.find((x) => (x.extractedText ?? '').includes(`per ${d}`))!.id);
  update(books, PERSON, (x) => {
    for (const r of x.receipts) { delete r.kind; delete r.kindBy; delete r.kindRule; }
    x.mappings.push({ transactionRef: 'P1', receiptId: a, rule: 'manual' } as never);
    Object.assign(x.receipts.find((r) => r.id === b)!, { kind: 'invoice', kindBy: 'model', date: '2026-07-02', amount: 600, currency: 'CHF' });
  });
  saveBooks(ws, books);
  await run(ws);
  const after = loadBooks(ws);
  assert.equal(after.receipts.find((x) => x.id === a)!.kindRule, SETUP_DOCUMENT_RULE);
  assert.ok(after.mappings.some((m) => m.receiptId === a && m.transactionRef === 'P1'), 'the link stays');
  assert.equal(after.receipts.find((x) => x.id === b)!.kind, 'invoice', 'the model\'s invoice stays');
});
