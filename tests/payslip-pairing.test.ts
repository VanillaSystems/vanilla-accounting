/**
 * docs/specs/payroll.md §10.2 A1, A5: a payslip of another program is paired with its wage by code (net to the cent, its
 * person, near its month), one line for a month's payslips pays each; never an app-closed payslip. A business file's
 * `collects` names deduction kinds the jurisdiction knows. Invented people only.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYSLIP_RULE, payslipLinks } from '../src/booking/payslip.js';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';

const slip = (id: string, month: string, name: string, net: string, kindRule = PAYSLIP_RULE): Receipt =>
  ({ id, filename: `${id}.pdf`, location: 'archived', kind: 'payslip', kindBy: 'rule', kindRule, extractedText: `Muster AG\nLohnabrechnung ${month} 2026\n${name}\nBruttolohn ${net}\nNettolohn ${net}` } as unknown as Receipt);
const pay = (ref: string, date: string, amount: number, counterparty: string, description = 'Lohn'): BankTransaction =>
  ({ ref, bank: 'B', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description });
const opts = { isClosed: () => false, wage: (t: BankTransaction) => /^Lohn/.test(t.description) };

test('A1 each payslip with the payment of its net that names its person, nearest its month', () => {
  const receipts = [slip('j', 'Juli', 'Lea Brunner', '1450.80'), slip('a', 'August', 'Lea Brunner', '1450.80')];
  const transactions = [pay('p8', '2026-08-25', 1450.8, 'Lea Brunner'), pay('p7', '2026-07-25', 1450.8, 'Lea Brunner'), pay('x', '2026-07-25', 1450.8, 'Corinne Wyss')];
  assert.deepEqual(payslipLinks({ receipts, transactions, mappings: [] }, opts).map((l) => [l.receipt, l.payment]).sort(), [['a', 'p8'], ['j', 'p7']]);
});

test('A1 one line for all of a month\'s payslips pays each; an app-closed payslip is payroll\'s, never paired here', () => {
  const receipts = [slip('w', 'Juli', 'Corinne Wyss', '4200.00'), slip('b', 'Juli', 'Lea Brunner', '1450.80'), slip('own', 'Juli', 'Mila Beispiel', '100.00', 'payroll')];
  const links = payslipLinks({ receipts, transactions: [pay('all', '2026-07-25', 5650.8, '', 'Lohn Juli 2026'), pay('m', '2026-07-25', 100, 'Mila Beispiel')], mappings: [] }, opts);
  assert.deepEqual(links.map((l) => [l.receipt, l.payment]).sort(), [['b', 'all'], ['w', 'all']]);
});

test('A1 a payment far from the month, of another amount or a person taken apart is no pair', () => {
  const receipts = [{ ...slip('j', 'Juli', 'Lea Brunner', '1450.80'), notPaidBy: ['taken'] } as Receipt];
  const transactions = [pay('late', '2026-10-15', 1450.8, 'Lea Brunner'), pay('cent', '2026-07-25', 1450.81, 'Lea Brunner'), pay('taken', '2026-07-25', 1450.8, 'Lea Brunner')];
  assert.deepEqual(payslipLinks({ receipts, transactions, mappings: [] }, opts), []);
});

test('A5 a business file\'s collects names the jurisdiction\'s deduction kinds', () => {
  const raw = { id: 'pk', name: 'Pensionskasse', match: { payee: ['Pensionskasse'] } };
  assert.deepEqual(compileCounterparty({ ...raw, collects: ['pension'] }, { binding: 'knowledge/authorities/pk.yaml' }, 'authority').collects, ['pension']);
  assert.throws(() => compileCounterparty({ ...raw, collects: ['bvg'] }, { binding: 'knowledge/authorities/pk.yaml' }, 'authority'), /"bvg" is no deduction kind/);
  assert.equal(compileCounterparty(raw, { binding: 'knowledge/authorities/pk.yaml' }, 'authority').collects, undefined);
});
