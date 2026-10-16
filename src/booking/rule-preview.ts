/**
 * What a drafted rule would do, before the person keeps it (wishes3-2, wishes3-4): the payments of
 * the open year it holds for, each with the booking it would make and how it is booked today, and
 * the other rules that hold for the same payments. Code, never the model: the card shows this so
 * a rule drafted too wide is seen on the payments it would book.
 */
import { bankAccountFor } from '../accounting/bank-accounts.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import type { Books } from '../books/store.js';
import type { BankTransaction } from '../types/index.js';
import { mappedReceipts, paymentFacts, ruleBookingLines, type ClassifyContext, type RuleLine } from './classify.js';
import type { RuleRow } from './rule-book.js';
import { holds, loneWords, ruleFor, type PlacedRule } from './rules.js';

/** How many matching payments the card names one by one; the rest it counts. */
export const PREVIEW_EXAMPLES = 5;

export interface PreviewPayment {
  ref: string;
  date: string;
  amount: number;
  currency: string;
  direction: BankTransaction['direction'];
  /** The bank's text and, when it names one, the counterparty. */
  text: string;
  /** What the rule would do with it: book these lines, or ask (with the lines it would propose). */
  would: { kind: 'book'; lines: RuleLine[] } | { kind: 'ask'; question: string; lines: RuleLine[] };
  /** Its bookings today, the side opposite the bank (empty: not booked). */
  now: RuleLine[];
  /** Another rule that decides this payment before the drafted one: its id. */
  decidedBy?: string;
}

export interface RuleOverlap {
  /** The other rule, as Firma › Regeln lists it. */
  row: RuleRow;
  /** Payments of the year both hold for. */
  shared: number;
  /** Of those, the payments the other rule decides (it ranks first). */
  theirs: number;
}

export interface RulePreview {
  /** The drafted rule: `${step}#${id}`. */
  key: string;
  /** The year whose payments it was tried on. */
  year: string;
  /** Payments of that year it holds for. */
  matches: number;
  /** The newest of them, at most PREVIEW_EXAMPLES. */
  examples: PreviewPayment[];
  overlaps: RuleOverlap[];
  /** The single words it rests on (loneWords): keeping asks for confirmation. */
  loneWords: string[];
}

/** A rule of the books with the draft applied, and the row it reads as. */
export interface PlacedRow { row: RuleRow; placed: PlacedRule }

export const ruleKey = (r: Pick<RuleRow, 'step' | 'id'>) => `${r.step}#${r.id}`;

/** The open year: the one after the filed quarters, else the year of the newest payment. */
export function openYear(books: Pick<Books, 'config' | 'transactions'>): string {
  const closed = books.config.closedThrough;
  if (closed) return String(new Date(Date.parse(`${closed}T00:00:00Z`) + 86_400_000).getUTCFullYear());
  return books.transactions.map((t) => t.date).sort().at(-1)?.slice(0, 4) ?? String(new Date().getFullYear());
}

/** A payment's bookings today, the side opposite its bank account. */
function bookedNow(books: Books, tx: BankTransaction, bank: string): RuleLine[] {
  return books.journalEntries.filter((e) => e.transactionRef === tx.ref).map((e) => ({
    account: e.accountDebit === bank ? e.accountCredit : e.accountDebit,
    ...(e.vatCode ? { vat: e.vatCode } : {}),
    amount: e.amount,
  }));
}

/**
 * The preview of each rule in `targets` against the books' payments of the open year, with
 * `rules` (every rule of the books, the draft applied) deciding who wins a payment.
 */
export function previewRules(targets: readonly PlacedRow[], rules: readonly PlacedRow[], books: Books, context: ClassifyContext, fx: FxResolver): RulePreview[] {
  const year = openYear(books);
  const txs = books.transactions.filter((t) => t.date.startsWith(year)).sort((a, b) => b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref));
  const on = rules.filter((r) => !r.placed.rule.off);
  const facts = new Map(txs.map((tx) => [tx.ref, paymentFacts(books, tx, context, fx)]));
  return targets.map((target) => {
    const key = ruleKey(target.row);
    const hits = txs.filter((tx) => holds(target.placed, facts.get(tx.ref)!));
    const overlaps = new Map<string, RuleOverlap>();
    const examples: PreviewPayment[] = [];
    const pool = rules.filter((r) => !r.placed.rule.off || ruleKey(r.row) === key);
    // The drafted rule counts as switched on: the preview says what it would do.
    const placed = pool.map((r) => ({ ...r.placed, rule: { ...r.placed.rule, off: false } }));
    for (const tx of hits) {
      const p = facts.get(tx.ref)!;
      const decider = ruleFor(placed, p);
      const deciderRow = decider && pool[placed.indexOf(decider)].row;
      for (const other of on) {
        if (ruleKey(other.row) === key || !holds(other.placed, p)) continue;
        const o = overlaps.get(ruleKey(other.row)) ?? { row: other.row, shared: 0, theirs: 0 };
        o.shared++;
        if (deciderRow && ruleKey(deciderRow) === ruleKey(other.row)) o.theirs++;
        overlaps.set(ruleKey(other.row), o);
      }
      if (examples.length >= PREVIEW_EXAMPLES) continue;
      const t = target.placed.rule.then;
      const lines = t.booking ? ruleBookingLines(tx, t.booking, mappedReceipts(books, tx).some((r) => r.hasSwissVat), context.ownerAccount) : [];
      examples.push({
        ref: tx.ref, date: tx.date, amount: tx.amount, currency: tx.currency, direction: tx.direction,
        text: [tx.description, tx.counterparty && !tx.description.includes(tx.counterparty) ? tx.counterparty : ''].filter(Boolean).join(' · '),
        would: t.kind === 'book' ? { kind: 'book', lines } : { kind: 'ask', question: t.question, lines },
        now: bookedNow(books, tx, bankAccountFor(tx, context.bankAccounts)),
        ...(deciderRow && ruleKey(deciderRow) !== key ? { decidedBy: deciderRow.id } : {}),
      });
    }
    return { key, year, matches: hits.length, examples, overlaps: [...overlaps.values()], loneWords: loneWords(target.placed) };
  });
}
