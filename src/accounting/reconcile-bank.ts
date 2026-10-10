/**
 * Bank-balance reconciliation.
 *
 * For each bank account, compares the bank statement's closing balance (from the
 * camt053 CLBD snapshot, native currency) against the ledger's balance on the
 * same date, computed in the account's own currency:
 *
 *   book = nativeOpening(year) + Σ(native debits) − Σ(native credits)  [through as-of date]
 *
 * Every journal entry on a bank account stores its amount in the account's own
 * currency (CHF accounts have no exchangeCurrency; EUR/USD accounts carry the
 * native amount + rate), so debits/credits sum natively without FX conversion.
 */

import type { Index, JournalEntry, StatementClosingBalance } from '../types/index.js';
import { toRappen, fromRappen } from './rappen.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { BalanceSnapshot } from '../parsers/statement-balances.js';

export interface ReconcileRow {
  account: string;
  label: string;
  currency: string;
  asOf: string;
  bankBalance: number; // statement CLBD, native currency
  bookBalance: number; // ledger balance, native currency
  difference: number; // book − bank
  matched: boolean;
  sourceFile: string;
}

const MATCH_TOLERANCE_RAPPEN = 1; // 0.01 in the account's currency unit

/** Native opening balance for a bank account at the start of `year`. */
export function nativeOpening(index: Pick<Index, 'config'>, account: string, currency: string, year: string): number {
  const native = index.config?.openingBalancesNative?.[year]?.[account];
  if (native && native.currency === currency) return native.amount;
  // CHF accounts store their opening in the plain (CHF) opening-balance table.
  if (currency === 'CHF') return index.config?.openingBalances?.[year]?.[account] ?? 0;
  return 0;
}

/** Ledger balance for one bank account in its own currency, from year start through asOf. */
export function bookBalanceNative(
  entries: JournalEntry[],
  account: string,
  currency: string,
  year: string,
  asOf: string,
  opening: number,
): number {
  const from = `${year}-01-01`;
  let rappen = toRappen(opening);
  for (const e of entries) {
    if (!e.date || e.date < from || e.date > asOf) continue;
    // The year-end revaluation (src/accounting/year-close.ts) changes the CHF value only: no money moved.
    if (e.origin === 'year-close') continue;
    if (e.accountDebit === account) rappen += toRappen(e.amount);
    if (e.accountCredit === account) rappen -= toRappen(e.amount);
  }
  return fromRappen(rappen);
}

/**
 * Reconcile every bank account against the CLBD snapshots on `asOf`. If a bank
 * account has no closing snapshot exactly on `asOf`, the most recent CLBD on or
 * before `asOf` is used (and its own date is reported).
 */
export function reconcileBankBalances(
  index: Index,
  snapshots: BalanceSnapshot[],
  asOf: string,
  bankAccounts: readonly LedgerBankAccount[],
): ReconcileRow[] {
  const entries = index.journalEntries ?? [];
  const year = asOf.slice(0, 4);
  const rows: ReconcileRow[] = [];

  for (const acct of bankAccounts) {
    const clbd = pickClosingSnapshot(snapshots, acct, asOf);
    if (!clbd) continue;
    const opening = nativeOpening(index, acct.account, acct.currency, year);
    const book = bookBalanceNative(entries, acct.account, acct.currency, year, clbd.date, opening);
    const diff = fromRappen(toRappen(book) - toRappen(clbd.amount));
    rows.push({
      account: acct.account,
      label: acct.label,
      currency: acct.currency,
      asOf: clbd.date,
      bankBalance: clbd.amount,
      bookBalance: book,
      difference: diff,
      matched: Math.abs(toRappen(diff)) <= MATCH_TOLERANCE_RAPPEN,
      sourceFile: clbd.sourceFile,
    });
  }
  return rows;
}

function pickClosingSnapshot(
  snapshots: BalanceSnapshot[],
  acct: LedgerBankAccount,
  asOf: string,
): BalanceSnapshot | undefined {
  const candidates = snapshots
    .filter((s) => s.type === 'CLBD' && s.bank === acct.bank && s.currency === acct.currency && s.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date));
  return candidates[candidates.length - 1];
}

/** All distinct CLBD dates available across the statements, for listing reconciliation points. */
export function closingDates(snapshots: BalanceSnapshot[]): string[] {
  return Array.from(new Set(snapshots.filter((s) => s.type === 'CLBD').map((s) => s.date))).sort();
}

// ─── Monthly reconciliation against statement PDF closing balances ───────────

export interface MonthlyReconcileRow {
  date: string; // statement month-end
  bankBalance: number; // from the statement PDF (native currency)
  bookBalance: number; // ledger balance on that date (native currency)
  difference: number; // book − bank
  matched: boolean;
  sourceFile: string;
}

export interface AccountReconciliation {
  account: string;
  label: string;
  currency: string;
  rows: MonthlyReconcileRow[];
  allMatched: boolean;
}

/**
 * Reconcile every bank Bilanzkonto against its monthly statement PDF closing
 * balances, month by month, in the account's own currency. This is the data
 * behind the auditor-facing reconciliation view. Pure/synchronous so both the
 * CLI and the browser UI can call it off `index.statementBalances`.
 */
export function reconcileMonthly(index: Index, bankAccounts: readonly LedgerBankAccount[]): AccountReconciliation[] {
  const entries = index.journalEntries ?? [];
  const balances = index.statementBalances ?? [];
  const result: AccountReconciliation[] = [];

  for (const acct of bankAccounts) {
    const forAccount = balances
      .filter((b) => b.account === acct.account)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (forAccount.length === 0) continue;

    const rows: MonthlyReconcileRow[] = forAccount.map((b) => {
      const year = b.date.slice(0, 4);
      const opening = nativeOpening(index, acct.account, acct.currency, year);
      const book = bookBalanceNative(entries, acct.account, acct.currency, year, b.date, opening);
      const diff = fromRappen(toRappen(book) - toRappen(b.amount));
      return {
        date: b.date,
        bankBalance: b.amount,
        bookBalance: book,
        difference: diff,
        matched: Math.abs(toRappen(diff)) <= MATCH_TOLERANCE_RAPPEN,
        sourceFile: b.sourceFile,
      };
    });

    result.push({
      account: acct.account,
      label: acct.label,
      currency: acct.currency,
      rows,
      allMatched: rows.every((r) => r.matched),
    });
  }
  return result;
}
