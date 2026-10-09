/**
 * The ledger account money moving through a bank + currency is booked on, from the workspace
 * manifest's bankAccounts. A `manual` transaction was paid privately, so the manifest books it on
 * the owner's Kontokorrent whatever its currency. Used by classify to fill in the bank side, and
 * by bank-balance reconciliation to match a statement's closing balance to a ledger account (no
 * statement names `manual`, so those rows never reconcile).
 */
import type { BankTransaction } from '../types/index.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import { parseIban, type StatementKind } from '../workspace/banks.js';

export function findBankAccount(accounts: readonly LedgerBankAccount[], bank: string, currency: string): LedgerBankAccount | undefined {
  return accounts.find((a) => a.bank === bank && a.currency === currency);
}

/** The ledger account a transaction's bank side is booked on: the manifest's first account when the pair is unknown. */
export function bankAccountFor(tx: Pick<BankTransaction, 'bank' | 'currency'>, accounts: readonly LedgerBankAccount[]): string {
  return findBankAccount(accounts, tx.bank, tx.currency)?.account ?? accounts[0].account;
}

/** What a statement says about its account, and the folder under bank-statements/ it was found in. */
export interface StatementAccount {
  iban?: string;
  currency: string;
  /** First folder under bank-statements/ ('' for a file directly in it). */
  folder: string;
}

export type StatementMatch =
  | { account: LedgerBankAccount & { statements: StatementKind }; by: 'iban' | 'folder' }
  | { problem: string };

/**
 * The ledger account a statement lands on: the account with its IBAN and currency, else the
 * account of its folder (the bank label, any case) and currency. A folder account with another
 * IBAN is a mismatch, never a fallback: the statement belongs to an account the manifest lacks.
 */
export function accountForStatement(accounts: readonly LedgerBankAccount[], s: StatementAccount): StatementMatch {
  const imported = accounts.filter((a): a is LedgerBankAccount & { statements: StatementKind } => a.statements !== undefined);
  const iban = s.iban === undefined ? undefined : parseIban(s.iban);
  const byIban = iban && imported.find((a) => a.iban === iban && a.currency === s.currency);
  if (byIban) return { account: byIban, by: 'iban' };
  const byFolder = imported.find((a) => a.bank.toLowerCase() === s.folder.toLowerCase() && a.currency === s.currency);
  const where = s.folder ? `bank-statements/${s.folder}/` : 'bank-statements/';
  const of = `${iban ? `IBAN ${iban}` : 'an account without IBAN'} in ${s.currency}`;
  if (byFolder?.iban && iban) {
    return { problem: `statement of ${of} is in ${where}, but ${byFolder.bank} ${byFolder.currency} has IBAN ${byFolder.iban}. Add that account to bankAccounts in belege.workspace.yaml (another bank label, its own ledger account, iban: ${iban}), or move the file to its bank's folder.` };
  }
  if (byFolder) return { account: byFolder, by: 'folder' };
  return { problem: `statement of ${of} in ${where} matches no bank account. Add { bank: ${s.folder || '<bank>'}, currency: ${s.currency}, account: "<ledger account>", label: <name>${iban ? `, iban: ${iban}` : ''} } to bankAccounts in belege.workspace.yaml.` };
}
