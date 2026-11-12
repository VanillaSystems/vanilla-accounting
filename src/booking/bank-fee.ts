/**
 * The bank's own fee row of a statement is booked by code, as a payment provider's payout is (#359):
 * bank / the jurisdiction's bank-charges account (setup.yaml `bankCharges`), without a VAT code, since
 * a bank's services for the account and for payments are exempt without credit and carry no input
 * tax. Only a row the bank itself coded as such a charge (src/books/bank-import.ts bankCodedFee): a
 * row the reader marks `bank-fee` only because the creditor is the bank's name may be a loan's
 * amortisation or a mortgage's interest, and goes to the model or the person as before. A company
 * rule that matches the row decides it first (src/booking/classify.ts); a workspace names another
 * account by such a rule, or by its overlay of the module's setup.yaml. A chart without the account
 * as an expense account books nothing.
 */
import type { BankTransaction } from '../types/index.js';
import { setup } from '../engines/index.js';
import { loadChart } from '../workspace/chart.js';

/** The account the bank's fee rows go on, or the one the firm's chart lacks; undefined when the jurisdiction names none. */
export type BankCharges = { account: string } | { missing: { account: string; name: string } };

/**
 * Whether code books `tx` as the bank's own fee row: marked so by the reader, and coded so by the
 * bank (`coded`). The fee of another payment (`wise-fee`) belongs with that payment: not here.
 */
export const isOwnBankFee = (tx: BankTransaction, coded: ((tx: BankTransaction) => boolean) | undefined): boolean => tx.type === 'bank-fee' && !!coded?.(tx);

/**
 * The account the bank's fee rows are booked on, when the firm's chart (`accounts`) has it as an
 * expense account; else the account the jurisdiction names, with its name in the jurisdiction's
 * chart, as what is missing (a firm whose number is something else gets no fees on it).
 */
export function bankChargesOf(accounts: ReadonlyArray<{ number: string; type?: string }>): BankCharges | undefined {
  const account = setup().bankCharges?.account;
  if (!account) return undefined;
  if (accounts.some((a) => a.number === account && a.type === 'expense')) return { account };
  return { missing: { account, name: loadChart().accounts.find((a) => a.number === account)?.name ?? '' } };
}
