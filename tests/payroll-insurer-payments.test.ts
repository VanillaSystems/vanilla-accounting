/**
 * A payment to one of the firm's payroll insurers once payroll runs here (src/payroll/insurers-context.ts,
 * docs/specs/payroll.md §22 decision 45): it needs no receipt (the payslips prove it; its bill still pairs),
 * and the hand form proposes bank / the insurer's liability account, never the expense the payslips booked
 * already. Before payroll runs here (the opening's months) a payment stays level A's. By data: the firm's
 * insurances in payroll.json, matched by business file or name, never a named insurer. Invented firm.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadChart } from '../src/workspace/chart.js';
import { handStart } from '../src/saving/hand-rule.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { loadClassifyContext } from '../src/booking/classify.js';
import { receiptKnowledge, receiptWait, receiptWaitOf, settlementAccount } from '../src/booking/receipt-wait.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadBooks } from '../src/books/store.js';
import { savePayroll } from '../src/payroll/store.js';
import { APP_ROOT, type Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { firm, owner } from './support/payroll.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const pay = (ref: string, date: string, amount: number, counterparty: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description: `Beiträge ${date.slice(0, 7)}` });

/** The firm runs payroll here from October: its owner's opening holds January to September. */
function books(): Workspace {
  const ws = tempWorkspace('payroll-insurer-pay-');
  roots.push(ws.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  savePayroll(ws, firm([owner({ opening: { 2026: { through: '2026-09', bases: { ahv: 90000 } } } })]));
  writeIndex(ws, {
    transactions: [pay('BVG-OCT', '2026-10-15', 600, 'Pensionskasse Beispiel'), pay('BVG-AUG', '2026-08-15', 600, 'Pensionskasse Beispiel'), pay('SHOP', '2026-10-15', 80, 'Papeterie Muster')],
    journalEntries: [], receipts: [], mappings: [], config: { closedThrough: '2026-06-30' } as never,
  });
  return ws;
}

test('the hand form of a payroll insurer\'s payment proposes its liability account without a code; a payment of the opening\'s months does not', () => {
  const ws = books();
  const start = handStart(ws, 'BVG-OCT')!;
  assert.deepEqual(start.nature, { kind: 'payrollInsurer', account: '2275', name: 'Pensionskasse Beispiel' });
  const draft = bookingDraft(loadBooks(ws), 'BVG-OCT', ws.bankAccounts, [], { nature: start.nature! })!;
  assert.deepEqual(draft.lines.map((l) => [l.accountDebit, l.amount, l.vat]), [['2275', 600, '']]);
  assert.deepEqual(draft.notes.map((n) => n.kind), ['payrollInsurer']);
  assert.notEqual(handStart(ws, 'BVG-AUG')!.nature?.kind, 'payrollInsurer', 'August is the opening\'s: level A booked such payments');
  assert.notEqual(handStart(ws, 'SHOP')!.nature?.kind, 'payrollInsurer');
});

test('a payroll insurer\'s payment needs no receipt while payroll runs here; it still pairs with its bill', () => {
  const ws = books();
  const b = loadBooks(ws);
  const context = loadClassifyContext(ws);
  const known = receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws);
  const fx = loadFxResolver();
  const why = (ref: string) => { const w = receiptWaitOf(b, b.transactions.find((t) => t.ref === ref)!, context, known, fx); return w.wait ? 'wait' : w.why; };
  assert.equal(why('BVG-OCT'), 'payrollInsurer');
  assert.equal(why('BVG-AUG'), 'wait', 'before payroll runs here its receipt decides, as before');
  assert.equal(why('SHOP'), 'wait');
  // The decision itself: the fact books it at once, after a business's own rule.
  const ctx = { free: new Set<string>(), assumesUnread: new Set<string>(), wordings: [], ownIbans: new Set<string>(), settles: settlementAccount({ moneyAccounts: new Set(['1020']), ownerAccount: '2850' }), inputTax: true };
  assert.deepEqual(receiptWait(pay('X', '2026-10-15', 1, 'Y'), { linked: 'none', payrollInsurer: true }, ctx), { wait: false, why: 'payrollInsurer' });
});
