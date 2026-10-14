/** The year-close fixture: a small company's 2026, and the state a real year reaches in February. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Index, JournalEntry } from '../../src/types/index.js';
import { estvRates, type EstvRates } from '../../src/accounting/fx-conversion.js';
import { loadBooks, saveBooks } from '../../src/books/store.js';
import { writeSeal } from '../../src/books/seal.js';
import type { Books } from '../../src/accounting/year-close.js';
import { APP_ROOT, yearPaths, type LedgerBankAccount, type Workspace } from '../../src/workspace/workspace.js';
import { tempWorkspace, writeIndex } from './workspace.js';

export const CHART = ['1020', '1021', '1170', '1171', '2201', '2800', '2970', '3400', '6570', '6960'];

export const BANKS: LedgerBankAccount[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', statements: 'camt053' },
  { bank: 'Wise', currency: 'EUR', account: '1021', label: 'Wise EUR', statements: 'wise' },
];

export const e = (id: string, date: string, accountDebit: string, accountCredit: string, amount: number, more: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit, accountCredit, amount, ...more });

export function books(): Books & Pick<Index, 'receipts' | 'mappings'> {
  return {
    receipts: [],
    mappings: [],
    transactions: ['sale', 'buy', 'eur', 'vat'].map((ref) => ({ ref, bank: ref === 'eur' ? 'Wise' : 'Raiffeisen', date: '2026-02-10', amount: 1, currency: ref === 'eur' ? 'EUR' : 'CHF', direction: 'CRDT' as const, description: ref })),
    bankStatements: [
      { bank: 'Raiffeisen', filename: 'r.xml', fromDate: '2026-01-01', toDate: '2026-12-31', currency: 'CHF' },
      { bank: 'Wise', filename: 'w.xml', fromDate: '2026-01-01', toDate: '2026-12-31', currency: 'EUR' },
    ],
    statementBalances: [],
    journalEntries: [
      e('sale', '2026-02-10', '1020', '3400', 1081, { vatCode: 'V81' }),
      e('buy', '2026-02-11', '6570', '1020', 108.1, { vatCode: 'I81' }),
      e('eur', '2026-03-01', '1021', '3400', 500, { vatCode: 'V0-E', exchangeCurrency: 'EUR', exchangeRate: 0.95 }),
      e('vat', '2026-05-01', '2201', '1020', 72.9),
    ],
    config: {
      closedThrough: '2026-09-30',
      openingBalances: { 2026: { 1020: 10000, 1021: 940, 2800: 10000, 2970: 940 } },
      openingBalancesNative: { 2026: { 1021: { amount: 1000, currency: 'EUR' } } },
    },
  };
}

/** A stand-in ESTV table: EUR 0.93 on 31.12.2026, fetched after the year ended. */

export const RATES: EstvRates = estvRates({ fetchedAt: '2027-01-05T08:00:00Z', rates: { '2026-12-31': { EUR: 0.93, src: 'stand-in' }, '2027-01-04': { EUR: 0.931, src: 'stand-in' } } });

export const NO_YEAR_END_RATE: EstvRates = estvRates({ fetchedAt: '2026-10-01T08:00:00Z', rates: { '2026-09-30': { EUR: 0.94 } } });

export function workspace(inRepository = false): Workspace {
  const ws = tempWorkspace('year-close-', join(APP_ROOT, 'demo-consulting'), { inRepository });
  writeIndex(ws, books());
  mkdirSync(ws.paths.masterData, { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(CHART.map((number) => ({ number, name: number }))));
  return ws;
}

export const Q4_FILED = `<VATDeclaration><generalInformation><reportingPeriodFrom>2026-10-01</reportingPeriodFrom><reportingPeriodTill>2026-12-31</reportingPeriodTill></generalInformation>
<turnoverComputation><totalConsideration>0</totalConsideration></turnoverComputation><effectiveReportingMethod><grossOrNet>2</grossOrNet></effectiveReportingMethod><payableTax>0</payableTax></VATDeclaration>`;

/** The state a real year reaches in February: Q1 to Q3 filed, closed and sealed, Q4 filed, December's bank balances in. */
export function readyToClose(inRepository = false): Workspace {
  const ws = workspace(inRepository);
  writeFileSync(ws.paths.accounts, JSON.stringify([...CHART, '2451'].map((number) => ({ number, name: number }))));
  const y = yearPaths(ws.paths, '2026');
  for (const dir of [y.receipts, join(y.statements, 'Raiffeisen'), join(y.statements, 'Wise'), y.filings]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(y.filings, 'mwst-ech0217-2026-Q4.xml'), Q4_FILED);
  const b = loadBooks(ws);
  b.statementBalances = [
    { account: '1020', bank: 'Raiffeisen', currency: 'CHF', date: '2026-12-31', amount: 10900, source: 'pdf', sourceFile: 'r.pdf' },
    { account: '1021', bank: 'Wise', currency: 'EUR', date: '2026-12-31', amount: 1500, source: 'pdf', sourceFile: 'w.pdf' },
  ];
  saveBooks(ws, b);
  for (const q of ['2026-Q1', '2026-Q2', '2026-Q3'] as const) writeSeal(ws, loadBooks(ws), q, '2026-10-15');
  return ws;
}
