/**
 * The ledger account money moving through a bank + currency is booked on, from the workspace
 * manifest's bankAccounts. A `manual` transaction was paid privately, so the manifest books it on
 * the owner's Kontokorrent whatever its currency. Used by classify to fill in the bank side, and
 * by bank-balance reconciliation to match a statement's closing balance to a ledger account (no
 * statement names `manual`, so those rows never reconcile).
 */
import type { BankTransaction } from '../types/index.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';

export function findBankAccount(accounts: readonly LedgerBankAccount[], bank: string, currency: string): LedgerBankAccount | undefined {
  return accounts.find((a) => a.bank === bank && a.currency === currency);
}

/** The ledger account a transaction's bank side is booked on: the manifest's first account when the pair is unknown. */
export function bankAccountFor(tx: Pick<BankTransaction, 'bank' | 'currency'>, accounts: readonly LedgerBankAccount[]): string {
  return findBankAccount(accounts, tx.bank, tx.currency)?.account ?? accounts[0].account;
}
