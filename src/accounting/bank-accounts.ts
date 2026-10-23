/**
 * The owner's account as the jurisdiction names it when the manifest has none, and how a
 * statement finds the money account it lands on (accountForStatement). Which account a movement
 * moved on, its role and whether a statement confirms it: src/workspace/money-accounts.ts.
 */
import type { StatementProblem, UnknownAccount } from '../types/api-error.js';
export type { StatementProblem } from '../types/api-error.js';
import type { LedgerBankAccount, Workspace } from '../workspace/workspace.js';
import { setup } from '../engines/index.js';
import { parseIban, type StatementKind } from '../workspace/banks.js';
import { ownerOf } from '../workspace/money-accounts.js';

/** The owner's private account, number and name: the manifest's owner account, else the jurisdiction's for the legal form (a current account, the private account of an Einzelfirma). */
export function ownerAccount(ws: Pick<Workspace, 'bankAccounts' | 'company'>): string {
  const { account, label } = ownerAccountOf(ws);
  return `${account} ${label}`;
}

/** The owner's account alone: the manifest's owner account, else the legal form's default (setup.yaml). */
export const ownerAccountNumber = (ws: OwnerFacts): string => ownerAccountOf(ws).account;

/** What names the owner's account: the manifest's owner account, else the legal form. */
type OwnerFacts = { bankAccounts: readonly LedgerBankAccount[]; company: Pick<Workspace['company'], 'legalForm'> };

function ownerAccountOf(ws: OwnerFacts): { account: string; label: string } {
  const owner = ownerOf(ws.bankAccounts);
  if (owner) return { account: owner.account, label: owner.label };
  const { owner: byForm } = setup();
  return (ws.company.legalForm && byForm[ws.company.legalForm]) || byForm.otherwise;
}

/** What a statement says about its account, and the folder under bank-statements/ it was found in. */
export interface StatementAccount {
  iban?: string;
  currency: string;
  /** First folder under bank-statements/ ('' for a file directly in it). */
  folder: string;
}

export type StatementMatch =
  | { account: LedgerBankAccount & { statements: StatementKind }; by: 'iban' | 'folder' | 'currency' }
  /** `problem`: the words for the CLI and the logs; `unknown`: the statement's account when the manifest lacks it (the UI offers to add it). */
  | { problem: string; refusal: StatementProblem; unknown?: UnknownAccount };

/** The statement's account as the UI offers to add it: only an IBAN with valid check digits is offered. */
export const unknownOf = (refusal: StatementProblem): { unknown: UnknownAccount } | Record<string, never> =>
  refusal.iban ? { unknown: { iban: refusal.iban, currency: refusal.currency } } : {};

/**
 * The ledger account a statement lands on: the account with its IBAN and currency, else the
 * account of its folder (the bank label, any case) and currency, else, for a file in no bank's
 * folder and as a PDF statement is placed, the firm's only imported account of that currency that
 * names no IBAN; with several such accounts the person is asked which (`whichAccount`). A folder account
 * with another IBAN is a mismatch, never a fallback: the statement belongs to an account the
 * manifest lacks. An IBAN the manifest names is never asked for again.
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
    const refusal: StatementProblem = { kind: 'otherIban', currency: s.currency, iban, account: { bank: byFolder.bank, iban: byFolder.iban } };
    return { problem: `statement of ${of} is in ${where}, but ${byFolder.bank} ${byFolder.currency} has IBAN ${byFolder.iban}. Add that account to bankAccounts in belege.workspace.yaml (another bank label, its own ledger account, role: bank, iban: ${iban}), or move the file to its bank's folder.`, refusal, ...unknownOf(refusal) };
  }
  if (byFolder) return { account: byFolder, by: 'folder' };
  // A folder named for a bank holds that bank's statements: only a file of no bank's folder falls back to the firm's one account of its currency.
  const folderKnown = imported.some((a) => a.bank.toLowerCase() === s.folder.toLowerCase());
  const inCurrency = imported.filter((a) => a.currency === s.currency && !a.iban);
  if (!folderKnown && inCurrency.length === 1) return { account: inCurrency[0], by: 'currency' };
  // A file in no bank's folder (an upload, a drop) is asked; a folder named for a bank the books lack says it is that bank's.
  if (!s.folder && inCurrency.length > 1) {
    const refusal: StatementProblem = { kind: 'whichAccount', currency: s.currency, ...(iban ? { iban } : {}), accounts: inCurrency.map((a) => ({ account: a.account, bank: a.bank, label: a.label })) };
    return { problem: `statement of ${of} could be any of ${inCurrency.length} accounts in ${s.currency} without IBAN (${inCurrency.map((a) => `${a.bank} ${a.account}`).join(', ')}). Add its IBAN${iban ? ` ${iban}` : ''} to the right one in bankAccounts of belege.workspace.yaml, or put the file into that bank's folder.`, refusal, ...unknownOf(refusal) };
  }
  const refusal: StatementProblem = { kind: 'noAccount', currency: s.currency, ...(iban ? { iban } : {}) };
  return { problem: `statement of ${of} in ${where} matches no bank account. Add { bank: ${s.folder || '<bank>'}, currency: ${s.currency}, account: "<ledger account>", label: <name>, role: bank${iban ? `, iban: ${iban}` : ''} } to bankAccounts in belege.workspace.yaml.`, refusal, ...unknownOf(refusal) };
}
