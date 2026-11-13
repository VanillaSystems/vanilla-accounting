/**
 * What the firm still owes the owner for the business costs she paid privately (#402), read off the
 * books: her outlays (an expense or an asset booked against her account: «Privat bezahlt», an
 * employee-like outlay) less what the firm paid her back (a payment booked onto her account only).
 * Her deposits and loans, and a private share of a firm's payment (that payment books its business
 * part too), are no outlays and no repayments here. A payment to her by name that this covers repays
 * outlays: bank / her account, no VAT code (booking.guide.yaml cls-owner-outlays-repaid), never an
 * expense again.
 */
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { chfAmount } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';

type Books = { journalEntries: readonly JournalEntry[]; transactions: readonly Pick<BankTransaction, 'ref'>[] };

/**
 * The outlays not paid back on `owner` up to the end of `date`, within its year, in the books'
 * currency. `money`: the money accounts (the banks, the cash box, the owner's own). `except`: the
 * payment asked about, whose own booking counts for nothing.
 */
export function outlaysOpen(books: Books, owner: string, money: ReadonlySet<string>, date: string, except?: string): number {
  const from = `${date.slice(0, 4)}-01-01`;
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) {
    if (e.transactionRef === except || e.date < from || e.date > date) continue;
    const list = byRef.get(e.transactionRef);
    if (list) list.push(e); else byRef.set(e.transactionRef, [e]);
  }
  const moves = (a: string | undefined) => !!a && (a === owner || money.has(a));
  let open = 0;
  for (const entries of byRef.values()) {
    // A payment booked onto the owner's account only: money paid to her (or by her, a deposit, which is no outlay).
    const onlyMoney = entries.every((e) => moves(e.accountDebit) && moves(e.accountCredit));
    for (const e of entries) {
      if (e.accountCredit === owner && !moves(e.accountDebit)) open += toRappen(chfAmount(e));
      else if (onlyMoney && e.accountDebit === owner && e.accountCredit !== owner) open -= toRappen(chfAmount(e));
    }
  }
  return fromRappen(open);
}
