/**
 * The sign of a VAT code follows the money (r7h-22, r9h-11): the accounts of a line say whether it
 * is a purchase or a sale, or money coming back on one. Hand edits refuse the wrong sign
 * (src/server/edits.ts assertCodeSign); the classifier turns the model's code to it.
 */
import { chart } from '../engines/index.js';

/**
 * The sign a code must carry on this line, when the accounts say so (r7h-22): a purchase code (M,
 * I) on a line that credits an expense is a refund or a supplier's credit note and carries the
 * minus (-M81); a sales code (V) on a line that debits revenue is a customer refund (-V81). The
 * plain code there would claim input tax on money received, or declare turnover on money paid out.
 * Undefined when the accounts give no direction: a correction on one account, a VAT-only leg
 * (M81-2), Bezugsteuer, an export code, two balance-sheet accounts. A negative `amount` turns
 * the money around (a refund line of a payout report the model writes as -40 on 1020/3400).
 * `bank`: the account the payment moved, where it is known (#288). Between it and an asset, its
 * side gives the direction: money in on 1020/1540 is a returned purchase (-I81), money out a purchase.
 */
export function codeSignFor(code: string | undefined, debitAccount: string | undefined, creditAccount: string | undefined, amount = 0, bank?: string): string | undefined {
  const m = /^(-?)([MIV])(\d+)$/.exec(code ?? '');
  const [accountDebit, accountCredit] = amount < 0 ? [creditAccount, debitAccount] : [debitAccount, creditAccount];
  if (!m || !accountDebit || !accountCredit || accountDebit === accountCredit) return undefined;
  const side = m[2] === 'V' ? 'revenue' : 'expense';
  const debit = chart().typeOf(accountDebit) === side;
  const credit = chart().typeOf(accountCredit) === side;
  if (debit === credit) return m[2] === 'V' ? undefined : bankSign(m[2], m[3], accountDebit, accountCredit, bank);
  const back = m[2] === 'V' ? debit : credit;
  return `${back ? '-' : ''}${m[2]}${m[3]}`;
}

function bankSign(family: string, rate: string, accountDebit: string, accountCredit: string, bank: string | undefined): string | undefined {
  const other = accountDebit === bank ? accountCredit : accountCredit === bank ? accountDebit : undefined;
  if (!other || chart().typeOf(other) !== 'asset') return undefined;
  return `${accountDebit === bank ? '-' : ''}${family}${rate}`;
}

