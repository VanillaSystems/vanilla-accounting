/**
 * Whether a movement read from a statement PDF and a bank movement may be one payment (#254). Pure,
 * shared by the import (src/books/bank-import.ts) and the reconciliation's proposal (src/books/reconcile.ts):
 * - pairUp makes a pair only when each side is the other's best beyond doubt: two equal amounts on
 *   one day follow the counterparty, its IBAN, then the text; a tie stays apart;
 * - nearAmount and sameParty say whether two movements may be one payment a little off.
 */
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

/**
 * Whether a payment counts as booked, `bookedOn` saying whether a ref's own entries book it: by its own
 * ref, or by its base's (`X~1` on `X`, books from before unique legs). The one rule of the year close
 * (src/accounting/year-close.ts) and the reconciliation (src/books/reconcile.ts bookedRefs).
 */
export const bookedWithBase = (ref: string, bookedOn: (ref: string) => boolean): boolean => bookedOn(ref) || bookedOn(ref.split('~')[0]);

/** A bank movement the person paired with a movement read from a PDF of a filed period, booked there (#254): no run books it, the year counts it as booked, and a booking by hand asks first. */
export const bookedInFiled = (t: Pick<BankTransaction, 'waitsForPerson'>): boolean => t.waitsForPerson?.why === 'filedTwin';

type Movement = Pick<BankTransaction, 'description'> & Partial<Pick<BankTransaction, 'counterparty' | 'counterpartyIban' | 'reference' | 'parts'>>;

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
