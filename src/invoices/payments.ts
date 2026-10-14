/**
 * Paid invoices found by their reference (ADR 0010). On camt.053 import, before anything else
 * books a transaction, each incoming payment whose QR or creditor reference belongs to an issued
 * invoice is allocated to it, and its revenue is booked from the invoice's own lines with their VAT
 * codes (cash basis: when the money arrives), with the invoice PDF as the entry's receipt.
 *
 * Idempotent: an allocation is recorded once per transaction, a transaction with entries is not
 * booked again, a receipt and its link are added once. A payment without a reference is never
 * booked by itself; `paymentProposals` offers it (amount, customer, date) for a person to confirm.
 */
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';
import { periodLock, type Books } from '../books/store.js';
import { bankAccountFor } from '../accounting/bank-accounts.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { InvoiceBook, Issued, PaymentAllocation } from './model.js';
import { parseReference } from '../providers/qr-bill/reference.js';
import { allocate, liveInvoices, openAmount, openFees, revenueSplit, totals, withPayment } from './rules.js';
import { TEXTS } from './texts.js';
import { idSource } from './store.js';
import { baseCurrency } from '../engines/index.js';

export interface PaymentContext {
  bankAccounts: readonly LedgerBankAccount[];
  revenueAccount: string;
  feeAccount?: string;
  fx: Pick<FxResolver, 'daily'>;
  /** The invoice PDF's bytes (from its stored file). */
  pdfOf(inv: Issued): Buffer;
  receiptId(pdf: Buffer): string;
  /** When the invoice PDF of a payment is indexed as its receipt (ISO): now, on import. */
  indexedAt(tx: BankTransaction): string;
}

/** A payment that names an invoice but cannot be booked by rule: a person decides. */
export interface PaymentQuestion {
  transactionRef: string;
  number: string;
  problem: 'cancelled' | 'currency' | 'surplus' | 'batch' | 'booked' | 'closed';
  amount: number;
}

/** What the import does with the payments: invoices' new allocations, the books' new entries, receipts and links, and the PDFs to file as receipts. */
export interface PaymentOutcome {
  /** Payments allocated or booked by this run. */
  paid: Array<{ transactionRef: string; number: string; amount: number; fee: number; booked: boolean }>;
  questions: PaymentQuestion[];
  /** receipts/<filename> to write with these bytes (the invoice PDF), when not there yet. */
  files: Array<{ filename: string; pdf: Buffer }>;
}

interface Hit { inv: Issued; amount: number }

/** The parts of a transaction that carry a structured reference, each with the issued invoice it names. */
function hitsOf(tx: BankTransaction, byRef: Map<string, Issued>): Array<Hit | undefined> {
  const parts = tx.parts?.length ? tx.parts.map((p) => ({ reference: p.reference, amount: p.amount })) : [{ reference: tx.reference, amount: tx.amount }];
  return parts.map((p) => {
    const ref = p.reference ? parseReference(p.reference) : undefined;
    const inv = ref ? byRef.get(ref.reference) : undefined;
    return inv ? { inv, amount: p.amount } : undefined;
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Matches the open period's incoming payments to issued invoices by reference, records the
 * allocations in `book` and books the revenue into `books` (call inside the write door, update in src/books/store.ts).
 */
export function matchPayments(books: Books, book: InvoiceBook, ctx: PaymentContext): PaymentOutcome {
  const out: PaymentOutcome = { paid: [], questions: [], files: [] };
  const lock = periodLock(books);
  const byRef = new Map(liveInvoices(book).filter((i): i is Issued => i.status === 'issued' && i.kind === 'invoice').map((i) => [i.reference, i]));
  if (byRef.size === 0) return out;
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));

  for (const tx of books.transactions) {
    if (tx.direction !== 'CRDT') continue;
    const hits = hitsOf(tx, byRef);
    if (!hits.some(Boolean)) continue;
    const ask = (h: Hit, problem: PaymentQuestion['problem']) => out.questions.push({ transactionRef: tx.ref, number: h.inv.number, problem, amount: h.amount });
    if (lock.isClosed(tx.date)) { for (const h of hits) if (h) ask(h, 'closed'); continue; }

    const allocations: Array<{ inv: Issued; a: PaymentAllocation; known?: true }> = [];
    let bookable = hits.every(Boolean);
    for (const h of hits) {
      if (!h) continue;
      const inv = current(book, h.inv.id);
      if (inv.cancelled) { ask(h, 'cancelled'); bookable = false; continue; }
      if (inv.currency !== tx.currency) { ask(h, 'currency'); bookable = false; continue; }
      const known = inv.payments.find((p) => p.transactionRef === tx.ref);
      if (known) { allocations.push({ inv, a: known, known: true }); continue; }
      const split = allocate(inv, liveInvoices(book), h.amount, tx.date);
      if (split.surplus > 0) { ask(h, 'surplus'); bookable = false; continue; }
      const a: PaymentAllocation = { transactionRef: tx.ref, date: tx.date, amount: split.amount, ...(split.fee ? { fee: split.fee } : {}), by: 'reference' };
      replace(book, withPayment(inv, a));
      allocations.push({ inv: current(book, inv.id), a });
    }
    if (hits.some((h) => !h) && allocations.length) for (const { inv, a } of allocations) out.questions.push({ transactionRef: tx.ref, number: inv.number, problem: 'batch', amount: a.amount });

    const alreadyBooked = booked.has(tx.ref);
    if (alreadyBooked && !books.mappings.some((m) => m.transactionRef === tx.ref && m.rule === 'invoice-reference')) {
      for (const { inv, a } of allocations) out.questions.push({ transactionRef: tx.ref, number: inv.number, problem: 'booked', amount: a.amount });
    }
    const toBook = bookable && !alreadyBooked && allocations.length > 0;
    if (toBook) {
      for (const { inv, a } of allocations) bookPayment(books, tx, inv, a, ctx, out);
      booked.add(tx.ref);
    }
    for (const { inv, a, known } of allocations) {
      if (!known || toBook) out.paid.push({ transactionRef: tx.ref, number: inv.number, amount: a.amount, fee: a.fee ?? 0, booked: toBook });
    }
  }
  return out;
}

const current = (book: InvoiceBook, id: string) => book.invoices.find((i) => i.id === id) as Issued;
function replace(book: InvoiceBook, inv: Issued): void {
  book.invoices[book.invoices.findIndex((i) => i.id === inv.id)] = inv;
}

/** The revenue of one allocation as journal entries, the invoice PDF as their receipt. */
export function bookPayment(books: Books, tx: BankTransaction, inv: Issued, a: PaymentAllocation, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>): JournalEntry[] {
  const bank = bankAccountFor(tx, ctx.bankAccounts);
  const rate = tx.currency === baseCurrency() ? undefined : ctx.fx.daily(tx.currency, tx.date);
  if (tx.currency !== baseCurrency() && rate === undefined) throw new Error(`Kein ESTV-Kurs ${tx.currency} für ${tx.date}: npm run fetch-rates`);
  const text = `${TEXTS.de.invoice} ${inv.number} ${inv.customer.name}`;
  const legs = [
    ...revenueSplit(inv, a.amount, ctx.revenueAccount),
    ...(a.fee ? [{ account: ctx.feeAccount ?? ctx.revenueAccount, amount: a.fee, vatCode: undefined }] : []),
  ];
  const entries: JournalEntry[] = legs.map((l) => ({
    id: idSource.bytes(8).toString('hex'),
    transactionRef: tx.ref,
    date: tx.date,
    accountDebit: bank,
    accountCredit: l.account,
    amount: l.amount,
    ...(l.vatCode ? { vatCode: l.vatCode } : {}),
    description: l.vatCode ? text : `${text}, ${TEXTS.de.fee}`,
    ...(rate !== undefined ? { exchangeCurrency: tx.currency, exchangeRate: rate } : {}),
    origin: 'invoice',
  }));
  books.journalEntries.push(...entries);

  const pdf = ctx.pdfOf(inv);
  const id = ctx.receiptId(pdf);
  if (!books.receipts.some((r) => r.id === id)) {
    const filename = `${inv.date.replace(/-/g, '')}-${TEXTS.de.invoice.toLowerCase()}-${inv.number}.pdf`;
    const t = totals(inv.lines);
    const receipt: Receipt = {
      id,
      filename,
      originalFilename: filename,
      extractedText: [inv.sender.name, `${TEXTS.de.invoice} ${inv.number}`, inv.customer.name, ...inv.lines.map((l) => l.text), `Total ${inv.currency} ${t.gross.toFixed(2)}`].join('\n'),
      extractionMethod: 'pdftotext',
      fileSize: pdf.length,
      indexedAt: ctx.indexedAt(tx),
      location: 'archived',
      date: inv.date,
      description: text,
      amount: t.gross,
      currency: inv.currency,
      vatId: inv.sender.uid,
      hasSwissVat: t.vat > 0,
      vatSummary: t.byRate.map((r) => ({ ratePercent: r.rate, net: r.net, vat: r.vat, gross: r.gross })),
      kind: 'sales-record',
    };
    books.receipts.push(receipt);
    out.files.push({ filename, pdf });
  }
  const link: Mapping = { transactionRef: tx.ref, receiptId: id, by: 'rule', rule: 'invoice-reference' };
  if (!books.mappings.some((m) => m.transactionRef === tx.ref && m.receiptId === id)) books.mappings.push(link);
  return entries;
}

/** An incoming payment without a usable reference that could pay an open invoice: same currency, the open amount, on or after the invoice date. */
export interface PaymentProposal {
  transactionRef: string;
  date: string;
  amount: number;
  currency: string;
  payer: string;
  invoiceId: string;
  number: string;
  customerName: string;
  /** The payer's name contains the customer's. */
  nameMatches: boolean;
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export function paymentProposals(books: Books, book: InvoiceBook): PaymentProposal[] {
  const lock = periodLock(books);
  const invoices = liveInvoices(book);
  const open = invoices.filter((i): i is Issued => i.status === 'issued' && i.kind === 'invoice' && !i.cancelled && openAmount(i, invoices) > 0);
  const references = new Set(invoices.flatMap((i) => (i.status === 'issued' ? [i.reference] : [])));
  const allocated = new Set(invoices.flatMap((i) => (i.status === 'issued' ? i.payments.map((p) => p.transactionRef) : [])));
  const booked = new Set(books.journalEntries.filter((e) => e.origin !== 'classify').map((e) => e.transactionRef));
  const out: PaymentProposal[] = [];
  for (const tx of books.transactions) {
    if (tx.direction !== 'CRDT' || lock.isClosed(tx.date) || allocated.has(tx.ref) || booked.has(tx.ref)) continue;
    const refs = [tx.reference, ...(tx.parts ?? []).map((p) => p.reference)].map((r) => (r ? parseReference(r)?.reference : undefined));
    if (refs.some((r) => r && references.has(r))) continue;
    const payer = [tx.description, ...(tx.parts ?? []).map((p) => p.counterparty)].join(' ');
    for (const inv of open) {
      const due = r2(openAmount(inv, invoices) + openFees(inv));
      if (inv.currency !== tx.currency || tx.date < inv.date || (tx.amount !== openAmount(inv, invoices) && tx.amount !== due)) continue;
      const name = words(inv.customer.name);
      out.push({
        transactionRef: tx.ref, date: tx.date, amount: tx.amount, currency: tx.currency, payer, invoiceId: inv.id, number: inv.number,
        customerName: inv.customer.name, nameMatches: name.length > 0 && name.some((w) => words(payer).includes(w)),
      });
    }
  }
  return out.sort((a, b) => Number(b.nameMatches) - Number(a.nameMatches) || a.date.localeCompare(b.date));
}

/**
 * A person confirms that `tx` pays `inv`: the allocation is recorded and the revenue booked from
 * the invoice. Entries the classifier wrote for the transaction are replaced; any other entry refuses.
 */
export function confirmPayment(books: Books, book: InvoiceBook, invoiceId: string, transactionRef: string, ctx: PaymentContext): PaymentOutcome {
  const out: PaymentOutcome = { paid: [], questions: [], files: [] };
  const tx = books.transactions.find((t) => t.ref === transactionRef);
  const inv = liveInvoices(book).find((i): i is Issued => i.id === invoiceId && i.status === 'issued');
  if (!tx || tx.direction !== 'CRDT') throw new PaymentError('Keine eingehende Zahlung mit dieser Referenz.');
  if (!inv || inv.kind !== 'invoice') throw new PaymentError('Keine ausgestellte Rechnung mit dieser Id.');
  if (inv.cancelled) throw new PaymentError(`Rechnung ${inv.number} ist storniert.`);
  if (inv.currency !== tx.currency) throw new PaymentError(`Rechnung ${inv.number} ist in ${inv.currency}, die Zahlung in ${tx.currency}.`);
  if (inv.payments.some((p) => p.transactionRef === tx.ref)) throw new PaymentError(`Die Zahlung ist Rechnung ${inv.number} schon zugeordnet.`);
  const others = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
  if (others.some((e) => e.origin !== 'classify')) throw new PaymentError('Die Zahlung ist schon von Hand gebucht; diese Buchungen zuerst löschen.');
  const split = allocate(inv, liveInvoices(book), tx.amount, tx.date);
  if (split.surplus > 0) throw new PaymentError(`Die Zahlung ist ${tx.currency} ${split.surplus.toFixed(2)} höher als offen.`);
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
  const a: PaymentAllocation = { transactionRef: tx.ref, date: tx.date, amount: split.amount, ...(split.fee ? { fee: split.fee } : {}), by: 'confirmed' };
  replace(book, withPayment(inv, a));
  bookPayment(books, tx, inv, a, ctx, out);
  out.paid.push({ transactionRef: tx.ref, number: inv.number, amount: a.amount, fee: a.fee ?? 0, booked: true });
  return out;
}

export class PaymentError extends Error {}
