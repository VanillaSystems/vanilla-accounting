/**
 * The money accounts of the manifest (#88) and the movements on them: which account a movement
 * moved on, its role, and whether a statement confirms it. Every money account is equal: a bank,
 * the cash box, the owner's, an employee's, a card, a clearing account each take movements from
 * receipts, answers and hand entries, and statement imports when the person has them.
 */
import type { BankTransaction } from '../types/index.js';
import type { LedgerBankAccount } from './workspace.js';
import { MANUAL_BANK, type MoneyRole } from './banks.js';

export function findBankAccount(accounts: readonly LedgerBankAccount[], bank: string, currency: string): LedgerBankAccount | undefined {
  return accounts.find((a) => a.bank === bank && a.currency === currency);
}

type Moved = Pick<BankTransaction, 'bank' | 'currency'>;

/**
 * The money account a movement moved on: the one of its label and currency. The owner's outlays
 * (label `manual`, or the owner's account's own) go on the owner's account in any currency (#87:
 * an outlay in EUR).
 */
export function accountOf(tx: Moved, accounts: readonly LedgerBankAccount[]): LedgerBankAccount | undefined {
  const owner = ownerOf(accounts);
  return findBankAccount(accounts, tx.bank, tx.currency) ?? (owner && (tx.bank === MANUAL_BANK || tx.bank === owner.bank) ? owner : undefined);
}

/** A movement whose money account the manifest does not name: booking it on another account would misbook it. */
export class UnknownMoneyAccountError extends Error {}

/**
 * The ledger account a movement's money side is booked on. A movement on an account the manifest
 * lacks is refused, never booked on some other account (an older app took the first bank account).
 */
export function bankAccountFor(tx: Moved & Partial<Pick<BankTransaction, 'ref'>>, accounts: readonly LedgerBankAccount[]): string {
  const account = accountOf(tx, accounts);
  if (account) return account.account;
  throw new UnknownMoneyAccountError(`${tx.ref ?? 'A movement'} moved on ${tx.bank} ${tx.currency}, which no account of bankAccounts in belege.workspace.yaml names. Add that account (bank: ${tx.bank}, currency: ${tx.currency}, its ledger account, role).`);
}

/** The role of the account a movement moved on; undefined when the manifest names none. */
export const roleOf = (tx: Moved, accounts: readonly LedgerBankAccount[]): MoneyRole | undefined => accountOf(tx, accounts)?.role;

/** Whether a statement confirms the movement: a row of an imported statement, or a hand movement a statement row was matched to. */
export const byStatement = (tx: Pick<BankTransaction, 'source' | 'statement'>): boolean => tx.source !== 'manual' || tx.statement !== undefined;

/** Whether a receipt, an answer or a hand entry made the movement (not a statement row). */
export const madeByHand = (tx: Pick<BankTransaction, 'source'>): boolean => tx.source === 'manual';

/** The owner's account of the manifest, if it has one: its first currency's row (one ledger account, a row per currency). */
export const ownerOf = (accounts: readonly LedgerBankAccount[]): LedgerBankAccount | undefined => accounts.find((a) => a.role === 'owner');

/** The accounts at a bank or a payment provider: what an invoice is paid to. */
export const banksOf = (accounts: readonly LedgerBankAccount[]): LedgerBankAccount[] => accounts.filter((a) => a.role === 'bank');

/**
 * What names one bank transaction across re-reads. A Wise card charge split over two currencies is
 * two transactions with one ref (assignUniqueRefs keeps it shared: one payment), so a transaction
 * is matched to its previous self by ref and currency, never by the ref alone (#23).
 */
export const legOf = (t: Pick<BankTransaction, 'ref' | 'currency'>): string => `${t.ref} ${t.currency}`;
