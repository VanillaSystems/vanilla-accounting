/**
 * «Ist das dieselbe Zahlung?» answered yes (#254, src/books/twins.ts twinsOf): what the books do with a
 * read movement and the bank's movements it is. Pure on the books and the invoice book; the route
 * (src/server/routes/statements.ts) checks the period lock first and saves both.
 */
import { randomBytes } from 'node:crypto';
import type { BankTransaction } from '../types/index.js';
import type { Books } from '../books/store.js';
import { entryToDay, type RateOf } from '../books/bank-import.js';
import type { TwinOption } from '../books/twins.js';
import type { InvoiceBook } from '../invoices/model.js';
import { matchPayments, releasePayment, type PaymentContext, type PaymentOutcome } from '../invoices/payments.js';
import { bookInvoiceEvents } from '../invoices/events.js';
import { baseCurrency } from '../engines/index.js';

/** A person's entry books the read amount while the bank booked another: she changes it first. */
export class TwinBookedByHand extends Error {
  constructor(readonly params: { entry: string; read: number; bank: number; currency: string }) {
    super(`Die Buchung ${params.entry} von Hand bucht ${params.read.toFixed(2)} ${params.currency}; die Bank buchte ${params.bank.toFixed(2)}. Erst die Buchung ändern oder löschen.`);
  }
}

/** The invoices of the books and how their payments are booked, when the firm writes invoices. */
export interface InvoicePayments { book: InvoiceBook; ctx: PaymentContext }

/** Where the difference between a filed read movement and the bank's goes: the account (the year end's exchange difference), and the ledger account of a bank movement. */
export interface Difference { account: string; bankOf: (t: BankTransaction) => string }

const centsOf = (ts: readonly BankTransaction[]) => ts.reduce((n, t) => n + Math.round((t.direction === 'DBIT' ? -t.amount : t.amount) * 100), 0);

/**
 * The read movements of `o` are the bank's movements of `o`. A read movement of a filed period
 * (`o.filed`, booked there) stays as filed: its bank movements are marked as booked there
 * (bookedInFiled), and only what the bank booked beyond the read amount is booked, on the bank's
 * movement and day, against `difference.account` without VAT, so the bank account's ledger meets the
 * bank's balance. Otherwise the receipt links go to the bank's movements. The same amount on one bank
 * movement: the entries and the invoice payments follow too, an entry dated on the read day taking the
 * bank's day and a foreign one the rate of that day (`rateOf`, ADR 0001). Amounts that differ (a fee,
 * a rounding, a split): the invoice payments are released (releasePayment) and the app's other entries
 * go, then the invoices are matched to the bank's movements as an import matches them; the run books
 * the rest afresh. A person's entry refuses the answer (TwinBookedByHand). The read movements leave the
 * books. Each record of a read movement is moved by its own ref: one on a ref no payment has (a leg
 * from before unique refs) is its base's. Returns the invoice PDFs to file.
 */
export function sameAs(books: Books, o: TwinOption, rateOf: RateOf, invoices?: InvoicePayments, difference?: Difference): PaymentOutcome['files'] {
  const read = books.transactions.filter((t) => o.pdf.includes(t.ref));
  const bank = o.bank.map((ref) => books.transactions.find((t) => t.ref === ref)!);
  if (o.filed) {
    const since = new Date().toISOString();
    for (const t of bank) t.waitsForPerson = { since, why: 'filedTwin' };
    const rest = centsOf(bank) - centsOf(read);
    if (rest) books.journalEntries.push(differenceEntry(bank[0], rest / 100, difference!, books, rateOf));
    return [];
  }
  const refs = new Set(books.transactions.map((t) => t.ref));
  const ownerOf = (ref: string) => read.find((t) => t.ref === ref || (!refs.has(ref) && ref.split('~')[0] === t.ref));
  const entries = books.journalEntries.filter((e) => ownerOf(e.transactionRef));
  const whole = bank.length === 1 && centsOf(read) === centsOf(bank);
  const byHand = entries.find((e) => e.origin === 'manual');
  if (!whole && byHand) throw new TwinBookedByHand({ entry: byHand.id, read: centsOf(read) / 100, bank: centsOf(bank) / 100, currency: bank[0].currency });
  const paid = (invoices?.book.invoices ?? []).flatMap((inv) => (inv.status === 'issued' && !inv.deleted ? inv.payments.filter((p) => ownerOf(p.transactionRef)).map((p) => ({ inv, p })) : []));
  const files: PaymentOutcome['files'] = [];
  if (whole) {
    const to = bank[0];
    const days = new Map(books.transactions.map((t) => [t.ref, t.date]));
    for (const e of entries) {
      const from = ownerOf(e.transactionRef)!;
      e.transactionRef = to.ref;
      entryToDay(e, from.date, to.date, days, rateOf);
    }
    for (const { p } of paid) Object.assign(p, { transactionRef: to.ref, date: to.date });
  } else {
    for (const { inv, p } of paid) files.push(...releasePayment(books, invoices!.book, inv.id, p.transactionRef, invoices!.ctx).files);
    books.journalEntries = books.journalEntries.filter((e) => !ownerOf(e.transactionRef));
  }
  const links = books.mappings.filter((m) => ownerOf(m.transactionRef));
  const has = (receiptId: string, transactionRef: string) => books.mappings.some((m) => m.receiptId === receiptId && m.transactionRef === transactionRef);
  books.mappings = books.mappings.filter((m) => !links.includes(m));
  for (const m of links) for (const t of bank) if (!has(m.receiptId, t.ref)) books.mappings.push({ ...m, transactionRef: t.ref });
  books.transactions = books.transactions.filter((t) => !o.pdf.includes(t.ref));
  if (!whole && paid.length && invoices) {
    files.push(...bookInvoiceEvents(books, invoices.book, invoices.ctx).files);
    files.push(...matchPayments(books, invoices.book, invoices.ctx).files);
  }
  return files;
}

/** The bank movement `t`'s amount beyond its filed read twin (`rest`, signed: more money in is positive), a person's entry of the answer. */
function differenceEntry(t: BankTransaction, rest: number, d: Difference, books: Books, rateOf: RateOf) {
  const bank = d.bankOf(t);
  const entry = {
    id: randomBytes(8).toString('hex'), transactionRef: t.ref, date: t.date,
    accountDebit: rest > 0 ? bank : d.account, accountCredit: rest > 0 ? d.account : bank, amount: Math.round(Math.abs(rest) * 100) / 100,
    description: `${t.description}: Differenz zur im abgerechneten Quartal gebuchten Zahlung`, origin: 'manual' as const, by: { kind: 'person' as const, at: new Date().toISOString() },
    ...(t.currency === baseCurrency() ? {} : { exchangeCurrency: t.currency }),
  };
  const rate = entry.exchangeCurrency ? rateOf(entry, new Map(books.transactions.map((x) => [x.ref, x.date]))) : undefined;
  return rate === undefined ? entry : { ...entry, exchangeRate: Math.round(rate * 1e6) / 1e6 };
}
