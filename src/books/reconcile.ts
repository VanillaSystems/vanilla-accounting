/**
 * An account's movements read from statement PDFs set against its bank export or CSV (#254), once and
 * as a whole. A movement can be counted twice only where both sources hold the same days: an account
 * read from PDFs before its first bank export or CSV came, or a PDF read on days next to such a file's.
 * There, code proposes the pairs and the person confirms them in one view (src/server/reconcile.ts
 * applies them); until then no run books any of those movements and no period holding their days
 * closes. Every movement takes part in one reconciliation only, so nothing is guessed line by line
 * afterwards. Pure: the statement files come in as `StatementSides` (src/books/bank-import.ts).
 */
import { madeByHand } from '../workspace/money-accounts.js';
import type { BankTransaction, ReconcilePair, Reconciliation } from '../types/index.js';
import { refuse, type Refused } from '../types/refusal.js';
import { MATCH_DAYS, dayGap, fit, nearAmount, pairUp, sameParty } from './twins.js';

/** What the statement files say of the books' movements: the refs only PDFs bring, those only a bank export or CSV brings, those both bring, and the days each structured file covers. */
export interface StatementSides {
  pdf: ReadonlySet<string>;
  structured: ReadonlySet<string>;
  both: ReadonlySet<string>;
  spans: readonly { account: string; from: string; to: string }[];
}

type Books = { transactions: readonly BankTransaction[]; reconciliations?: Reconciliation[] };

const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
const cents = (x: number) => Math.round(Math.abs(x) * 100);
const named = (t: BankTransaction) => !!t.counterparty || !!t.counterpartyIban;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The reconciliation that waits for the person, per account. */
export const pending = (books: Pick<Books, 'reconciliations'>): Reconciliation[] => (books.reconciliations ?? []).filter((r) => !r.done);

/**
 * Opens, updates or drops each account's waiting reconciliation from the books and the statement
 * files (the statement import, a statement taken back, the inbox run's read step). A movement read from
 * a PDF takes part when no reconciliation took it yet and a structured file of its account covers its
 * day, or holds a movement within MATCH_DAYS days of it (a value date read for the booking day); every
 * bank movement of the account from MATCH_DAYS days before the first of those to MATCH_DAYS days after
 * the last takes part too, open or filed, booked or not. A waiting one whose movements stay the same
 * keeps its day and proposal; one left without a read movement goes. `ledgerOf`: a movement's ledger account.
 */
export function openReconciliations(books: Books, sides: StatementSides, ledgerOf: (t: BankTransaction) => string | undefined, today: string, differenceTo?: string): void {
  const done = (books.reconciliations ?? []).filter((r) => r.done);
  const took = new Set(done.flatMap((r) => [...r.read, ...r.bank, ...(r.same ?? [])]));
  const byAccount = new Map<string, { reads: BankTransaction[]; banks: BankTransaction[]; same: BankTransaction[] }>();
  const of = (account: string) => byAccount.get(account) ?? byAccount.set(account, { reads: [], banks: [], same: [] }).get(account)!;
  for (const t of books.transactions) {
    const account = !madeByHand(t) && !took.has(t.ref) ? ledgerOf(t) : undefined;
    if (!account) continue;
    if (sides.pdf.has(t.ref)) of(account).reads.push(t);
    else if (sides.structured.has(t.ref)) of(account).banks.push(t);
    else if (sides.both.has(t.ref)) of(account).same.push(t);
  }
  const fresh: Reconciliation[] = [];
  for (const [account, { reads, banks, same }] of byAccount) {
    const spans = sides.spans.filter((s) => s.account === account);
    // The days within MATCH_DAYS of a bank movement, once: a read movement on one of them may be it.
    const nearBank = new Set(banks.flatMap((b) => Array.from({ length: 2 * MATCH_DAYS + 1 }, (_, i) => plusDays(b.date, i - MATCH_DAYS))));
    const due = reads.filter((r) => spans.some((s) => r.date >= s.from && r.date <= s.to) || nearBank.has(r.date));
    if (!due.length) continue;
    const days = due.map((r) => r.date).sort();
    const from = plusDays(days[0], -MATCH_DAYS), to = plusDays(days.at(-1)!, MATCH_DAYS);
    const inside = (t: BankTransaction) => t.date >= from && t.date <= to;
    const bank = banks.filter(inside);
    const all = [...due, ...bank, ...same.filter(inside)].map((t) => t.date).sort();
    const was = pending(books).find((r) => r.account === account);
    const read = due.map((t) => t.ref), bankRefs = bank.map((t) => t.ref);
    const kept = was && sameSet(was.read, read) && sameSet(was.bank, bankRefs);
    fresh.push({
      account, from: all[0], to: all.at(-1)!, since: was?.since ?? today, read, bank: bankRefs,
      ...(same.some(inside) ? { same: same.filter(inside).map((t) => t.ref) } : {}),
      pairs: kept ? was.pairs : propose(due, bank),
      ...(differenceTo ? { differenceTo } : {}),
    });
  }
  const next = [...done, ...fresh];
  if (next.length) books.reconciliations = next;
  else delete books.reconciliations;
}

/**
 * The pairs code proposes, each beyond doubt (pairUp): the same day and amount first, then the same
 * amount within MATCH_DAYS days (the payee, then the closest day), then a payee's movement a little off
 * (nearAmount: a fee, a rounding) within those days. Two movements that each name a payee, and not the
 * same one, are never proposed. Every movement it leaves apart is the person's to name: a payment of its
 * own, or the same as another.
 */
export function propose(reads: readonly BankTransaction[], banks: readonly BankTransaction[]): ReconcilePair[] {
  const pairs: ReconcilePair[] = [];
  const rounds: Array<(r: BankTransaction, b: BankTransaction) => number | undefined> = [
    (r, b) => (r.date === b.date && cents(r.amount) === cents(b.amount) ? -fit(r, b) : undefined),
    (r, b) => (cents(r.amount) === cents(b.amount) && dayGap(r.date, b.date) <= MATCH_DAYS ? dayGap(r.date, b.date) - 10 * fit(r, b) : undefined),
    (r, b) => (nearAmount(r.amount, b.amount) && sameParty(r, b) && dayGap(r.date, b.date) <= MATCH_DAYS ? dayGap(r.date, b.date) * 1000 + Math.abs(cents(r.amount) - cents(b.amount)) : undefined),
  ];
  let left = [...reads], free = [...banks];
  for (const cost of rounds) {
    const made = pairUp(left, free, (r, b) => (r.direction === b.direction && r.currency === b.currency && !(named(r) && named(b) && !sameParty(r, b)) ? cost(r, b) : undefined));
    for (const [i, j] of made) pairs.push({ read: left[i].ref, bank: free[j].ref });
    const takenBanks = new Set(made.values());
    left = left.filter((_, i) => !made.has(i));
    free = free.filter((_, j) => !takenBanks.has(j));
  }
  return pairs;
}

/** The movements no run books (#254): those of a reconciliation that waits for the person. */
export const heldByReconciliation = (books: Pick<Books, 'reconciliations'>): Set<string> => new Set(pending(books).flatMap((r) => [...r.read, ...r.bank]));

/** The waiting reconciliation a movement takes part in. */
export const reconciliationOf = (books: Pick<Books, 'reconciliations'>, ref: string): Reconciliation | undefined => pending(books).find((r) => r.read.includes(ref) || r.bank.includes(ref));

/** The refusal naming a waiting reconciliation, and a bank movement of it where it is answered (the Bank area shows it on that movement's statement). */
export function reconcileRefusal(r: Reconciliation, through?: string): Refused {
  const payment = r.bank[0] ?? r.read[0];
  return refuse('reconcilePending', { account: r.account, from: r.from, to: r.to, payment, date: r.to, ...(through ? { through } : {}) },
    `account ${r.account}: the movements read from statement PDFs from ${r.from} to ${r.to} wait for the reconciliation with the bank's file; confirm it in Bank › Kontoauszüge before ${through ? `the books close through ${through}` : 'booking them'}`);
}

/** Whether closing the books through `end` waits for a reconciliation (#254): one whose first day lies on or before `end`. */
export function reconcilePendingThrough(books: Pick<Books, 'reconciliations'>, end: string): Refused | undefined {
  const r = pending(books).filter((x) => x.from <= end).sort((a, b) => a.from.localeCompare(b.from))[0];
  return r ? reconcileRefusal(r, end) : undefined;
}
