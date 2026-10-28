/**
 * Which bank movement a movement read from a statement PDF is (#254). Pure, shared by the import
 * (src/books/bank-import.ts), the runs, the server and the Bank area:
 * - pairUp makes a pair only when each side is the other's best beyond doubt: two equal amounts on
 *   one day follow the counterparty, its IBAN, then the text; a tie stays apart and is asked;
 * - twinsOf names, for each read movement, the bank movements it may be: a few days or a few cents off
 *   (a fee, a rounding), or its parts summing to one bank line (a Sammelzahlung) or the other way round
 *   (a Wise charge split otherwise). Derived from the books each time, never stored: until the person
 *   answers «Ist das dieselbe Zahlung?», those bank movements are held, so nothing is counted twice.
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

/** One answer to «Ist das dieselbe Zahlung?»: the read movements (`pdf`) are the bank's movements (`bank`). `filed`: the read side lies in a filed period and is booked there, so «Ja, dieselbe» marks the bank's movements as booked there and books only a difference. */
export interface TwinOption { pdf: string[]; bank: string[]; filed?: true }

type Movement = Pick<BankTransaction, 'ref' | 'bank' | 'currency' | 'date' | 'direction' | 'amount' | 'source' | 'unmatched' | 'waitsForPerson' | 'description'> & Partial<Pick<BankTransaction, 'counterparty' | 'counterpartyIban' | 'reference' | 'parts'>>;

/** A bank movement a person said is a movement read from a PDF of a filed period, booked there (#254): no run books it, the year counts it as booked, and a booking by hand asks first. */
export const bookedInFiled = (t: Pick<BankTransaction, 'waitsForPerson'>): boolean => t.waitsForPerson?.why === 'filedTwin';

/** The filed movement a bank movement marked bookedInFiled is, for naming it: of its account and direction, a little off, within MATCH_DAYS days; its payee first, then the closest. */
export function filedTwinOf<T extends Movement>(transactions: readonly T[], t: Movement, isClosed: (date: string) => boolean): T | undefined {
  const order = (x: Movement) => (sameParty(x, t) ? 0 : 1e9) + dayGap(x.date, t.date) * 1e6 + Math.abs(cents(x.amount) - cents(t.amount));
  return transactions.filter((x) => x.ref !== t.ref && isClosed(x.date) && x.bank === t.bank && x.currency === t.currency && x.direction === t.direction
    && dayGap(x.date, t.date) <= MATCH_DAYS && nearAmount(x.amount, t.amount)).sort((a, b) => order(a) - order(b))[0];
}

/** The words that name nobody: a bank's own words in every payment's text, a legal form. */
const GENERIC = new Set(['zahlung', 'gutschrift', 'belastung', 'lastschrift', 'einkauf', 'karte', 'debit', 'kredit', 'transfer', 'payment', 'rechnung', 'auftrag', 'dauerauftrag', 'ebanking', 'twint', 'card', 'transaction', 'purchase', 'online', 'gmbh', 'sàrl', 'ltd', 'inc']);
const nameWords = (text: string) => new Set([...wordsOf(text)].filter((w) => !GENERIC.has(w)));

/**
 * Whether two movements name the same payee: their IBANs when both have one (different IBANs are
 * different payees), else the counterparty's name in the other's counterparty or text (a PDF often
 * prints the name in the text). A bank line's parts (a Sammelzahlung) name its payees too.
 */
export const sameParty = (a: Movement, b: Movement): boolean => partiesMatch(partyOf(a), partyOf(b));

/** What names a movement's payee: its IBAN, the words of each name it gives, and every word that may name one. */
interface Party { iban?: string; names: Set<string>[]; there: Set<string> }

function partyOf(x: Movement): Party {
  const names = [x.counterparty, ...(x.parts ?? []).map((p) => p.counterparty)].filter((s): s is string => !!s);
  return { iban: x.counterpartyIban, names: names.map(nameWords), there: nameWords(`${names.join(' ')} ${x.description} ${x.reference ?? ''}`) };
}

function partiesMatch(a: Party, b: Party): boolean {
  if (a.iban && b.iban) return a.iban === b.iban;
  return a.names.some((n) => shares(n, b.there)) || b.names.some((n) => shares(n, a.there));
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

const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
const keyOf = (t: Movement) => `${t.bank}\u0000${t.currency}\u0000${t.direction}`;
const push = <T>(m: Map<string, T[]>, key: string, x: T) => (m.get(key) ?? m.set(key, []).get(key)!).push(x);

/** The first index of `sorted` (by day) whose day is `day` or later. */
function firstFrom(sorted: readonly Movement[], day: string): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].date < day) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The questions «Ist das dieselbe Zahlung?» of the books, and the bank movements they hold (twinsOf). */
export interface Twins {
  /** Read movement ref → its options, closest first. */
  questions: Map<string, TwinOption[]>;
  /** Bank movement ref → the read movement whose question holds it: no run books it until the person answers. */
  holds: Map<string, string>;
}

/**
 * «Ist das dieselbe Zahlung?» (#254), derived from the books each time, never stored. A movement read
 * from a statement PDF (`fromPdf`: the refs only a read statement brings, src/books/bank-import.ts
 * readFromPdfs; or one a bank file's import kept as its own, `unmatched`) asks about the bank movements
 * it may be: open, not booked (`booked`: the refs with an entry), not made by hand, not answered
 * already (bookedInFiled), same account and direction, within MATCH_DAYS days, whatever days the
 * bank's file covers. One for one, exact or a little off (nearAmount): those of the same payee
 * (sameParty), else only the closest; one of another IBAN never. The read movements of one day summing
 * to one bank line, or two or three bank lines of one day summing to the read one: only of the same
 * payee. Closest first. A read movement of a filed period asks only when it is booked there (`filed`):
 * unbooked, the bank's movement is simply the one to book.
 */
export function twinsOf(transactions: readonly Movement[], booked: ReadonlySet<string>, isClosed: (date: string) => boolean, fromPdf: ReadonlySet<string>): Twins {
  const isRead = (t: Movement) => !!t.unmatched || fromPdf.has(t.ref);
  const parties = new Map<Movement, Party>();
  const party = (x: Movement) => parties.get(x) ?? parties.set(x, partyOf(x)).get(x)!;
  const same = (a: Movement, b: Movement) => partiesMatch(party(a), party(b));
  const hasEntry = (t: Movement) => booked.has(t.ref) || booked.has(t.ref.split('~')[0]);
  // A filed read movement whose days either way are all filed has no open bank movement to name.
  const read = transactions.filter((t) => isRead(t) && (!isClosed(t.date) || (hasEntry(t) && !isClosed(plusDays(t.date, MATCH_DAYS)))));
  const banks = new Map<string, Movement[]>();
  for (const x of transactions) if (!madeByHand(x) && !isRead(x) && !booked.has(x.ref) && !isClosed(x.date) && !bookedInFiled(x)) push(banks, keyOf(x), x);
  for (const list of banks.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sameDay = new Map<string, Movement[]>();
  for (const q of read) push(sameDay, `${keyOf(q)}\u0000${q.date}`, q);
  const questions = new Map<string, TwinOption[]>();
  for (const p of read) {
    const list = banks.get(keyOf(p)) ?? [];
    const last = plusDays(p.date, MATCH_DAYS);
    const near: Movement[] = [];
    for (let i = firstFrom(list, plusDays(p.date, -MATCH_DAYS)); i < list.length && list[i].date <= last; i++) near.push(list[i]);
    if (!near.length) continue;
    const filed = isClosed(p.date) ? { filed: true as const } : {};
    const order = (x: Movement) => dayGap(x.date, p.date) * 1e6 + Math.abs(cents(x.amount) - cents(p.amount));
    const options: Array<TwinOption & { order: number }> = [];
    const ones = near.filter((x) => nearAmount(x.amount, p.amount) && !(x.counterpartyIban && p.counterpartyIban && x.counterpartyIban !== p.counterpartyIban));
    const own = ones.filter((x) => same(p, x));
    const closest = Math.min(...ones.map(order));
    for (const x of own.length ? own : ones.filter((y) => order(y) === closest)) options.push({ pdf: [p.ref], bank: [x.ref], ...filed, order: order(x) });
    const parts = sameDay.get(`${keyOf(p)}\u0000${p.date}`)!;
    if (parts.length > 1) {
      const sum = parts.reduce((n, q) => n + cents(q.amount), 0);
      for (const x of near) if (cents(x.amount) === sum && parts.every((q) => same(q, x))) options.push({ pdf: parts.map((q) => q.ref), bank: [x.ref], ...filed, order: dayGap(x.date, p.date) * 1e6 });
    }
    const mine = near.filter((x) => same(p, x));
    for (const day of new Set(mine.map((x) => x.date))) {
      const of = mine.filter((x) => x.date === day);
      for (const set of sumsTo(of, cents(p.amount))) options.push({ pdf: [p.ref], bank: set.map((i) => of[i].ref), ...filed, order: dayGap(day, p.date) * 1e6 });
    }
    if (options.length) questions.set(p.ref, options.sort((a, b) => a.order - b.order).map(({ order: _, ...o }) => o));
  }
  const holds = new Map<string, string>();
  for (const [ref, options] of questions) for (const o of options) for (const b of o.bank) if (!holds.has(b)) holds.set(b, ref);
  return { questions, holds };
}

type TwinBooks = { transactions: readonly Movement[]; journalEntries: readonly { transactionRef: string }[] };

/** twinsOf on the books, their bookings as `booked`. */
export const twinsIn = (books: TwinBooks, isClosed: (date: string) => boolean, fromPdf: ReadonlySet<string>): Twins =>
  twinsOf(books.transactions, new Set(books.journalEntries.map((e) => e.transactionRef)), isClosed, fromPdf);

/** The bank movements no run books (#254): those a question holds, and those booked in a filed quarter as a read movement (bookedInFiled). */
export function heldByTwins(books: TwinBooks, isClosed: (date: string) => boolean, fromPdf: ReadonlySet<string>): Set<string> {
  return new Set([...twinsIn(books, isClosed, fromPdf).holds.keys(), ...books.transactions.filter(bookedInFiled).map((t) => t.ref)]);
}

/**
 * Whether closing the books through `end` waits for «Ist das dieselbe Zahlung?» (#254): a question
 * naming a movement dated on or before `end` (its answer may change an entry of those days, and a bank
 * movement held there unanswered would never be booked). The refusal, naming the bank movement where
 * the first question is answered; undefined when nothing waits.
 */
export function twinsOpenThrough(books: TwinBooks, end: string, isClosed: (date: string) => boolean, fromPdf: ReadonlySet<string>): Refused | undefined {
  const days = new Map(books.transactions.map((t) => [t.ref, t.date]));
  const open = [...twinsIn(books, isClosed, fromPdf).questions].filter(([, options]) => options.some((o) => [...o.pdf, ...o.bank].some((r) => (days.get(r) ?? '9999') <= end)));
  if (!open.length) return undefined;
  const refs = open.map(([ref]) => ref);
  const payment = open[0][1][0].bank[0];
  return refuse('twinsOpen', { through: end, n: String(refs.length), payments: refs.slice(0, 5).join(', '), payment, date: days.get(payment) ?? end },
    `${refs.length} movement(s) read from a statement PDF wait for «Ist das dieselbe Zahlung?» on days through ${end} (${refs.slice(0, 5).join(', ')}${refs.length > 5 ? ', …' : ''}): answer them at the bank's movement ${payment} before the books close`);
}
