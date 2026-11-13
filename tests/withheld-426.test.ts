/**
 * #426: wages booked gross put each payslip's deductions on the deductions account (2270); the
 * compensation fund's Akonto bill states its contributions by kind, not by party, so only the books
 * say how much of the payment is the employees' share. The model is told what 2270 holds on the
 * payment's day (src/booking/withheld.ts), without the payment's own lines, never for a wage, a
 * purchase with Swiss VAT or money in, and nothing when wages are booked net.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { withheldFor } from '../src/booking/withheld.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const pay = (ref: string, date: string, amount: number, counterparty: string, description: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount: -amount, currency: 'CHF', direction: 'DBIT', counterparty, description, ...over });
const entry = (ref: string, date: string, debit: string, credit: string, amount: number, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `e-${ref}-${debit}-${credit}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, description: ref, origin: 'classify', by: { kind: 'model', model: 'test' }, ...over }) as JournalEntry;

// The webshop persona: two people, 599.20 deducted a month (owner 500.00 with her pension, helper 99.20), the pension fund paid in advance on 10.07.
const MONTHS = ['07', '08', '09'];
const WAGES = MONTHS.flatMap((m) => [pay(`LO-${m}`, `2026-${m}-24`, 4200, 'Nora Wyss', `Lohn ${m} 2026`), pay(`LH-${m}`, `2026-${m}-24`, 1450.8, 'Lea Brunner', `Lohn ${m} 2026`)]);
const gross = MONTHS.flatMap((m) => [entry(`LO-${m}`, `2026-${m}-24`, '5000', '1020', 4200), entry(`LO-${m}`, `2026-${m}-24`, '5000', '2270', 500), entry(`LH-${m}`, `2026-${m}-24`, '5000', '1020', 1450.8), entry(`LH-${m}`, `2026-${m}-24`, '5000', '2270', 99.2)]);
const PENSION = pay('PK', '2026-07-10', 1195.2, 'Pensionskasse Zentral', 'Beiträge Q3 2026 PK-26-3-1180');
const pension = [entry('PK', '2026-07-10', '2270', '1020', 597.6), entry('PK', '2026-07-10', '5720', '1020', 597.6)];
const AKONTO = pay('AK', '2026-09-28', 2683.5, 'Ausgleichskasse Luzern', 'Akonto AHV/IV/EO/ALV Q3 2026 AK-26-Q3-30871');
const PRINTER = pay('DR', '2026-09-20', 540, 'Druckerei Brun AG', 'Rechnung 2026-118');
const BILL: Receipt = { id: 'ak', filename: 'ak.pdf', extractedText: 'Ausgleichskasse Luzern\nAkontorechnung AK-26-Q3-30871\nDatum: 07.07.2026\nLohnsumme gemäss Meldung: CHF 18\'750.00\nAHV/IV/EO 10.6%\nALV 2.2%\nFamilienausgleichskasse FAK 1.3%\nVerwaltungskosten 2% der AHV/IV/EO-Beiträge\nTotal CHF\n1987.50\n412.50\n243.75\n39.75\n2683.50', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-07-07', amount: 2683.5, currency: 'CHF', hasSwissVat: false } as Receipt;
const PRINT_BILL: Receipt = { id: 'dr', filename: 'dr.pdf', extractedText: 'Druckerei Brun AG\nRechnung 2026-118\nTotal CHF 540.00\nMWST 8.1% 40.47', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-09-10', amount: 540, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 40.47, gross: 540 }] } as Receipt;

function firm(entries: JournalEntry[]): Workspace {
  const made = tempWorkspace('withheld-426-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: no\n  imports: no\n  employees: staff\n  ownerPaysPrivately: no\n  privateUse: []\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const mappings: Mapping[] = [{ transactionRef: 'AK', receiptId: 'ak', by: 'human' }, { transactionRef: 'DR', receiptId: 'dr', by: 'human' }];
  writeIndex(ws, { transactions: [...WAGES, PENSION, AKONTO, PRINTER], journalEntries: entries, receipts: [BILL, PRINT_BILL], mappings, config: { closedThrough: '2026-06-30' } });
  return ws;
}

/** The prompt's part of each transaction, by its ref; the answer books every payment whole on 5700. */
async function told(ws: Workspace, txs: string[], extra: JournalEntry[] = []) {
  const books = loadBooks(ws);
  books.journalEntries.push(...extra);
  const said: Record<string, string> = {};
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const out: Record<string, unknown> = {};
    for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
      const ref = part.split(/\s/)[0];
      said[ref] = part.split('\n\n')[0];
      out[ref] = { entries: [{ accountDebit: '5700', accountCredit: '', amount: Number(/Amount: -?([\d.]+)/.exec(part)![1]), vat: 'none', description: ref }] };
    }
    return JSON.stringify(out);
  };
  await classifyTransactions(books, books.transactions.filter((t) => txs.includes(t.ref)), { ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  return said;
}

test('the Akonto payment is told what 2270 holds on its day: the employees\' AHV/ALV of the three payslips, the pension fund\'s share already paid', async () => {
  const said = await told(firm([...gross, ...pension]), ['AK']);
  assert.match(said.AK, /Withheld from wages: account 2270 holds 1200 CHF, deducted on the payslips booked so far/);
});

test('a payment booked again is told what was open before it, not after its own lines', async () => {
  const own = [entry('AK', '2026-09-28', '2270', '1020', 1200), entry('AK', '2026-09-28', '5700', '1020', 1483.5)];
  const books = { journalEntries: [...gross, ...pension, ...own] };
  assert.equal(withheldFor(books, AKONTO, '2270'), 1200);
  assert.equal(withheldFor(books, { ...AKONTO, ref: 'later', date: '2026-09-30' }, '2270'), undefined, 'after the Akonto payment 2270 holds nothing');
});

test('no word of it for a wage, a purchase whose receipt shows Swiss VAT, or when wages are booked net', async () => {
  const said = await told(firm([...gross.filter((e) => e.transactionRef !== 'LO-09'), ...pension]), ['LO-09', 'DR']);
  assert.doesNotMatch(said['LO-09'], /Withheld from wages/, 'a wage');
  assert.doesNotMatch(said.DR, /Withheld from wages/, 'a purchase with Swiss VAT');
  const net = MONTHS.flatMap((m) => [entry(`LO-${m}`, `2026-${m}-24`, '5000', '1020', 4200), entry(`LH-${m}`, `2026-${m}-24`, '5000', '1020', 1450.8)]);
  const none = await told(firm([...net, entry('PK', '2026-07-10', '5720', '1020', 1195.2)]), ['AK']);
  assert.doesNotMatch(none.AK, /Withheld from wages/, 'wages booked net: 2270 holds nothing');
  assert.equal(withheldFor({ journalEntries: gross }, { ...AKONTO, direction: 'CRDT' }, '2270'), undefined, 'money in');
});
