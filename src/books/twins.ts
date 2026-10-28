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
import { refuse, type Refused } from '../types/refusal.js';

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

/** One answer to «Ist das dieselbe Zahlung?»: the read movements (`pdf`) are the bank's movements (`bank`). `filed`: the read side lies in a filed period, so «Ja, dieselbe» books nothing and marks the bank's movements as booked there. */
export interface TwinOption { pdf: string[]; bank: string[]; filed?: true }

type Movement = Pick<BankTransaction, 'ref' | 'bank' | 'currency' | 'date' | 'direction' | 'amount' | 'source' | 'unmatched' | 'waitsForPerson' | 'description'> & Partial<Pick<BankTransaction, 'counterparty' | 'counterpartyIban' | 'reference' | 'parts'>>;

/** A bank movement a person said is a filed read movement, or the import found to be one (#254): booked in the filed quarter, so no run books it and no question offers it again. */
export const bookedInFiled = (t: Pick<BankTransaction, 'waitsForPerson'>): boolean => t.waitsForPerson?.why === 'filedTwin';

/** The words that name nobody: a bank's own words in every payment's text, a legal form. */
const GENERIC = new Set(['zahlung', 'gutschrift', 'belastung', 'lastschrift', 'einkauf', 'karte', 'debit', 'kredit', 'transfer', 'payment', 'rechnung', 'auftrag', 'dauerauftrag', 'ebanking', 'twint', 'card', 'transaction', 'purchase', 'online', 'gmbh', 'sàrl', 'ltd', 'inc']);
const nameWords = (text: string) => new Set([...wordsOf(text)].filter((w) => !GENERIC.has(w)));

/**
 * Whether two movements name the same payee: their IBANs when both have one (different IBANs are
 * different payees), else the counterparty's name in the other's counterparty or text (a PDF often
 * prints the name in the text). A bank line's parts (a Sammelzahlung) name its payees too.
 */
export function sameParty(a: Movement, b: Movement): boolean {
  if (a.counterpartyIban && b.counterpartyIban) return a.counterpartyIban === b.counterpartyIban;
  const names = (x: Movement) => [x.counterparty, ...(x.parts ?? []).map((p) => p.counterparty)].filter((s): s is string => !!s);
  const named = (x: Movement, y: Movement) => {
    const there = nameWords(`${names(y).join(' ')} ${y.description} ${y.reference ?? ''}`);
    return names(x).some((name) => shares(nameWords(name), there));
  };
  return named(a, b) || named(b, a);
}

/** The sets of two or three of `items` whose amounts sum to `target` cents exactly, as index sets, each once. */
function sumsTo(items: readonly { amount: number }[], target: number): number[][] {
  const out: number[][] = [];
  const at = new Map<number, number[]>();
  for (const [i, x] of items.entries()) (at.get(cents(x.amount)) ?? at.set(cents(x.amount), []).get(cents(x.amount))!).push(i);
  for (let i = 0; i < items.length; i++) {
    for (const k of at.get(target - cents(items[i].amount)) ?? []) if (k > i) out.push([i, k]);
    for (let j = i + 1; j < items.length; j++) {
      for (const k of at.get(target - cents(items[i].amount) - cents(items[j].amount)) ?? []) if (k > j) out.push([i, j, k]);
    }
  }
  return out;
}

/**
 * For each movement read from a PDF that the bank's file did not take (`unmatched`), the bank
 * movements it may be (#254): open, not booked (`booked`: the refs with an entry), not made by hand,
 * not answered already (bookedInFiled), same account and direction, within MATCH_DAYS days. One for
 * one a little off (nearAmount): those of the same payee (sameParty), else only the closest; one of
 * another IBAN never. The read movements of one day summing to one bank line, or two or three bank
 * lines of one day summing to the read one: only of the same payee. Closest first. A read movement
 * of a filed period is asked too (`filed`): its bank twin in the open period would count it twice.
 * Read movement ref → its options.
 */
export function twinQuestions(transactions: readonly Movement[], booked: ReadonlySet<string>, isClosed: (date: string) => boolean): Map<string, TwinOption[]> {
  const read = transactions.filter((t) => t.unmatched);
  const bank = transactions.filter((x) => !madeByHand(x) && !x.unmatched && !booked.has(x.ref) && !isClosed(x.date) && !bookedInFiled(x));
  const out = new Map<string, TwinOption[]>();
  for (const p of read) {
    const filed = isClosed(p.date) ? { filed: true as const } : {};
    const near = bank.filter((x) => x.bank === p.bank && x.currency === p.currency && x.direction === p.direction && dayGap(x.date, p.date) <= MATCH_DAYS);
    const order = (x: Movement) => dayGap(x.date, p.date) * 1e6 + Math.abs(cents(x.amount) - cents(p.amount));
    const options: Array<TwinOption & { order: number }> = [];
    const ones = near.filter((x) => nearAmount(x.amount, p.amount) && !(x.counterpartyIban && p.counterpartyIban && x.counterpartyIban !== p.counterpartyIban));
    const own = ones.filter((x) => sameParty(p, x));
    const closest = Math.min(...ones.map(order));
    for (const x of own.length ? own : ones.filter((y) => order(y) === closest)) options.push({ pdf: [p.ref], bank: [x.ref], ...filed, order: order(x) });
    const parts = read.filter((q) => q.bank === p.bank && q.currency === p.currency && q.direction === p.direction && q.date === p.date);
    if (parts.length > 1) {
      const sum = parts.reduce((n, q) => n + cents(q.amount), 0);
      for (const x of near) if (cents(x.amount) === sum && parts.every((q) => sameParty(q, x))) options.push({ pdf: parts.map((q) => q.ref), bank: [x.ref], ...filed, order: dayGap(x.date, p.date) * 1e6 });
    }
    const mine = near.filter((x) => sameParty(p, x));
    for (const day of new Set(mine.map((x) => x.date))) {
      const of = mine.filter((x) => x.date === day);
      for (const set of sumsTo(of, cents(p.amount))) options.push({ pdf: [p.ref], bank: set.map((i) => of[i].ref), ...filed, order: dayGap(day, p.date) * 1e6 });
    }
    if (options.length) out.set(p.ref, options.sort((a, b) => a.order - b.order).map(({ order: _, ...o }) => o));
  }
  return out;
}

type TwinBooks = { transactions: readonly Movement[]; journalEntries: readonly { transactionRef: string }[] };

/** The bank movements a question of twinQuestions holds, each with the read movement that asks: no run books one until the person answers. */
export function twinHolds(books: TwinBooks, isClosed: (date: string) => boolean): Map<string, string> {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const out = new Map<string, string>();
  for (const [read, options] of twinQuestions(books.transactions, booked, isClosed)) for (const o of options) for (const ref of o.bank) if (!out.has(ref)) out.set(ref, read);
  return out;
}

/** The bank movements no run books (#254): those a question holds (twinHolds), and those booked in a filed quarter as a read movement (bookedInFiled). */
export function heldByTwins(books: TwinBooks, isClosed: (date: string) => boolean): Set<string> {
  return new Set([...twinHolds(books, isClosed).keys(), ...books.transactions.filter(bookedInFiled).map((t) => t.ref)]);
}

/**
 * The read movements whose question «Ist das dieselbe Zahlung?» names a movement dated on or before
 * `end` (#254): closing the books through `end` waits for their answer, since an answer may change an
 * entry of those days, and a bank movement held there unanswered would never be booked.
 */
export function twinsOpenThrough(books: TwinBooks, end: string, isClosed: (date: string) => boolean): string[] {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const days = new Map(books.transactions.map((t) => [t.ref, t.date]));
  return [...twinQuestions(books.transactions, booked, isClosed)]
    .filter(([, options]) => options.some((o) => [...o.pdf, ...o.bank].some((r) => (days.get(r) ?? '9999') <= end)))
    .map(([ref]) => ref);
}

/** The refusal of a close through `through` while `refs` wait for «Ist das dieselbe Zahlung?»: the first five named, with how many. */
export const twinsOpen = (through: string, refs: readonly string[]): Refused =>
  refuse('twinsOpen', { through, n: String(refs.length), payments: refs.slice(0, 5).join(', ') }, `${refs.length} movement(s) read from a statement PDF wait for «Ist das dieselbe Zahlung?» on days through ${through} (${refs.slice(0, 5).join(', ')}${refs.length > 5 ? ', …' : ''}): answer them before the books close`);
