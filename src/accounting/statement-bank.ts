/**
 * Which of the accounts a statement could be of has the bank the statement names (#208): when a
 * camt.053 asks for its account (`whichAccount`), the one account whose `bank:` the file names is
 * proposed, and the person still confirms it. The bank is read generically, for any bank: the
 * servicer's name holding the label, the BIC's institution code, and the IBAN's bank code compared
 * with the IBANs already known under that label. No proposal when none or several match.
 */
import type { AccountChoice } from '../types/api-error.js';

/** What a statement says about the bank that keeps its account. */
export interface StatementBank { bankName?: string; bic?: string; iban?: string }

/**
 * Where the bank identifier sits in an IBAN, per country (ISO 13616 IBAN registry: offset in the
 * compact IBAN and length). A country not listed gives no bank code, so its IBANs never match.
 */
const BANK_CODE: Record<string, readonly [start: number, length: number]> = {
  CH: [4, 5], LI: [4, 5], DE: [4, 8], AT: [4, 5], FR: [4, 5], MC: [4, 5], IT: [5, 5], SM: [5, 5],
  GB: [4, 4], IE: [4, 4], NL: [4, 4], BE: [4, 3], LU: [4, 3], ES: [4, 4], PT: [4, 4], DK: [4, 4],
  FI: [4, 3], SE: [4, 3], NO: [4, 4], PL: [4, 8], CZ: [4, 4], SK: [4, 4], HU: [4, 3], SI: [4, 2], HR: [4, 7],
};

/** The bank part of an IBAN with its country («CH:80808»), undefined for a country the table lacks. */
export function bankCodeOf(iban: string): string | undefined {
  const compact = iban.replace(/\s+/g, '').toUpperCase();
  const at = BANK_CODE[compact.slice(0, 2)];
  return at && compact.length >= at[0] + at[1] ? `${compact.slice(0, 2)}:${compact.slice(at[0], at[0] + at[1])}` : undefined;
}

/** Letters and digits only, lower case, accents dropped: «Zürcher Kantonalbank» → «zurcherkantonalbank». */
const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether the statement names the bank of the manifest label `label`: its servicer's name holds
 * the label, the BIC's institution code (its first four letters) and the label begin alike, or its
 * IBAN has the bank code of an IBAN `known` under that label.
 */
export function namesBank(s: StatementBank, label: string, known: readonly string[]): boolean {
  const l = plain(label);
  if (l.length >= 3) {
    if (s.bankName && plain(s.bankName).includes(l)) return true;
    const institution = s.bic ? plain(s.bic.slice(0, 4)) : '';
    if (institution.length === 4 && (institution.startsWith(l) || l.startsWith(institution))) return true;
  }
  const code = s.iban ? bankCodeOf(s.iban) : undefined;
  return !!code && known.some((k) => bankCodeOf(k) === code);
}

/** The one account of the choice whose bank the statement names, else undefined (none or several). */
export function proposedAccount(choice: AccountChoice, s: StatementBank, knownIbans: (bank: string) => readonly string[]): string | undefined {
  const hits = choice.accounts.filter((a) => namesBank(s, a.bank, knownIbans(a.bank)));
  return hits.length === 1 ? hits[0].account : undefined;
}
