/**
 * An account's reconciliation confirmed (#254, src/books/reconcile.ts): what the books do with each
 * pair the person confirmed, and with every movement she named a payment of its own. Pure on the
 * books and the invoice book; the route (src/server/routes/statements.ts) checks the period lock first
 * and saves both.
 */
import { randomBytes } from 'node:crypto';
import type { BankTransaction, ReconcilePair, Reconciliation } from '../types/index.js';
import type { Books } from '../books/store.js';
import { entryToDay, type RateOf } from '../books/bank-import.js';
import type { InvoiceBook } from '../invoices/model.js';
import { matchPayments, releasePayment, type PaymentContext, type PaymentOutcome } from '../invoices/payments.js';
import { bookInvoiceEvents } from '../invoices/events.js';
import { baseCurrency } from '../engines/index.js';
import { covers } from '../books/reconcile.js';

/** Why a confirmation is refused, with the API's code and its parameters (src/types/api-error.ts). */
export class ReconcileRefused extends Error {
  constructor(readonly status: number, readonly code: 'reconcileUndecided' | 'reconcileTwice' | 'reconcileDifference' | 'reconcileMismatch' | 'reconcileNotCovered' | 'twinBookedByHand' | 'gone', readonly params: Record<string, unknown>, message: string) {
    super(message);
  }
}

/** The invoices of the books and how their payments are booked, when the firm writes invoices. */
export interface InvoicePayments { book: InvoiceBook; ctx: PaymentContext }

/** What a confirmation needs besides the books: the rate of a foreign entry's day, the period lock, the chart, a bank movement's ledger account, today. */
export interface ConfirmContext {
  rateOf: RateOf;
  isClosed: (date: string) => boolean;
  chart: ReadonlySet<string>;
  bankOf: (t: BankTransaction) => string;
  today: string;
  invoices?: InvoicePayments;
}

/** What the person decided: the pairs, and the movements read from PDFs that are payments of their own. */
export interface Decision { pairs: ReconcilePair[]; own: string[] }

const centsOf = (ts: readonly BankTransaction[]) => ts.reduce((n, t) => n + Math.round((t.direction === 'DBIT' ? -t.amount : t.amount) * 100), 0);

/**
 * Confirms the waiting reconciliation `r`. Every movement read from a PDF on a day the bank files cover
 * must be named once: paired with one bank movement of its direction and currency, or a payment of its
 * own. A candidate on another day may only be paired: left apart, it stays as it is for the bank file
 * that covers its day. A bank movement is paired once at most; every other stays free, booked as any.
 * A pair:
 * - read in a filed period and booked there: the filed side stays as filed; the bank's movement is
 *   marked as booked there (`filedTwin`), and only what the bank booked beyond the read amount is booked,
 *   on its day, to the account the person names (the year end's exchange difference proposed), which
 *   must be in the chart. Read there and not booked: the bank's movement is simply booked.
 * - read in the open period: the bank's movement takes its place. Its receipt links go over; for the
 *   same amount, while the bank's movement has no entry, its entries and invoice payments too (an entry
 *   on the read day takes the bank's day, a foreign one that day's rate). Otherwise the invoice payments
 *   are released and the app's entries go, and the invoices are matched again; a person's entry refuses.
 *   A bank movement of a filed period takes nothing (it is booked there as filed): the read movement's
 *   entries and links go with it. The read movement leaves the books, and its row in the read statement
 *   brings nothing again (src/books/bank-import.ts mergeIndex, by the confirmed pairs).
 * Returns the invoice PDFs to file.
 */
export function confirm(books: Books, r: Reconciliation, d: Decision, ctx: ConfirmContext): PaymentOutcome['files'] {
  const named = [...d.pairs.map((p) => p.read), ...d.own];
  const twice = [...named, ...d.pairs.map((p) => p.bank)].find((ref, i, all) => all.indexOf(ref) !== i);
  if (twice) throw new ReconcileRefused(400, 'reconcileTwice', { ref: twice }, `${twice} is named twice`);
  const stranger = [...named.filter((ref) => !r.read.includes(ref)), ...d.pairs.map((p) => p.bank).filter((ref) => !r.bank.includes(ref))][0];
  if (stranger) throw new ReconcileRefused(400, 'reconcileTwice', { ref: stranger }, `${stranger} takes no part in this reconciliation`);
  const tx = (ref: string) => {
    const t = books.transactions.find((x) => x.ref === ref);
    if (!t) throw new ReconcileRefused(409, 'gone', { what: 'payment' }, `${ref} is no longer in the books`);
    return t;
  };
  const elsewhere = d.own.map(tx).find((t) => !covers(r, t.date));
  if (elsewhere) throw new ReconcileRefused(400, 'reconcileNotCovered', { ref: elsewhere.ref, date: elsewhere.date }, `${elsewhere.ref} lies on ${elsewhere.date}, a day no bank file of the account covers: it is the same as a bank movement or stays as it is until one does`);
  const undecided = r.read.filter((ref) => !named.includes(ref) && covers(r, tx(ref).date));
  if (undecided.length) throw new ReconcileRefused(400, 'reconcileUndecided', { n: undecided.length }, `${undecided.length} movement(s) read from PDFs are neither paired nor a payment of their own: ${undecided.join(', ')}`);
  const pairs = d.pairs.map((p) => ({ p, read: tx(p.read), bank: tx(p.bank) }));
  const odd = pairs.find(({ read, bank }) => read.direction !== bank.direction || read.currency !== bank.currency);
  if (odd) throw new ReconcileRefused(400, 'reconcileMismatch', { read: odd.read.ref, bank: odd.bank.ref }, `${odd.read.ref} and ${odd.bank.ref} differ in direction or currency: they are not one payment`);
  const refs = new Set(books.transactions.map((t) => t.ref));
  // An entry on a ref no payment has (a leg from before unique refs) is its base's.
  const ownerOf = (ref: string, read: BankTransaction) => ref === read.ref || (!refs.has(ref) && ref.split('~')[0] === read.ref);
  const entriesOf = (read: BankTransaction) => books.journalEntries.filter((e) => ownerOf(e.transactionRef, read));
  const files: PaymentOutcome['files'] = [];
  let released = false;
  const since = new Date().toISOString();
  const kept: ReconcilePair[] = [];
  for (const { p, read, bank } of pairs) {
    const rest = centsOf([bank]) - centsOf([read]);
    if (ctx.isClosed(read.date)) {
      // Unbooked there, or the bank's movement filed too: nothing filed changes, and the bank's is booked as any.
      if (!entriesOf(read).length || ctx.isClosed(bank.date)) { kept.push({ read: p.read, bank: p.bank }); continue; }
      const account = p.account ?? r.differenceTo;
      if (rest && (!account || !ctx.chart.has(account))) throw new ReconcileRefused(400, 'reconcileDifference', { read: read.ref, amount: Math.abs(rest) / 100, currency: bank.currency }, `the difference of ${(Math.abs(rest) / 100).toFixed(2)} ${bank.currency} between ${read.ref} and ${bank.ref} needs an account of the chart`);
      bank.waitsForPerson = { since, why: 'filedTwin', read: read.ref };
      if (rest) books.journalEntries.push(differenceEntry(bank, rest / 100, account!, ctx, books));
      kept.push({ read: p.read, bank: p.bank, ...(rest ? { account } : {}) });
      continue;
    }
    const entries = entriesOf(read);
    const bankFiled = ctx.isClosed(bank.date);
    const follows = !rest && !bankFiled && !books.journalEntries.some((e) => e.transactionRef === bank.ref);
    const byHand = entries.find((e) => e.origin === 'manual');
    if (!follows && byHand) throw new ReconcileRefused(409, 'twinBookedByHand', { entry: byHand.id, read: centsOf([read]) / 100, bank: centsOf([bank]) / 100, currency: bank.currency }, `${byHand.id} was booked by hand on ${read.ref}; change it first`);
    const paid = (ctx.invoices?.book.invoices ?? []).flatMap((inv) => (inv.status === 'issued' && !inv.deleted ? inv.payments.filter((x) => ownerOf(x.transactionRef, read)).map((x) => ({ inv, x })) : []));
    if (follows) {
      const days = new Map(books.transactions.map((t) => [t.ref, t.date]));
      for (const e of entries) {
        e.transactionRef = bank.ref;
        entryToDay(e, read.date, bank.date, days, ctx.rateOf);
      }
      for (const { x } of paid) Object.assign(x, { transactionRef: bank.ref, date: bank.date });
    } else {
      for (const { inv, x } of paid) files.push(...releasePayment(books, ctx.invoices!.book, inv.id, x.transactionRef, ctx.invoices!.ctx).files);
      released ||= paid.length > 0;
      books.journalEntries = books.journalEntries.filter((e) => !ownerOf(e.transactionRef, read));
    }
    const links = books.mappings.filter((m) => ownerOf(m.transactionRef, read));
    books.mappings = books.mappings.filter((m) => !links.includes(m));
    if (!bankFiled) for (const m of links) if (!books.mappings.some((x) => x.receiptId === m.receiptId && x.transactionRef === bank.ref)) books.mappings.push({ ...m, transactionRef: bank.ref });
    books.transactions = books.transactions.filter((t) => t !== read);
    kept.push({ read: p.read, bank: p.bank });
  }
  // Confirmed before the invoices are matched again: its movements are held no longer.
  Object.assign(r, { pairs: kept, ...(d.own.length ? { own: d.own } : {}), done: ctx.today });
  if (released && ctx.invoices) {
    files.push(...bookInvoiceEvents(books, ctx.invoices.book, ctx.invoices.ctx).files);
    files.push(...matchPayments(books, ctx.invoices.book, ctx.invoices.ctx).files);
  }
  return files;
}

/** The bank movement `t`'s amount beyond its filed read twin (`rest`, signed: more money in is positive), a person's entry of the answer. */
function differenceEntry(t: BankTransaction, rest: number, account: string, ctx: ConfirmContext, books: Books) {
  const bank = ctx.bankOf(t);
  const entry = {
    id: randomBytes(8).toString('hex'), transactionRef: t.ref, date: t.date,
    accountDebit: rest > 0 ? bank : account, accountCredit: rest > 0 ? account : bank, amount: Math.round(Math.abs(rest) * 100) / 100,
    description: `${t.description}: Differenz zur im abgerechneten Quartal gebuchten Zahlung`, origin: 'manual' as const, by: { kind: 'person' as const, at: new Date().toISOString() },
    ...(t.currency === baseCurrency() ? {} : { exchangeCurrency: t.currency }),
  };
  const rate = entry.exchangeCurrency ? ctx.rateOf(entry, new Map(books.transactions.map((x) => [x.ref, x.date]))) : undefined;
  return rate === undefined ? entry : { ...entry, exchangeRate: Math.round(rate * 1e6) / 1e6 };
}
