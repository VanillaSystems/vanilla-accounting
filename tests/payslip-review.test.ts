/**
 * The review of A-2 (docs/specs/payroll.md §22 decisions 65–71): the withholding tax's payment matched against whole months,
 * never a commission invented from the next month's tax; a payslip never paired a month off; nothing of a payslip, read or
 * not, in a prompt; no salary, birth date or bare amount in a setup document's lines for a model; a collector's payment
 * at the year's start, or on thin evidence, left to the person; a wage a person booked never rebooked. Invented people only.
 */
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { textPdf } from './support/text-pdf.js';
import { cleanUp, drop, firm, linesOf, pay, run, sum } from './support/payslip-firm.js';
import { writeIndex } from './support/workspace.js';
import { ch, firm as payrollFirm, owner } from './support/payroll.js';
import { loadBooks } from '../src/books/store.js';
import type { Ask } from '../src/intake/pipeline.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { PAYSLIP_RULE, PAYSLIP_UNREAD_RULE, payslipLinks, readPayslip, wageLines } from '../src/booking/payslip.js';
import { linesForModel, parseSetupAnswer } from '../src/payroll/setup-documents.js';
import { keepSetupCard } from '../src/payroll/settings.js';
import { PayrollRefusal } from '../src/payroll/close.js';

after(cleanUp);

const QFILE = { 'knowledge/authorities/quellensteuer-zug.yaml': 'id: quellensteuer-zug\nname: Quellensteuer Kanton Zug\nmatch:\n  payee: ["Kantonale Steuerverwaltung Zug"]\ncollects: [tax]\n' };
const slipOf = (month: string, name: string, gross: string, tax: string, net: string) => textPdf(['Muster Malerei GmbH', `Lohnabrechnung ${month} 2026`, name, `Bruttolohn ${gross}`, `Quellensteuer A0N -${tax}`, `Nettolohn ${net}`]);

test('1 the canton paid July\'s tax exactly while August\'s is booked already: no commission invented', async () => {
  const ws = firm('Muster Malerei GmbH', [pay('LM-07', '2026-07-25', 7160, 'Sandra Muster', 'Lohn Juli 2026'), pay('LB-08', '2026-08-25', 960, 'Marco Beispiel', 'Lohn August 2026'), pay('QST', '2026-08-28', 840, 'Kantonale Steuerverwaltung Zug', 'Quellensteuer Juli 2026')], QFILE);
  await drop(ws, [['l7.pdf', slipOf('Juli', 'Sandra Muster', "8'000.00", '840.00', "7'160.00")], ['l8.pdf', slipOf('August', 'Marco Beispiel', "1'000.00", '40.00', '960.00')]]);
  await run(ws);
  const tax = linesOf(ws, 'QST');
  assert.deepEqual([sum(tax, '2279'), sum(tax, '6500', 'accountCredit')], [840, 0]);
});

test('1 a real 2 % commission paid after the next wage run is recognised; two months open, paid less 2 %, too', async () => {
  const months = [['07', 'Juli'], ['08', 'August']] as const;
  const wages = months.map(([m, month]) => pay(`LM-${m}`, `2026-${m}-25`, 7160, 'Sandra Muster', `Lohn ${month} 2026`));
  const slips = months.map(([m, month]) => [`l${m}.pdf`, slipOf(month, 'Sandra Muster', "8'000.00", '840.00', "7'160.00")] as [string, Promise<Buffer>]);
  const one = firm('Muster Malerei GmbH', [...wages, pay('QST', '2026-08-28', 823.2, 'Kantonale Steuerverwaltung Zug', 'Quellensteuer Juli 2026')], QFILE);
  await drop(one, slips);
  await run(one);
  assert.deepEqual([sum(linesOf(one, 'QST'), '2279'), sum(linesOf(one, 'QST'), '6500', 'accountCredit')], [840, 16.8], 'July\'s tax, the 2 % kept');
  const two = firm('Muster Malerei GmbH', [...wages, pay('QST', '2026-09-10', 1646.4, 'Kantonale Steuerverwaltung Zug', 'Quellensteuer Juli/August 2026')], QFILE);
  await drop(two, months.map(([m, month]) => [`l${m}.pdf`, slipOf(month, 'Sandra Muster', "8'000.00", '840.00', "7'160.00")] as [string, Promise<Buffer>]));
  await run(two);
  assert.deepEqual([sum(linesOf(two, 'QST'), '2279'), sum(linesOf(two, 'QST'), '6500', 'accountCredit')], [1680, 33.6], 'two months, the 2 % of both');
});

const slip = (id: string, month: string, name: string, net: string): Receipt =>
  ({ id, filename: `${id}.pdf`, location: 'archived', kind: 'payslip', kindBy: 'rule', kindRule: PAYSLIP_RULE, extractedText: `Muster AG\nLohnabrechnung ${month} 2026\n${name}\nBruttolohn ${net}\nNettolohn ${net}` } as unknown as Receipt);
const wage = (ref: string, date: string, amount: number, counterparty: string): BankTransaction => ({ ref, bank: 'B', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description: 'Lohn' });

test('3 a payslip whose own month\'s wage is filed or linked is paired with no other month; the next month\'s payslip takes its own', () => {
  const june = [slip('jun', 'Juni', 'Lea Brunner', '1450.80')];
  const txs = [wage('p6', '2026-06-25', 1450.8, 'Lea Brunner'), wage('p7', '2026-07-25', 1450.8, 'Lea Brunner')];
  const closed = { isClosed: (d: string) => d <= '2026-06-30' };
  assert.deepEqual(payslipLinks({ receipts: june, transactions: txs, mappings: [] }, closed), [], 'June\'s wage is filed: no reach for July\'s');
  const both = payslipLinks({ receipts: [...june, slip('jul', 'Juli', 'Lea Brunner', '1450.80')], transactions: [...txs, wage('p8', '2026-08-25', 1450.8, 'Lea Brunner')], mappings: [] }, closed);
  assert.deepEqual(both.map((l) => [l.receipt, l.payment]), [['jul', 'p7']], 'the cascade stops: July takes July\'s, June nothing, August\'s stays free');
  assert.deepEqual(payslipLinks({ receipts: [slip('jul', 'Juli', 'Lea Brunner', '1450.80')], transactions: [txs[1], wage('p8', '2026-08-25', 1450.8, 'Lea Brunner')], mappings: [{ transactionRef: 'p7', receiptId: 'other' }] }, { isClosed: () => false }), [], 'July\'s wage linked to another receipt: not August\'s');
  assert.deepEqual(payslipLinks({ receipts: [slip('jul', 'Juli', 'Lea Brunner', '1450.80')], transactions: [{ ...wage('x', '2026-07-25', 1450.8, 'Muster AG'), description: 'Miete' }], mappings: [] }, { isClosed: () => false }), [], 'the firm\'s own name in the letterhead names no person');
});

test('2 a setup document\'s lines for a model: no salary, coordinated wage, savings, birth date, civil status or bare amount, in de/fr/it', () => {
  const data = ch.payroll!;
  const cert = ['Pensionskasse Zentral', 'Vorsorgeausweis per 01.01.2026', 'Corinne Wyss', 'Geb.-Datum 12.03.1985', 'geboren am 12.03.1985', 'Vertragsnummer 12345', "Bruttolohn 85'000.00", 'Gemeldeter Jahreslohn', "85'000.00", 'Versicherter Lohn', "59'275.00", "Koordinierter Jahresverdienst 59'275.00", "Jahresgehalt 85'000.00", "Monatslohn 6'538.45", "Altersguthaben 123'456.00", 'Sparbeitrag Arbeitnehmer 300.00', 'Sparbeitrag Arbeitgeber 300.00', 'Zivilstand verheiratet',
    'Salaire annuel annoncé 85000.00', 'Revenu assuré 59275.00', 'Date de naissance 12.03.1985', 'Avoir de vieillesse 123456.00', 'Cotisation employé 300.00', 'Salario annuo 85000.00', 'Data di nascita 12.03.1985', 'Contributo dipendente 300.00'].join('\n');
  const sent = linesForModel(cert, data);
  for (const leak of ['85', '59', '123\'456', '123456', '6\'538', '1985', 'verheiratet', 'Corinne']) assert.ok(!sent.includes(leak), `${leak} is not sent`);
  assert.deepEqual(sent.split('\n'), ['Pensionskasse Zentral', 'Vertragsnummer 12345', 'Sparbeitrag Arbeitnehmer 300.00', 'Sparbeitrag Arbeitgeber 300.00', 'Cotisation employé 300.00', 'Contributo dipendente 300.00']);
});

test('4 nothing of a payslip reaches a prompt: one read and booked, one code cannot read (filed for the person), one linked by hand', async () => {
  const prompts: string[] = [];
  const ask: Ask = async (prompt) => { prompts.push(prompt); return '{}'; };
  const ws = firm('Muster Malerei GmbH', [pay('LM-07', '2026-07-25', 7488, 'Sandra Muster', 'Lohn Juli 2026'), pay('LB-07', '2026-07-25', 3100, 'Marco Beispiel', 'Lohn Juli 2026')]);
  await drop(ws, [
    // A program that prints its deductions without a minus: read, the net proves it.
    ['sandra.pdf', textPdf(['Muster Malerei GmbH', 'Lohnabrechnung Juli 2026', 'Sandra Muster', 'Geburtsdatum 01.02.1990', "Bruttolohn 8'000.00", 'AHV/IV/EO 5.30% 424.00', 'ALV 1.10% 88.00', "Nettolohn 7'488.00"])],
    // A deduction of no known kind: titled and the firm's, but it does not read.
    ['marco.pdf', textPdf(['Muster Malerei GmbH', 'Lohnabrechnung Juli 2026', 'Marco Beispiel', 'Geburtsdatum 03.04.1991', "Bruttolohn 3'500.00", 'Abzug Diverses -400.00', "Nettolohn 3'100.00"])],
  ]);
  await run(ws, ask);
  const books = loadBooks(ws);
  const kinds = books.receipts.map((r) => [r.kindRule, r.location]).sort();
  assert.deepEqual(kinds, [[PAYSLIP_RULE, 'archived'], [PAYSLIP_UNREAD_RULE, 'archived']]);
  assert.deepEqual([sum(linesOf(ws, 'LM-07'), '5000'), sum(linesOf(ws, 'LM-07'), '2270', 'accountCredit')], [8000, 512], 'positive deductions read');
  assert.equal(linesOf(ws, 'LB-07').length, 0, 'the unread one is the person\'s');
  // She links it by hand: the payment still goes to no model.
  const unread = books.receipts.find((r) => r.kindRule === PAYSLIP_UNREAD_RULE)!;
  writeIndex(ws, { ...books, mappings: [...books.mappings, { transactionRef: 'LB-07', receiptId: unread.id, by: 'human' }] } as never);
  await run(ws, ask);
  assert.equal(linesOf(ws, 'LB-07').length, 0);
  // The bank lines name the people (the model may book a wage without a payslip); the payslips' own figures never reach it.
  for (const p of prompts) for (const leak of ['8\'000', '3\'500', '1990', '1991', 'Geburtsdatum', 'Abzug Diverses', 'Lohnabrechnung']) assert.ok(!p.includes(leak), `no prompt carries ${leak}`);
});

test('6 a collector\'s payment at the year\'s start while the year before has books and no opening: the person\'s', async () => {
  const ws = firm('Muster Malerei GmbH', [pay('LM-01', '2026-01-25', 7160, 'Sandra Muster', 'Lohn Januar 2026'), pay('QST', '2026-01-28', 840, 'Kantonale Steuerverwaltung Zug', 'Quellensteuer Dezember 2025')], QFILE);
  const books = loadBooks(ws);
  writeIndex(ws, { ...books, journalEntries: [{ id: 'old', transactionRef: 'M2025-1', date: '2025-12-25', accountDebit: '5000', accountCredit: '2279', amount: 840, description: 'Dezember', origin: 'manual' }], config: { closedThrough: '2025-12-31' } } as never);
  await drop(ws, [['l1.pdf', slipOf('Januar', 'Sandra Muster', "8'000.00", '840.00', "7'160.00")]]);
  await run(ws);
  assert.equal(sum(linesOf(ws, 'LM-01'), '2279', 'accountCredit'), 840, 'the wage is booked');
  assert.equal(linesOf(ws, 'QST').length, 0, 'December\'s tax is not January\'s: left to the person');
});

test('7 a wage a person booked by hand is not booked again when its payslip comes', async () => {
  const ws = firm('Muster Malerei GmbH', [pay('LM-07', '2026-07-25', 7160, 'Sandra Muster', 'Lohn Juli 2026')]);
  await run(ws);
  const b = loadBooks(ws);
  writeIndex(ws, { ...b, journalEntries: [{ id: 'hand1', transactionRef: 'LM-07', date: '2026-07-25', accountDebit: '5000', accountCredit: '1020', amount: 7160, description: 'Lohn von Hand', origin: 'manual', by: { kind: 'person', at: '2026-08-01T00:00:00Z' } }] } as never);
  await drop(ws, [['l7.pdf', slipOf('Juli', 'Sandra Muster', "8'000.00", '840.00', "7'160.00")]]);
  await run(ws);
  assert.deepEqual(linesOf(ws, 'LM-07').map((e) => [e.id, e.origin]), [['hand1', 'manual']]);
});

test('odd payslips read nothing or what they say; a net at or below nothing books no wage', () => {
  for (const t of ['', '\n\n', 'Lohnabrechnung', 'Bruttolohn 0.00\nNettolohn 0.00', 'Bruttolohn\nNettolohn\n100.00', 'x'.repeat(200000)]) assert.equal(readPayslip(t), undefined, JSON.stringify(t.slice(0, 20)));
  const allowances = readPayslip("Lohnabrechnung Juli 2026\nBruttolohn 1'000.00\nBVG -1'200.00\nKinderzulage 400.00\nNettolohn 200.00")!;
  assert.equal(wageLines([{ receipt: 'r', read: allowances }]), undefined, 'the wage less its deductions is below nothing');
  assert.equal(readPayslip("Lohnabrechnung Juli 2026\nBruttolohn EUR 4'000.00\nAHV/IV/EO 5.3% -212.00\nNettolohn EUR 3'788.00")!.currency, 'EUR');
});

test('the AI\'s answer and a kept card: items that are no object are left out; a blank contribution stays as it was, a name is needed', () => {
  assert.deepEqual(parseSetupAnswer('{"items":[null, 3, {"kind":"bvg"}]}', ['bvg'], ch.payroll!).map((p) => p.kind), ['bvg']);
  assert.deepEqual(parseSetupAnswer('null', ['bvg'], ch.payroll!), []);
  const store = payrollFirm([owner()]);
  const kept = keepSetupCard(store, ch.payroll!, 'cert', [{ kind: 'bvg', validFrom: '2026-01-01', person: { name: 'Mila Beispiel', employee: 310 } }], () => 'inX', '2026-01-06T00:00:00.000Z');
  assert.deepEqual(kept.persons, [], 'her employer contribution stays as her entry says');
  assert.deepEqual(store.employees[0].insurances.at(-1)!.value.bvg, { insurance: 'pk', employee: 310, employer: 300 });
  const none = payrollFirm([owner({ insurances: [] })]);
  assert.deepEqual(keepSetupCard(none, ch.payroll!, 'cert', [{ kind: 'bvg', validFrom: '2026-01-01', person: { name: 'Mila Beispiel', employee: 310 } }], () => 'inY', '2026-01-06T00:00:00.000Z').persons, ['Mila Beispiel'], 'no employer contribution anywhere: her part is not taken');
  assert.throws(() => keepSetupCard(store, ch.payroll!, 'cert', [{ kind: 'bvg', validFrom: '2026-01-01', person: { employee: 1 } as never }], () => 'inZ', '2026-01-06T00:00:00.000Z'), (e) => e instanceof PayrollRefusal);
});
