import type { Postings } from './ledger.js';
import { toRappen, fromRappen } from './rappen.js';
import { chfAmount } from './ledger.js';
import { chart } from '../engines/index.js';

export interface AccountLedgerRow {
  date: string;
  description: string;
  debit: number | null;
  credit: number | null;
  balance: number;
  entryId: string;
}

export function computeAccountLedger(
  postings: Postings,
  account: string,
  from: string,
  to: string,
  openingBalance: number = 0,
): { openingBalance: number; rows: AccountLedgerRow[] } {
  const relevant = postings
    .filter(e => {
      if (!e.date) return false;
      if (e.date < from || e.date > to) return false;
      return e.accountDebit === account || e.accountCredit === account;
    })
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const debitNormal = chart().isDebitNormal(account);
  let balanceRappen = toRappen(openingBalance);
  const rows: AccountLedgerRow[] = [];

  for (const entry of relevant) {
    const amtRappen = toRappen(chfAmount(entry));
    let debit: number | null = null;
    let credit: number | null = null;

    if (entry.accountDebit === account) {
      debit = fromRappen(amtRappen);
      balanceRappen += debitNormal ? amtRappen : -amtRappen;
    }
    if (entry.accountCredit === account) {
      credit = fromRappen(amtRappen);
      balanceRappen += debitNormal ? -amtRappen : amtRappen;
    }

    rows.push({
      date: entry.date ?? '',
      description: entry.description ?? '',
      debit,
      credit,
      balance: fromRappen(balanceRappen),
      entryId: entry.id,
    });
  }

  return { openingBalance, rows };
}
