import type { JournalEntry } from '../types/index.js';
import { computeBalances, type AccountBalance } from './ledger.js';
import { roundCHF } from './rappen.js';
import { chart } from '../engines/index.js';

export interface TrialBalanceRow extends AccountBalance {
  name: string;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
}

export function computeTrialBalance(
  entries: JournalEntry[],
  from: string,
  to: string,
  openingBalances: Record<string, number>,
  accountNames: Record<string, string>,
): TrialBalance {
  const balances = computeBalances(entries, from, to, openingBalances, chart().isDebitNormal);

  const rows: TrialBalanceRow[] = balances
    .filter(b => b.debitTotal !== 0 || b.creditTotal !== 0 || b.balance !== 0)
    .map(b => ({
      ...b,
      name: accountNames[b.account] ?? b.account,
    }));

  const totalDebits = rows.reduce((sum, r) => sum + r.debitTotal, 0);
  const totalCredits = rows.reduce((sum, r) => sum + r.creditTotal, 0);

  return {
    rows,
    totalDebits: roundCHF(totalDebits),
    totalCredits: roundCHF(totalCredits),
    isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
  };
}
