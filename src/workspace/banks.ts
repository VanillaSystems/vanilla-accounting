/**
 * The banks Belege knows: where each one's ledger account is suggested and how its statements
 * are imported. A bank not listed (a cantonal or regional bank) imports camt.053 like the
 * listed ones. Init, the manifest reader and doctor all read this table.
 */

/**
 * How a bank's statements are read. `camt053`: the ISO 20022 statement every Swiss bank
 * exports. `wise`: Wise's camt.053, whose entries carry the Wise transaction id in BkTxCd
 * instead of AcctSvcrRef, whose fee lines are tagged, and whose monthly PDFs add the transfer
 * references the XML drops.
 */
export type StatementKind = 'camt053' | 'wise';
export const STATEMENT_KINDS: readonly StatementKind[] = ['camt053', 'wise'];

/** Where money is kept. `range` is where its ledger account is suggested; `statements` how it is imported. */
export interface BankKind {
  range: 'bank' | 'card';
  statements?: StatementKind;
  /** Statement import proven on real files. */
  tested: boolean;
  note?: string;
}

const camt = (tested: boolean): BankKind => ({ range: 'bank', statements: 'camt053', tested });
const UNTESTED = 'Belege reads the camt.053 of any Swiss bank; real files of this bank were not imported yet. Import your first statement and check its transactions and closing balance in the Bank tab.';

export const BANKS: Record<string, BankKind> = {
  Raiffeisen: camt(true),
  UBS: { ...camt(false), note: UNTESTED },
  PostFinance: { ...camt(false), note: UNTESTED },
  ZKB: { ...camt(false), note: UNTESTED },
  Wise: { range: 'bank', statements: 'wise', tested: true },
  PayPal: { range: 'bank', tested: false, note: 'PayPal statements are not imported yet: its payments are booked by hand.' },
  Kreditkarte: { range: 'card', tested: false, note: 'Credit card statements are not imported yet: book the monthly card bill by hand, or pay with a Wise card.' },
};

/** The label of the owner's private payments: never imported from a statement. */
export const MANUAL_BANK = 'manual';

export function bankKind(bank: string): BankKind {
  if (bank === MANUAL_BANK) return { range: 'bank', tested: true };
  return BANKS[bank] ?? { ...camt(false), note: UNTESTED };
}

declare const brand: unique symbol;
/** An IBAN without spaces, upper case, its check digits verified. */
export type Iban = string & { readonly [brand]: 'Iban' };

/** The IBAN in `raw` (spaces allowed, any case), or undefined when it is none (wrong length or check digits). */
export function parseIban(raw: string): Iban | undefined {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return undefined;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1 ? (iban as Iban) : undefined;
}
