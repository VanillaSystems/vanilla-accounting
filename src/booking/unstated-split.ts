/**
 * A split nobody can derive is a question, not a guess (#362, first-ai-28): the model booked a
 * social-insurance payment 996.07 / 894.28 «nach dem Verhältnis des Beispielfalls». A model's
 * answer that spreads one payment over several accounts is booked only when its parts are stated:
 * by the payment's own text, by a linked receipt (its total, its VAT lines, its items, the amounts
 * its text shows), one line at most being the rest. Otherwise the payment waits for the person
 * with the model's lines as the proposal (src/booking/classify.ts, the ask workflow).
 * A company rule's split (`private:`) never comes here: code books it.
 */
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';

/** The rule id an unstated split's question is held by: no rule of a file, the app's own check. */
export const UNSTATED_SPLIT = 'app-split-unstated';

/** The question the person is asked, in the app's words. */
export const UNSTATED_SPLIT_QUESTION = 'Stimmt diese Aufteilung? Weder die Zahlung noch ein Beleg nennt die Beträge der Teile; der Vorschlag ist eine Schätzung der KI.';

const NUMBER = /\d{1,3}(?:['’’ ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

/** The amounts a text shows: «1'230.00», «1230,5», «894.28». */
export function amountsIn(text: string | undefined): number[] {
  return (text ?? '').match(NUMBER)?.map((s) => Number(s.replace(/['’’ ]/g, '').replace(',', '.'))).filter((n) => Number.isFinite(n) && n > 0) ?? [];
}

/** Every amount the payment and its linked receipts state. */
export function statedAmounts(tx: Pick<BankTransaction, 'amount' | 'description' | 'reference' | 'parts'>, receipts: readonly Pick<Receipt, 'amount' | 'vatSummary' | 'lineItems' | 'extractedText'>[]): number[] {
  const out = [tx.amount, ...amountsIn(tx.description), ...amountsIn(tx.reference)];
  // A collective payment's parts, as the bank lists them.
  for (const p of tx.parts ?? []) out.push(p.amount, ...amountsIn(p.reference));
  for (const r of receipts) {
    if (r.amount) out.push(r.amount);
    for (const g of r.vatSummary ?? []) out.push(...[g.gross, g.net, g.vat].filter((n): n is number => typeof n === 'number'));
    const items = r.lineItems ?? [];
    out.push(...items.map((i) => i.gross));
    // A line may hold the items of one account or one rate together.
    for (const key of ['suggestedAccount', 'ratePercent'] as const) {
      const sums = new Map<unknown, number>();
      for (const i of items) if (i[key] !== undefined) sums.set(i[key], (sums.get(i[key]) ?? 0) + i.gross);
      out.push(...sums.values());
    }
    out.push(...amountsIn(r.extractedText));
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.015;

/**
 * The lines of a model's answer for `tx` whose amounts nothing states, when they spread the payment
 * over two or more accounts and more than one of them is unstated (one line may be the rest).
 * Undefined: the answer may be booked. Lines without the bank on one side (a tax-only line, a
 * reclassification) are no part of the split. `owner`: a share on the owner's account at a whole
 * percent of the payment is a stated share (a decision of the firm names it so).
 */
export function unstatedSplit(tx: BankTransaction, entries: readonly JournalEntry[], receipts: readonly Receipt[], bankAccount: string, owner?: string): JournalEntry[] | undefined {
  const lines = entries.filter((e) => e.accountDebit && e.accountCredit && (e.accountDebit === bankAccount || e.accountCredit === bankAccount));
  const accounts = new Set(lines.map((e) => (e.accountDebit === bankAccount ? e.accountCredit : e.accountDebit)));
  if (accounts.size < 2) return undefined;
  const stated = statedAmounts(tx, receipts);
  const whole = lines.reduce((s, e) => s + e.amount, 0);
  const native = (e: JournalEntry) => (e.exchangeRate ? e.amount / e.exchangeRate : e.amount);
  const unstated = lines.filter((e) => {
    if (stated.some((n) => near(n, e.amount) || near(n, native(e)))) return false;
    const other = e.accountDebit === bankAccount ? e.accountCredit : e.accountDebit;
    if (owner && other === owner && whole > 0) {
      const percent = (e.amount / whole) * 100;
      if (Math.abs(percent - Math.round(percent)) * whole / 100 < 0.015) return false;
    }
    return true;
  });
  return unstated.length > 1 ? unstated : undefined;
}
