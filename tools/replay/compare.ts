/**
 * The replay's comparison of one payment with its answer key (README.md «What counts as right»).
 * Pure: the books are read elsewhere, and what the VAT engine says of a code comes in as `codeKey`.
 *
 * What matters, per payment, judged apart:
 * - its booking: the lines' date, debit account, credit account, VAT code and amount in the books'
 *   currency, to the cent. A negative amount is the same line the other way round. Lines with the
 *   same date, accounts and code are summed first: one line of 100 equals two of 60 and 40. A code
 *   that moves no figure of the return (`codeKey` gives '' for it) equals no code. A line the key
 *   has on this payment that the replay has, the same, under a ref of no payment (a provider's
 *   bill, a report) counts as there, and so the other way round (`elsewhere`, each line once).
 *   Descriptions, exchange rates and who booked it do not count;
 * - its receipt links: the same set of receipts (by id, the hash of the file).
 */
import type { JournalEntry } from '../../src/types/index.js';
import type { Line } from './key.js';

const cents = (n: number) => Math.round(n * 100) / 100;

type EntryLike = Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'amount'>;

/** The line an entry is, its sign folded into its direction, its code as `codeKey` reads it. */
export function lineOf(e: EntryLike, codeKey: (code: string) => string = (c) => c): Line {
  const flip = e.amount < 0;
  const code = (e.vatCode ?? '').trim();
  return {
    date: e.date,
    debit: (flip ? e.accountCredit : e.accountDebit) ?? '',
    credit: (flip ? e.accountDebit : e.accountCredit) ?? '',
    vat: code ? codeKey(code) : '',
    amount: cents(Math.abs(e.amount)),
  };
}

const keyOfLine = (l: Line) => `${l.date}|${l.debit}|${l.credit}|${l.vat}`;

/** The lines summed by date, accounts and code, in a fixed order; a sum of zero is no line. */
export function canonical(entries: readonly EntryLike[], codeKey?: (code: string) => string): Line[] {
  const sums = new Map<string, Line>();
  for (const l of entries.map((e) => lineOf(e, codeKey))) {
    const k = keyOfLine(l);
    const had = sums.get(k);
    sums.set(k, had ? { ...had, amount: cents(had.amount + l.amount) } : l);
  }
  return [...sums.values()].filter((l) => l.amount !== 0).sort((a, b) => keyOfLine(a).localeCompare(keyOfLine(b)) || a.amount - b.amount);
}

export const showLine = (l: Line) => `${l.date} ${l.debit || '-'}/${l.credit || '-'} ${l.vat || 'no code'} ${l.amount.toFixed(2)}`;

/** A line as showLine wrote it (a run's saved diff), read back. */
export function parseLine(shown: string): Line {
  const m = shown.match(/^(\S+) (\S*)\/(\S*) (no code|\S+) (-?[\d.]+)$/);
  if (!m) throw new Error(`not a line: ${shown}`);
  const acct = (a: string) => (a === '-' ? '' : a);
  return { date: m[1], debit: acct(m[2]), credit: acct(m[3]), vat: m[4] === 'no code' ? '' : m[4], amount: Number(m[5]) };
}

/** Lines of refs of no payment, by their shown form, each to be taken once: what a payment's line may be found as elsewhere. */
export class Pool {
  private left = new Map<string, number>();
  constructor(lines: readonly Line[] = []) { for (const l of lines) this.put(l); }
  put(l: Line): void { const k = showLine(l); this.left.set(k, (this.left.get(k) ?? 0) + 1); }
  /** Takes the line when the pool holds it. */
  take(l: Line): boolean {
    const k = showLine(l);
    const n = this.left.get(k) ?? 0;
    if (!n) return false;
    this.left.set(k, n - 1);
    return true;
  }
}

/** How a booking differs from the key's: another account, another VAT code, another amount, or other lines (a split). */
export type WrongKind = 'account' | 'vat' | 'amount' | 'split';
export const WRONG_KINDS: readonly WrongKind[] = ['account', 'vat', 'amount', 'split'];

/** The kinds of difference between the lines one side has and the other lacks. */
export function wrongKinds(app: readonly Line[], key: readonly Line[]): WrongKind[] {
  if (!app.length && !key.length) return [];
  if (app.length !== key.length) return ['split'];
  const order = (ls: readonly Line[]) => [...ls].sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount || keyOfLine(a).localeCompare(keyOfLine(b)));
  const a = order(app);
  const k = order(key);
  const out = new Set<WrongKind>();
  a.forEach((x, i) => {
    const y = k[i];
    if (x.debit !== y.debit || x.credit !== y.credit) out.add('account');
    if (x.vat !== y.vat) out.add('vat');
    if (x.amount !== y.amount || x.date !== y.date) out.add('amount');
  });
  return WRONG_KINDS.filter((w) => out.has(w));
}

export interface Verdict {
  /** The booking lines agree. */
  lines: boolean;
  /** The receipt links agree. */
  links: boolean;
  ok: boolean;
  /** How the booking differs, when it does. */
  wrong?: WrongKind[];
  /** What differs, for the owner's list: the lines and receipts on each side that the other lacks. */
  diff?: { app: string[]; key: string[]; linksApp: string[]; linksKey: string[] };
}

export interface Side {
  entries: readonly EntryLike[];
  receipts: readonly string[];
}

export interface CompareOptions {
  /** A code as the return sees it: '' for one that moves no figure (it then equals no code). */
  codeKey?: (code: string) => string;
  /** The replay's lines of refs of no payment: a key line the payment lacks may be there. */
  appElsewhere?: Pool;
  /** The key's lines of refs of no payment: a replay line the key's payment lacks may be there. */
  keyElsewhere?: Pool;
  /**
   * What lines do to the books and the return (judge.ts): lines that differ but move every account
   * and every figure of the return alike are the same booking, and lines that differ are told apart
   * by what they move otherwise.
   */
  effect?: { same(app: readonly Line[], key: readonly Line[]): boolean; kinds(app: readonly Line[], key: readonly Line[]): WrongKind[] };
}

/** The lines of `a` not in `b`, as a multiset. */
export function minus(a: readonly Line[], b: readonly Line[]): Line[] {
  const left = [...b.map(showLine)];
  return a.filter((l) => { const i = left.indexOf(showLine(l)); if (i < 0) return true; left.splice(i, 1); return false; });
}

/** Lines summed by date, accounts and code once more, after `codeKey` read their codes. */
function resum(lines: readonly Line[], codeKey?: (code: string) => string): Line[] {
  return canonical(lines.map((l) => ({ date: l.date, accountDebit: l.debit, accountCredit: l.credit, vatCode: l.vat, amount: l.amount })), codeKey);
}

/**
 * The lines each side has that the other lacks, codes read by `codeKey`, after what the key has on
 * the payment and the replay has elsewhere (and the other way round) is taken from the pools.
 */
export function settle(app: readonly Line[], key: readonly Line[], opts: CompareOptions = {}): { appOnly: Line[]; keyOnly: Line[] } {
  const a = resum(app, opts.codeKey);
  const k = resum(key, opts.codeKey);
  return { keyOnly: minus(k, a).filter((l) => !opts.appElsewhere?.take(l)), appOnly: minus(a, k).filter((l) => !opts.keyElsewhere?.take(l)) };
}

/** Whether the lines each side has and the other lacks make the same booking, and if not, how they differ. */
export function judgeLines(appOnly: readonly Line[], keyOnly: readonly Line[], opts: CompareOptions = {}): { lines: boolean; wrong?: WrongKind[] } {
  if (!appOnly.length && !keyOnly.length) return { lines: true };
  if (opts.effect?.same(appOnly, keyOnly)) return { lines: true };
  return { lines: false, wrong: opts.effect ? opts.effect.kinds(appOnly, keyOnly) : wrongKinds(appOnly, keyOnly) };
}

export function compare(app: Side, key: Side, opts: CompareOptions = {}): Verdict {
  const { appOnly, keyOnly } = settle(canonical(app.entries), canonical(key.entries), opts);
  const { lines, wrong } = judgeLines(appOnly, keyOnly, opts);
  const ra = new Set(app.receipts);
  const rk = new Set(key.receipts);
  const links = ra.size === rk.size && [...ra].every((r) => rk.has(r));
  if (lines && links) return { lines, links, ok: true };
  return {
    lines, links, ok: false,
    ...(wrong ? { wrong } : {}),
    diff: { app: appOnly.map(showLine), key: keyOnly.map(showLine), linksApp: [...ra].filter((r) => !rk.has(r)), linksKey: [...rk].filter((r) => !ra.has(r)) },
  };
}
