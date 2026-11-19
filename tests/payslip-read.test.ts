/**
 * docs/specs/payroll.md §10.2 A1, A2: a payslip another program or a fiduciary issued, recognised and read by code.
 * readPayslip reads the gross, the net, the deductions per kind (built on payslipDeductions), the family allowances and
 * the expenses, laid out as pdftotext reads them; it reads only when gross − deductions + allowances + expenses is the
 * net to the cent. payslipOf takes only a text the firm issued and titles a payslip. The texts are the consultancy and
 * webshop personas' (tests/withheld-fund-476.test.ts) and a payroll program's; invented people only.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payslipOf, readPayslip, wageLines, type PayslipRead } from '../src/booking/payslip.js';

const flat = (r: PayslipRead | undefined) => r && { ...r, deductions: Object.fromEntries(r.deductions), expenses: Object.fromEntries(r.expenses) };

const CONSULTING = (month: string, day = '25') => `Kälin Advisory GmbH\nBaarerstrasse 41, 6300 Zug\nLohnabrechnung ${month} 2026\nMatthias Kälin, Geschäftsführer\n\nBruttolohn\nAHV/IV/EO 5.3%\nALV 1.1%\nPensionskasse (BVG), Arbeitnehmerbeitrag\nNettolohn, Auszahlung am ${day}. ${month}\nDie Arbeitgeberbeiträge stehen in der Akontorechnung der Ausgleichskasse Zug und in der Beitragsrechnung der Vorsorgestiftung Zentralschweiz.\n\n9500.00\n-503.50\n-104.50\n-290.00\n8602.00`;
const SSN = ['756', '1234', '5678', '97'].join('.');
const PROGRAM = `Muster Malerei GmbH\nLohnabrechnung März 2026\nSandra Muster\nAHV-Nr. ${SSN}\nAHV-pflichtiger Lohn 8'000.00\nBruttolohn 8'000.00\nAHV/IV/EO 5.30% 8'000.00 -424.00\nALV 1.10% 8'000.00 -88.00\nNBU/KTG -136.00\nBVG -350.00\nQuellensteuer A0N 10.5% -840.00\nNettolohn 6'162.00`;

test('A2 the consultancy\'s payslip as pdftotext reads it: all labels, then all amounts in their order', () => {
  assert.deepEqual(flat(readPayslip(CONSULTING('Juli'))), { employee: 'Matthias Kälin', period: '2026-07', gross: 9500, net: 8602, deductions: { ausgleichskasse: 608, pension: 290 }, allowances: 0, expenses: {} });
});

test('A2 each label with its amount on its line, or on the line below it', () => {
  const inline = "Teegarten Wyss GmbH\nLohnabrechnung August 2026\nCorinne Wyss, Geschäftsführerin\nBruttolohn 4'700.00\nAHV/IV/EO 5.3% -249.10\nALV 1.1% -51.70\nPensionskasse (BVG), Arbeitnehmerbeitrag -199.20\nNettolohn, Auszahlung am 25. August 4'200.00";
  const below = 'Teegarten Wyss GmbH\nLohnabrechnung 08/2026\nBruttolohn\n4700.00\nAHV/IV/EO 5.3%\n-249.10\nALV 1.1%\n-51.70\nPensionskasse (BVG), Arbeitnehmerbeitrag\n-199.20\nNettolohn, Auszahlung am 25. August\n4200.00\nDie Arbeitgeberbeiträge stehen in der Akontorechnung der Ausgleichskasse Luzern.';
  for (const text of [inline, below]) {
    const r = readPayslip(text)!;
    assert.deepEqual([r.period, r.gross, r.net, Object.fromEntries(r.deductions)], ['2026-08', 4700, 4200, { ausgleichskasse: 300.8, pension: 199.2 }]);
  }
});

test('A2 a payroll program\'s payslip: bases and the social security number are no rows, the withholding tax a kind of its own', () => {
  assert.deepEqual(flat(readPayslip(PROGRAM)), { employee: 'Sandra Muster', period: '2026-03', gross: 8000, net: 6162, deductions: { ausgleichskasse: 512, 'accident+sickness': 136, pension: 350, tax: 840 }, allowances: 0, expenses: {} });
});

test('A2 family allowances and expenses paid with the wage count towards the net; the flat expenses on their own account', () => {
  const text = "Conteggio salario 09/2026\nSalario lordo 6'000.00\nAVS/AI/IPG 5.30% -318.00\nAD 1.10% -66.00\nLPP -250.00\nAINF 1.00% -60.00\nIGM -20.00\nAssegni familiari 215.00\nSpese forfettarie 100.00\nRimborso spese 42.50\nSalario netto 5'643.50";
  assert.deepEqual(flat(readPayslip(text)), { period: '2026-09', gross: 6000, net: 5643.5, deductions: { ausgleichskasse: 384, pension: 250, accident: 60, sickness: 20 }, allowances: 215, expenses: { 5830: 100, 5820: 42.5 } });
});

test('A2 sure only to the cent: a net off by a cent, a deduction of no kind, two gross figures read nothing', () => {
  assert.equal(readPayslip(CONSULTING('Juli').replace('8602.00', '8602.01')), undefined);
  assert.equal(readPayslip("Lohnabrechnung\nBruttolohn 6'000.00\nAHV/IV/EO 5.3% -318.00\nAbzug Diverses -50.00\nNettolohn 5'632.00"), undefined, 'a deduction of no known kind: the net does not add up');
  assert.equal(readPayslip("Lohnabrechnung\nBruttolohn 6'000.00\nBruttolohn 6'100.00\nAHV/IV/EO 5.3% -318.00\nNettolohn 5'682.00"), undefined);
  assert.equal(readPayslip('Rechnung 2026-01\nTotal 120.00'), undefined, 'an invoice is no payslip');
});

test('A3 the lines: the wage less its deductions against the bank, each deduction account\'s share, the withholding tax on its own account', () => {
  const lines = wageLines([{ receipt: 'p', read: readPayslip(PROGRAM)! }])!;
  assert.deepEqual(lines.map((l) => [l.debit, l.credit, l.amount, l.what]), [['5000', '', 6162, 'net'], ['5000', '2270', 998, 'deductions'], ['5000', '2279', 840, 'deductions']]);
});

test('A1 a payslip only when the firm issued it and its first lines title it one', () => {
  assert.ok(payslipOf(CONSULTING('Juli'), { name: 'Kälin Advisory GmbH', uid: 'CHE-111.222.333' }), 'the firm\'s name in the letterhead: a payslip prints no VAT number');
  assert.equal(payslipOf(CONSULTING('Juli'), { name: 'Muster Consulting GmbH' }), undefined, 'another firm\'s payslip');
  assert.equal(payslipOf(CONSULTING('Juli').replace('Lohnabrechnung', 'Abrechnung'), { name: 'Kälin Advisory GmbH' }), undefined, 'no payslip title');
  assert.equal(payslipOf(CONSULTING('Juli').replace('8602.00', '8600.00'), { name: 'Kälin Advisory GmbH' }), undefined, 'a payslip that does not read is a receipt like any other');
});
