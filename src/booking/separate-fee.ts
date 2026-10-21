/**
 * A payment whose fee the bank debits as a movement of its own (issue #24): the payment's amount is
 * without the fee, so a fee line on the payment books the fee a second time, beside its own movement,
 * and leaves the expense short by it. Code holds that invariant for any bank, after the model's answer.
 */
import type { ClassifyEntry } from '../llm/prompts.js';
import type { BankTransaction } from '../types/index.js';
import type { ClassifyRefusal } from '../types/api-error.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { lookupVatCode } from '../accounting/vat-codes.js';

/**
 * The fee the bank debited apart from `tx`, as its own movement. The one place that knows how the
 * books link the two (today `type: 'wise-fee'` and the ref `FEE-<ref>`, as the camt053 reader writes it).
 */
export function separateFeeOf(tx: Pick<BankTransaction, 'ref'>, transactions: readonly BankTransaction[]): BankTransaction | undefined {
  return transactions.find((t) => t.type === 'wise-fee' && t.ref === `FEE-${tx.ref}`);
}

export type SeparateFeeCheck =
  | { lines: ClassifyEntry[]; note?: string }
  | { refused: { reason: string; refusal: ClassifyRefusal } };

const money = (currency: string, amount: number) => `${currency} ${amount.toFixed(2)}`;
const taxFree = (code: string | undefined) => !code || lookupVatCode(code)?.entry.rate === 0;

/**
 * The model's lines for `tx` without a line that books its separately debited `fee`: a line of the
 * fee's amount. With one such line, carrying no VAT rate (a fee bears none), and one other line, the
 * fee's amount goes back to that line, so the payment stays whole on its expense, and `note` says so
 * on the booking. Any other shape (a fee line with a rate, two lines of the fee's amount, several
 * lines it could go back to) is the person's to split: refused, nothing booked.
 * A fee in another currency than the payment's leg cannot be told apart by amount: lines unchanged.
 */
export function withoutSeparateFee(tx: BankTransaction, fee: BankTransaction | undefined, lines: ClassifyEntry[]): SeparateFeeCheck {
  if (!fee || fee.currency !== tx.currency || lines.length < 2) return { lines };
  const feeRappen = toRappen(fee.amount);
  const books = lines.filter((l) => !isVatAmountCode(l.vatCode));
  const feeLines = books.filter((l) => toRappen(l.amount) === feeRappen);
  if (!feeLines.length) return { lines };
  const rest = books.filter((l) => !feeLines.includes(l));
  if (feeLines.length === 1 && rest.length === 1 && taxFree(feeLines[0].vatCode)) {
    const [expense] = rest;
    const whole = { ...expense, amount: fromRappen(toRappen(expense.amount) + feeRappen) };
    return {
      lines: lines.filter((l) => l !== feeLines[0]).map((l) => (l === expense ? whole : l)),
      note: `Die Gebühr ${money(fee.currency, fee.amount)} belastet die Bank separat (${fee.ref}) und wird dort gebucht: hier nicht als eigene Zeile, die Zahlung ganz auf ${expense.accountDebit || expense.accountCredit}.`,
    };
  }
  const params = { fee: fee.ref, currency: fee.currency, amount: fee.amount };
  return {
    refused: {
      reason: `Claudes Antwort bucht die Gebühr ${money(fee.currency, fee.amount)} in der Zahlung, die Bank belastet sie aber separat (${fee.ref}): nichts gebucht, die Zahlung bleibt, wie sie war.`,
      refusal: { code: 'classifySeparateFee', params },
    },
  };
}
