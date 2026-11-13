/**
 * The VAT of a drafted rule that names none (F05): code decides it from the receipts of the payments
 * the rule holds for, never the model. Only a receipt shows a rate (AGENTS.md § VAT code rules), so
 * the receipts decide: all at one rate, the rule books at that rate (none with Swiss VAT: the zero
 * rate); receipts at different rates, or none, and the card asks the person once, with the rates
 * to choose from, «no Swiss VAT» first and no rate as if it were the answer. A firm that claims no
 * input tax books such a purchase without a code, and so does a rule on an account that takes no
 * VAT code at all (takesNoCode) or for wages, unasked (#383). Pure.
 */
import type { Receipt } from '../types/index.js';
import { chart, invoiceRates, setup, withoutInputTax } from '../engines/index.js';
import { receiptRate } from '../accounting/correction.js';
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { isUnreadable } from '../accounting/receipt-due.js';

/** A rate the receipts show, and on how many of them. */
export interface RateSeen { rate: number; receipts: number }

/** What code does with the missing VAT: write it (`fill`, as `then.vat` takes it), or ask with `choices` (percent, 0: no Swiss VAT). */
export type RuleVat =
  | { kind: 'fill'; vat: number | 'none' }
  | { kind: 'ask'; seen: RateSeen[]; choices: number[] };

type VatFacts = Pick<Receipt, 'kind' | 'vatBy' | 'hasSwissVat' | 'vatSummary' | 'needsVisionReview' | 'vatExtractedAt'>;

/** The rate one receipt shows: its Swiss VAT rate, 0 when it was read and shows none; undefined when it decides nothing (unread, a copy, a sales record). */
export function rateShown(r: VatFacts): number | undefined {
  if (!isPurchaseDocument(r) || isUnreadable(r)) return undefined;
  if (r.hasSwissVat) return receiptRate([r]);
  return r.hasSwissVat === false || r.vatSummary?.length ? 0 : undefined;
}

/**
 * Whether a booking on `account` carries no VAT code, unless a receipt shows Swiss VAT: the
 * jurisdiction's wage account and the employer's contributions (setup.yaml `wages`: no supply), and
 * its bank-charges account (setup.yaml `bankCharges`, #359), each while the firm's own account of that
 * number is an expense account (`typeOf`, the firm's chart), a debt, or an account that only settles
 * (`settles`: the owner's account, a money account; receipt-wait.ts settlementAccount).
 */
export function takesNoCode(account: string, settles: (account: string) => boolean = () => false, typeOf: (account: string) => string | undefined = (a) => chart().typeOf(a)): boolean {
  const { wages, bankCharges } = setup();
  const named = account === wages?.account || !!wages?.contributions?.includes(account) || account === bankCharges?.account;
  return (named && typeOf(account) === 'expense') || typeOf(account) === 'liability' || settles(account);
}

/**
 * The rule's VAT, given the account it books on and the receipts linked to the payments it holds
 * for. `noCode`: the account takes none (takesNoCode), or every payment the rule holds for is a
 * wage: then it books without a code, unless a receipt shows Swiss VAT, which wins and is asked about.
 */
export function ruleVatOf(account: string, receipts: readonly VatFacts[], noCode = false): RuleVat {
  const without = withoutInputTax();
  const purchase = chart().typeOf(account) === 'expense' || chart().typeOf(account) === 'asset';
  if (without === 'none' || (without === 'net-rate' && purchase)) return { kind: 'fill', vat: 'none' };
  const seen = new Map<number, number>();
  for (const r of receipts) { const rate = rateShown(r); if (rate !== undefined) seen.set(rate, (seen.get(rate) ?? 0) + 1); }
  const charged = [...seen.keys()].some((rate) => rate > 0);
  if (noCode && !charged) return { kind: 'fill', vat: 'none' };
  if (seen.size === 1 && !noCode) return { kind: 'fill', vat: [...seen.keys()][0] };
  // No Swiss VAT first, then the rates: no rate stands first as if it were the answer (#383).
  const choices = [0, ...[...new Set(invoiceRates())].filter((r) => r > 0).sort((a, b) => b - a)];
  return { kind: 'ask', seen: [...seen].map(([rate, n]) => ({ rate, receipts: n })).sort((a, b) => b.receipts - a.receipts || b.rate - a.rate), choices };
}
