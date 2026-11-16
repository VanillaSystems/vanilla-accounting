/**
 * The replay's comparison of one payment with its answer key (README.md «What counts as right»).
 * Pure: the books are read elsewhere.
 *
 * What matters, per payment:
 * - its booking lines: date, debit account, credit account, VAT code and amount in the books'
 *   currency, to the cent. A line with a negative amount is the same line the other way round.
 *   Lines with the same date, accounts and code are summed first, so one line of 100 equals two
 *   of 60 and 40: how the app splits a booking into lines is not what a return or a balance sees.
 *   Descriptions, exchange rates, who booked it and why do not count;
 * - its receipt links: the same set of receipts (by id, the hash of the file).
 */
import type { JournalEntry } from '../../src/types/index.js';
import type { Line } from './key.js';

const cents = (n: number) => Math.round(n * 100) / 100;

/** The line an entry is, its sign folded into its direction. */
export function lineOf(e: Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'amount'>): Line {
  const flip = e.amount < 0;
  return {
    date: e.date,
    debit: (flip ? e.accountCredit : e.accountDebit) ?? '',
    credit: (flip ? e.accountDebit : e.accountCredit) ?? '',
    vat: (e.vatCode ?? '').trim(),
    amount: cents(Math.abs(e.amount)),
  };
}

const keyOfLine = (l: Line) => `${l.date}|${l.debit}|${l.credit}|${l.vat}`;

/** The lines summed by date, accounts and code, in a fixed order; a sum of zero is no line. */
export function canonical(entries: ReadonlyArray<Parameters<typeof lineOf>[0]>): Line[] {
  const sums = new Map<string, Line>();
  for (const l of entries.map(lineOf)) {
    const k = keyOfLine(l);
    const had = sums.get(k);
    sums.set(k, had ? { ...had, amount: cents(had.amount + l.amount) } : l);
  }
  return [...sums.values()].filter((l) => l.amount !== 0).sort((a, b) => keyOfLine(a).localeCompare(keyOfLine(b)) || a.amount - b.amount);
}

export const showLine = (l: Line) => `${l.date} ${l.debit || '-'}/${l.credit || '-'} ${l.vat || 'no code'} ${l.amount.toFixed(2)}`;

export interface Verdict {
  /** The booking lines agree. */
  lines: boolean;
  /** The receipt links agree. */
  links: boolean;
  ok: boolean;
  /** What differs, for the owner's list: the lines and receipts on each side that the other lacks. */
  diff?: { app: string[]; key: string[]; linksApp: string[]; linksKey: string[] };
}

export interface Side {
  entries: ReadonlyArray<Parameters<typeof lineOf>[0]>;
  receipts: readonly string[];
}

export function compare(app: Side, key: Side): Verdict {
  const a = canonical(app.entries).map(showLine);
  const k = canonical(key.entries).map(showLine);
  const lines = a.length === k.length && a.every((x, i) => x === k[i]);
  const ra = new Set(app.receipts);
  const rk = new Set(key.receipts);
  const links = ra.size === rk.size && [...ra].every((r) => rk.has(r));
  if (lines && links) return { lines, links, ok: true };
  return {
    lines, links, ok: false,
    diff: { app: a.filter((x) => !k.includes(x)), key: k.filter((x) => !a.includes(x)), linksApp: [...ra].filter((r) => !rk.has(r)), linksKey: [...rk].filter((r) => !ra.has(r)) },
  };
}
