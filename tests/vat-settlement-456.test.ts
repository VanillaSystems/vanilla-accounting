/**
 * Review of #456 (PR #467): freeing a business's payments from pairing only where its file says its
 * bills pair (`apply: { receipt: none, pairs: true }`, the compensation fund). The ESTV's and the tax
 * office's notices stay filed apart: never paired with their payment. And whatever is linked or
 * answered, a line on the VAT settlement account (year-end.yaml vatSettlement) carries no VAT code:
 * the ESTV's files say its payments claim no input tax (`apply: { inputTax: none }`), and code drops a
 * code on 2201 the model, a derived VAT-amount code or withPurchaseVat would set.
 */
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks, type Books } from '../src/books/store.js';
import { noReceiptFor, runPairChain } from '../src/intake/pair-chain.js';
import { parseReceiptApply } from '../src/booking/receipt-wait.js';
import type { BankTransaction, Mapping, Receipt } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const ESTV: BankTransaction = { ref: 'ESTV', bank: 'Raiffeisen', date: '2026-08-27', amount: 3912.45, currency: 'CHF', direction: 'DBIT', counterparty: 'Eidg. Steuerverwaltung ESTV', description: 'MWST 2. Quartal 2026 Ref 123.456.789' } as BankTransaction;
const TAXO: BankTransaction = { ref: 'KST', bank: 'Raiffeisen', date: '2026-09-15', amount: 2400, currency: 'CHF', direction: 'DBIT', counterparty: 'Kantonale Steuerverwaltung Zug', description: 'Staats- und Gemeindesteuern 2026 Rate 2 Nr. ST-2026-77812' } as BankTransaction;
/** A VAT return read as a receipt that shows 8.1 %: what must never bring input tax onto the VAT payment. */
const NOTICE: Receipt = { id: 'n', filename: 'estv.pdf', extractedText: 'Eidgenössische Steuerverwaltung ESTV\nMWST-Abrechnung 2. Quartal 2026\nUmsatz zu 8.1% CHF 48300.00\nSteuer 8.1% 3912.45\nZu bezahlen CHF 3912.45\nRef 123.456.789', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-08-20', amount: 3912.45, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 3912.45, gross: 3912.45 }] } as Receipt;
const TAXBILL: Receipt = { id: 't', filename: 'steuer.pdf', extractedText: 'Kantonale Steuerverwaltung Zug\nProvisorische Steuerrechnung 2026 Rate 2\nNr. ST-2026-77812\nDatum: 01.09.2026\nTotal CHF 2400.00', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-09-01', amount: 2400, currency: 'CHF', hasSwissVat: false } as Receipt;

function firm(linked: boolean): Workspace {
  const made = tempWorkspace('vat-settlement-456-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const mappings = (linked ? [{ transactionRef: 'ESTV', receiptId: 'n' }] : []) as Mapping[];
  writeIndex(ws, { transactions: [ESTV], journalEntries: [], receipts: linked ? [NOTICE] : [], mappings, config: { closedThrough: '2026-06-30' } as never });
  return ws;
}

/** The model's answers for the VAT payment: each claims input tax a way it can. */
const ANSWERS: Record<string, (amount: number) => unknown[]> = {
  'a zero code (I0)': (amount) => [{ accountDebit: '2201', accountCredit: '', amount, vatCode: 'I0' }],
  'a rate code (I81)': (amount) => [{ accountDebit: '2201', accountCredit: '', amount, vatCode: 'I81' }],
  '«charged» at 8.1 %': (amount) => [{ accountDebit: '2201', accountCredit: '', amount, vat: 'charged', vatRate: 8.1 }],
  '«charged» at 8.1 %, the amount is the tax': (amount) => [{ accountDebit: '2201', accountCredit: '', amount, vat: 'charged', vatRate: 8.1, amountIs: 'tax' }],
};

for (const linked of [true, false]) {
  for (const [name, answer] of Object.entries(ANSWERS)) {
    test(`the VAT payment${linked ? ' with the return linked' : ''}, the model answering ${name}: 2201 / the bank, no VAT code`, async () => {
      const ws = firm(linked);
      const books = loadBooks(ws);
      const ask: ClassifyDeps['ask'] = async (prompt) => {
        const out: Record<string, unknown> = {};
        for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
          const ref = part.split(/\s/)[0];
          const amount = Number(/Amount: -?([\d.]+)/.exec(part)![1]);
          out[ref] = { entries: answer(amount).map((e) => ({ description: 'MWST Q2', ...(e as object) })), reason: 'MWST-Zahlung' };
        }
        return JSON.stringify(out);
      };
      await classifyTransactions(books, books.transactions, { ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
      assert.deepEqual(books.journalEntries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']), [['2201', '1020', 3912.45, '']]);
    });
  }
}

test('the ESTV\'s return and the tax office\'s bill stay filed apart: never paired with their payment; the fund\'s file alone says its bills pair', async () => {
  const ws = firm(false);
  const b = { receipts: [structuredClone(NOTICE), structuredClone(TAXBILL)], transactions: [structuredClone(ESTV), structuredClone(TAXO)], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const port = { read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) };
  await runPairChain(port, { toChf: (a) => a, firm: { name: 'Kälin Advisory GmbH', owner: 'Matthias Kälin' }, noReceipt: noReceiptFor(ws) });
  assert.deepEqual(b.mappings, []);
  assert.deepEqual(parseReceiptApply({ receipt: 'none', pairs: true }), { ok: true, pairs: true });
  assert.match((parseReceiptApply({ receipt: 'none', pairs: 'yes' }) as { problem: string }).problem, /apply\.pairs must be true/);
  assert.match((parseReceiptApply({ receipt: 'none', text: 'Bancomat', pairs: true }, 'guide') as { problem: string }).problem, /apply\.pairs is unknown/);
});
