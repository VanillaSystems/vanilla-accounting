/**
 * Which bank movement a movement read from a statement PDF is (#254). Pure, shared by the import
 * (src/books/bank-import.ts), the inbox run and the Bank area:
 * - pairUp makes a pair only when each side is the other's best beyond doubt: two equal amounts on
 *   one day follow the counterparty, its IBAN, then the text; a tie stays apart and is asked;
 * - twinQuestions names, for each read movement the bank's file did not take (`unmatched`), the bank
 *   movements it may be: a few days or a few cents off (a fee, a rounding), or its parts summing to
 *   one bank line (a Sammelzahlung) or the other way round (a Wise charge split otherwise). Until the
 *   person answers «Ist das dieselbe Zahlung?», those bank movements are held: no run books them, so
 *   nothing is counted twice.
 */
import { madeByHand } from '../workspace/money-accounts.js';
import type { BankTransaction } from '../types/index.js';

/** How many days a statement row may lie from the day of the same payment elsewhere: a receipt's day, a value date read for the booking day. */
export const MATCH_DAYS = 7;

export const dayGap = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const cents = (x: number) => Math.round(Math.abs(x) * 100);

type Described = Pick<BankTransaction, 'description' | 'counterparty' | 'counterpartyIban' | 'reference'>;

const wordsOf = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
const shares = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

/** How well two descriptions of a payment fit beyond day and amount: the IBAN, the counterparty's words, then the text. */
export function fit(a: Described, b: Described): number {
  const iban = a.counterpartyIban && b.counterpartyIban ? (a.counterpartyIban === b.counterpartyIban ? 4 : -4) : 0;
  const party = a.counterparty && b.counterparty && shares(wordsOf(a.counterparty), wordsOf(b.counterparty)) ? 2 : 0;
  const text = shares(wordsOf(`${a.description ?? ''} ${a.reference ?? ''}`), wordsOf(`${b.description ?? ''} ${b.reference ?? ''} ${b.counterparty ?? ''}`)) ? 1 : 0;
  return iban + party + text;
}

/** Two payments nothing tells apart: whichever is taken, the bookings follow the same payee. */
const alike = (a: Described, b: Described) =>
  (a.counterpartyIban ?? '') === (b.counterpartyIban ?? '') && (a.counterparty ?? '').toLowerCase() === (b.counterparty ?? '').toLowerCase()
  && (a.description ?? '').toLowerCase() === (b.description ?? '').toLowerCase() && (a.reference ?? '') === (b.reference ?? '');

/**
 * Pairs `lines` with `movements` one for one: `cost` is lower for a closer pair and undefined where
 * they cannot be one. A pair is made only when the movement is the line's cheapest and the line the
 * movement's, and no other that differs (alike) costs as much on either side; then the next. What
 * stays apart is a tie or has no partner. Returns line index → movement index.
 */
export function pairUp<L extends Described, T extends Described>(lines: readonly L[], movements: readonly T[], cost: (l: L, t: T) => number | undefined): Map<number, number> {
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  const cheapest = <X extends Described>(items: readonly X[], free: (i: number) => boolean, c: (i: number) => number | undefined): number[] => {
    let min = Infinity;
    let best: number[] = [];
    for (const [i] of items.entries()) {
      if (!free(i)) continue;
      const x = c(i);
      if (x === undefined) continue;
      if (x < min) { min = x; best = [i]; } else if (x === min) best.push(i);
    }
    return best;
  };
  for (let progress = true; progress;) {
    progress = false;
    for (const [i, line] of lines.entries()) {
      if (pairs.has(i)) continue;
      const ts = cheapest(movements, (j) => !taken.has(j), (j) => cost(line, movements[j]));
      if (!ts.length || !ts.every((j) => alike(movements[ts[0]], movements[j]))) continue;
      const t = ts[0];
      const ls = cheapest(lines, (k) => !pairs.has(k), (k) => cost(lines[k], movements[t]));
      if (ls[0] !== i || !ls.every((k) => alike(lines[i], lines[k]))) continue;
      pairs.set(i, t);
      taken.add(t);
      progress = true;
    }
  }
  return pairs;
}

/** The same payment a few days or a little off: a fee or an exchange rounding between what a PDF printed and what the bank booked. */
export const nearAmount = (a: number, b: number): boolean => Math.abs(cents(a) - cents(b)) <= Math.max(50, Math.round(Math.max(cents(a), cents(b)) * 0.01));

/** One answer to «Ist das dieselbe Zahlung?»: the read movements (`pdf`) are the bank's movements (`bank`). */
export interface TwinOption { pdf: string[]; bank: string[] }

type Movement = Pick<BankTransaction, 'ref' | 'bank' | 'currency' | 'date' | 'direction' | 'amount' | 'source' | 'unmatched'>;

/**
 * For each open movement read from a PDF that the bank's file did not take (`unmatched`), the bank
 * movements it may be (#254): open, not booked (`booked`: the refs with an entry), not made by hand,
 * same account and direction, within MATCH_DAYS days; one for one a little off (nearAmount), the
 * read movements of one day summing to one bank line, or two or three bank lines of one day summing
 * to the read one. Closest first. Read movement ref → its options.
 */
export function twinQuestions(transactions: readonly Movement[], booked: ReadonlySet<string>, isClosed: (date: string) => boolean): Map<string, TwinOption[]> {
  const read = transactions.filter((t) => t.unmatched && !isClosed(t.date));
  const bank = transactions.filter((x) => !madeByHand(x) && !x.unmatched && !booked.has(x.ref) && !isClosed(x.date));
  const out = new Map<string, TwinOption[]>();
  for (const p of read) {
    const near = bank.filter((x) => x.bank === p.bank && x.currency === p.currency && x.direction === p.direction && dayGap(x.date, p.date) <= MATCH_DAYS);
    const options: Array<TwinOption & { order: number }> = [];
    for (const x of near) if (nearAmount(x.amount, p.amount)) options.push({ pdf: [p.ref], bank: [x.ref], order: dayGap(x.date, p.date) * 1e6 + Math.abs(cents(x.amount) - cents(p.amount)) });
    const parts = read.filter((q) => q.bank === p.bank && q.currency === p.currency && q.direction === p.direction && q.date === p.date);
    if (parts.length > 1) {
      const sum = parts.reduce((n, q) => n + cents(q.amount), 0);
      for (const x of near) if (cents(x.amount) === sum) options.push({ pdf: parts.map((q) => q.ref), bank: [x.ref], order: dayGap(x.date, p.date) * 1e6 });
    }
    for (const day of new Set(near.map((x) => x.date))) {
      const of = near.filter((x) => x.date === day).slice(0, 12);
      for (const set of subsets(of.length, 3)) {
        if (set.length < 2 || set.reduce((n, i) => n + cents(of[i].amount), 0) !== cents(p.amount)) continue;
        options.push({ pdf: [p.ref], bank: set.map((i) => of[i].ref), order: dayGap(day, p.date) * 1e6 });
      }
    }
    if (options.length) out.set(p.ref, options.sort((a, b) => a.order - b.order).map(({ pdf, bank }) => ({ pdf, bank })));
  }
  return out;
}

/** The index sets of size 1 to `max` of `n` items. */
function subsets(n: number, max: number): number[][] {
  const out: number[][] = [];
  const grow = (from: number, set: number[]) => {
    for (let i = from; i < n; i++) {
      const next = [...set, i];
      out.push(next);
      if (next.length < max) grow(i + 1, next);
    }
  };
  grow(0, []);
  return out;
}

/** The bank movements a question of twinQuestions holds: no run books one until the person answers it. */
export function heldByTwins(books: { transactions: readonly Movement[]; journalEntries: readonly { transactionRef: string }[] }, isClosed: (date: string) => boolean): Set<string> {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  return new Set([...twinQuestions(books.transactions, booked, isClosed).values()].flat().flatMap((o) => o.bank));
}
