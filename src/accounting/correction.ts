/**
 * The correction of a filed entry, by what was wrong with it (golden rule 1: booked in the open
 * period with `corrects`, declared on the 0535). The payment happened, so a correction of the VAT
 * code or of the account leaves the bank alone; only a storno takes the whole entry back, bank
 * side included. Pure: Buchungen opens its correction form with these.
 */
import type { JournalEntry } from '../types/index.js';
import { reversalOf, turned, type Draft } from './reversal.js';

/** What was wrong: the VAT code, the account (expense or revenue), or the whole entry. */
export type CorrectionKind = 'vat' | 'account' | 'storno';

type Corrected = Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'vatCode'>;

/** The kinds an entry offers, the first the form starts with: a VAT code to take back first. */
export const correctionKinds = (e: Corrected): CorrectionKind[] => (e.vatCode ? ['vat', 'account', 'storno'] : ['account', 'storno']);

/** The side the money did not move on: the expense or revenue account, the debit when neither side is a bank. */
function ownSide(e: Corrected, isBank: (account: string) => boolean): 'accountDebit' | 'accountCredit' {
  if (!e.accountDebit) return 'accountCredit';
  if (!e.accountCredit) return 'accountDebit';
  return isBank(e.accountDebit) && !isBank(e.accountCredit) ? 'accountCredit' : 'accountDebit';
}

/**
 * The correction entry, dated `date`:
 * - `vat`: the expense (or revenue) account against itself with the VAT code turned, so only the
 *   tax is taken back (6510/6510 -I81). A one-sided VAT entry is turned whole: it has no bank side.
 * - `account`: the amount moved from the old account to a new one, left blank for the person; the
 *   VAT stays as declared.
 * - `storno`: the entry the other way round, bank side included.
 */
export function correctionOf(e: Corrected, kind: CorrectionKind, date: string, description: string, isBank: (account: string) => boolean): Draft {
  const own = ownSide(e, isBank);
  const account = e[own];
  if (kind === 'storno' || (kind === 'vat' && (!e.accountDebit || !e.accountCredit))) return reversalOf(e, date, description);
  if (kind === 'vat') {
    const vatCode = turned(e.vatCode);
    return { date, accountDebit: account, accountCredit: account, amount: e.amount, ...(vatCode && { vatCode }), description };
  }
  return own === 'accountDebit'
    ? { date, accountDebit: '', accountCredit: account, amount: e.amount, description }
    : { date, accountDebit: account, accountCredit: '', amount: e.amount, description };
}

/** The bank accounts an entry typed without its payment would move: money no statement shows. */
export const banksMoved = (e: Pick<JournalEntry, 'accountDebit' | 'accountCredit'>, isBank: (account: string) => boolean): string[] =>
  e.accountDebit === e.accountCredit ? [] : [e.accountDebit, e.accountCredit].filter((a) => !!a && isBank(a));
