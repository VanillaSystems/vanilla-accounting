/**
 * The bank's own fee row of a statement (`type: 'bank-fee'`: its fee for the account itself, of no
 * other party, as the statement reader marks it) is booked by code, as a payment provider's payout is
 * (#359): bank / the jurisdiction's bank-charges account (setup.yaml `bankCharges`), without a VAT
 * code, since a bank's services are exempt without credit and carry no input tax. A company rule that
 * matches the row decides it first (src/booking/classify.ts); a workspace names another account by
 * such a rule, or by its overlay of the module's setup.yaml. A chart without the account books nothing.
 */
import type { BankTransaction } from '../types/index.js';
import { setup } from '../engines/index.js';
import { loadChart } from '../workspace/chart.js';

/** Whether code books `tx` as the bank's own fee row. The fee of another payment (`wise-fee`) belongs with that payment: not here. */
export const isOwnBankFee = (tx: Pick<BankTransaction, 'type'>): boolean => tx.type === 'bank-fee';

/**
 * The account the bank's fee rows are booked on, when the firm's chart (`chart`: its numbers) has
 * it; else the account the jurisdiction names, with its name in the jurisdiction's chart, as what is
 * missing. Undefined when the jurisdiction names none.
 */
export function bankChargesOf(chart: ReadonlySet<string> | ReadonlyMap<string, string>): { account: string } | { missing: { account: string; name: string } } | undefined {
  const account = setup().bankCharges?.account;
  if (!account) return undefined;
  if (chart.has(account)) return { account };
  return { missing: { account, name: loadChart().accounts.find((a) => a.number === account)?.name ?? '' } };
}
