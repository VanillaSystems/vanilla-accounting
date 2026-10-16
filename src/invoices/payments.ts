/**
 * Paid invoices and refunded credit notes, found by rule (ADR 0010). On camt.053 import, before
 * anything else books a transaction, each payment that names an issued document is allocated to it
 * and booked from the document's own lines with their VAT codes (cash basis: when the money moves),
 * with the document's PDF as the entry's receipt:
 * - an incoming payment with an invoice's QR or creditor reference;
 * - an incoming payment whose remittance text names one open invoice's number and pays what it owes;
 * - an outgoing payment whose text names one credit note's number and pays back what it still owes
 *   (booked with the minus code: the revenue and its VAT go down).
 * A booking the classifier made for such a payment is replaced; anything else booked keeps it and asks.
 *
 * Idempotent: an allocation is recorded once per transaction, a transaction with entries is not
 * booked again, a receipt and its link are added once. Anything less certain is never booked by
 * itself; `paymentProposals` offers it (amount, customer, date) for a person to confirm.
 */
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';
import { periodLock, type Books } from '../books/store.js';
import { bankAccountFor } from '../accounting/bank-accounts.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { InvoiceBook, Issued, PaymentAllocation } from './model.js';
import { parseReference } from '../providers/qr-bill/reference.js';
import { allocate, liveInvoices, namesNumber, openAmount, openFees, refundDue, revenueSplit, totals, withPayment } from './rules.js';
import { TEXTS } from './texts.js';
import { idSource } from './store.js';
import { baseCurrency, vat } from '../engines/index.js';

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

interface Hit { inv: Issued; amount: number; by: 'reference' | 'number' }

/** The direction money moves for a document: in for an invoice, out for a credit note's refund. */
const directionOf = (inv: Issued): BankTransaction['direction'] => (inv.kind === 'credit-note' ? 'DBIT' : 'CRDT');

/** What a document is still owed or owes back, reminder fees included: what a payment naming it must match. */
const dueOf = (inv: Issued, book: InvoiceBook): number[] => {
  const invoices = liveInvoices(book);
  if (inv.kind === 'credit-note') return [refundDue(inv, invoices)];
  const open = openAmount(inv, invoices);
  return [open, r2(open + openFees(inv))];
};

/** The texts of a transaction's parts (one part when it is a single payment) and their amounts. */
const partsOf = (tx: BankTransaction) => (tx.parts?.length
  ? tx.parts.map((p) => ({ reference: p.reference, text: p.reference ?? '', amount: p.amount }))
  : [{ reference: tx.reference, text: [tx.description, tx.reference].filter(Boolean).join(' '), amount: tx.amount }]);

/**
 * Each part of a transaction with the issued document it pays: an invoice by its structured
 * reference, else the one open document whose number the text names and whose open amount the part pays.
 */
function hitsOf(tx: BankTransaction, byRef: Map<string, Issued>, book: InvoiceBook): Array<Hit | undefined> {
  const named = liveInvoices(book).filter((i): i is Issued => i.status === 'issued' && !i.cancelled && directionOf(i) === tx.direction && i.currency === tx.currency && i.date <= tx.date);
  return partsOf(tx).map((p) => {
    const ref = tx.direction === 'CRDT' && p.reference ? parseReference(p.reference) : undefined;
    const inv = ref ? byRef.get(ref.reference) : undefined;
    if (inv) return { inv, amount: p.amount, by: 'reference' };
    const fits = named.filter((i) => namesNumber(p.text, i.number) && dueOf(current(book, i.id), book).some((due) => due > 0 && due === p.amount));
    return fits.length === 1 ? { inv: fits[0], amount: p.amount, by: 'number' } : undefined;
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Matches the open period's payments to issued invoices and credit notes (by reference, or by
 * number and amount), records the allocations in `book` and books them into `books` (call inside
 * the write door, update in src/books/store.ts).
 */
export function matchPayments(books: Books, book: InvoiceBook, ctx: PaymentContext): PaymentOutcome {
  const out: PaymentOutcome = { paid: [], questions: [], files: [] };
  const lock = periodLock(books);
  const issued = liveInvoices(book).filter((i): i is Issued => i.status === 'issued');
  if (issued.length === 0) return out;
  const byRef = new Map(issued.filter((i) => i.kind === 'invoice').map((i) => [i.reference, i]));

  for (const tx of books.transactions) {
    const hits = hitsOf(tx, byRef, book);
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
      const split = settle(inv, book, h.amount, tx.date);
      if (split.surplus > 0) { ask(h, 'surplus'); bookable = false; continue; }
      const a: PaymentAllocation = { transactionRef: tx.ref, date: tx.date, amount: split.amount, ...(split.fee ? { fee: split.fee } : {}), by: h.by };
      replace(book, withPayment(inv, a));
      allocations.push({ inv: current(book, inv.id), a });
    }
    if (hits.some((h) => !h) && allocations.length) for (const { inv, a } of allocations) out.questions.push({ transactionRef: tx.ref, number: inv.number, problem: 'batch', amount: a.amount });

    // The classifier's guess gives way to the document; a person's or another module's booking does not.
    const entries = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
    const ours = books.mappings.some((m) => m.transactionRef === tx.ref && m.rule === 'invoice-reference');
    const alreadyBooked = entries.some((e) => e.origin !== 'classify');
    if (alreadyBooked && !ours) {
      for (const { inv, a } of allocations) out.questions.push({ transactionRef: tx.ref, number: inv.number, problem: 'booked', amount: a.amount });
    }
    const toBook = bookable && !alreadyBooked && allocations.length > 0;
    if (toBook) {
      if (entries.length) books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
      for (const { inv, a } of allocations) bookPayment(books, tx, inv, a, ctx, out);
    }
    for (const { inv, a, known } of allocations) {
      if (!known || toBook) out.paid.push({ transactionRef: tx.ref, number: inv.number, amount: a.amount, fee: a.fee ?? 0, booked: toBook });
    }
  }
  return out;
}

/** How a payment of `amount` settles a document: an invoice's open amount and fees, a credit note's refund. */
function settle(inv: Issued, book: InvoiceBook, amount: number, date: string): { amount: number; fee: number; surplus: number } {
  if (inv.kind === 'invoice') return allocate(inv, liveInvoices(book), amount, date);
  const due = refundDue(inv, liveInvoices(book));
  return { amount: Math.min(amount, due), fee: 0, surplus: r2(Math.max(0, amount - due)) };
}

const current = (book: InvoiceBook, id: string) => book.invoices.find((i) => i.id === id) as Issued;
function replace(book: InvoiceBook, inv: Issued): void {
  book.invoices[book.invoices.findIndex((i) => i.id === inv.id)] = inv;
}

/**
 * The revenue of one allocation as journal entries, the document's PDF as their receipt: an
 * invoice's payment credits revenue with the sale codes, a credit note's refund debits it with the
 * minus codes (the revenue and its VAT go down by what was paid back).
 */
export function bookPayment(books: Books, tx: BankTransaction, inv: Issued, a: PaymentAllocation, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>): JournalEntry[] {
  const bank = bankAccountFor(tx, ctx.bankAccounts);
  const rate = tx.currency === baseCurrency() ? undefined : ctx.fx.daily(tx.currency, tx.date);
  if (tx.currency !== baseCurrency() && rate === undefined) throw new Error(`Kein ESTV-Kurs ${tx.currency} für ${tx.date}: npm run fetch-rates`);
  const refund = inv.kind === 'credit-note';
  const word = refund ? TEXTS.de.credit : TEXTS.de.invoice;
  const text = `${word} ${inv.number} ${inv.customer.name}`;
  const legs = [
    ...revenueSplit(inv, a.amount, ctx.revenueAccount),
    ...(a.fee ? [{ account: ctx.feeAccount ?? ctx.revenueAccount, amount: a.fee, vatCode: undefined, fee: true }] : []),
  ];
  const entries: JournalEntry[] = legs.map((l) => ({
    id: idSource.bytes(8).toString('hex'),
    transactionRef: tx.ref,
    date: tx.date,
    accountDebit: refund ? l.account : bank,
    accountCredit: refund ? bank : l.account,
    amount: l.amount,
    ...(l.vatCode ? { vatCode: refund ? vat().codes.negativePrefix + l.vatCode : l.vatCode } : {}),
    description: 'fee' in l ? `${text}, ${TEXTS.de.fee}` : text,
    ...(rate !== undefined ? { exchangeCurrency: tx.currency, exchangeRate: rate } : {}),
    origin: 'invoice',
  }));
  books.journalEntries.push(...entries);
  attachInvoice(books, tx, inv, ctx, out);
  return entries;
}

/** The document's PDF as the payment's receipt, filed and linked once: the payment shows which invoice it paid. */
function attachInvoice(books: Books, tx: BankTransaction, inv: Issued, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>): void {
  const refund = inv.kind === 'credit-note';
  const word = refund ? TEXTS.de.credit : TEXTS.de.invoice;
  const text = `${word} ${inv.number} ${inv.customer.name}`;
  const pdf = ctx.pdfOf(inv);
  const id = ctx.receiptId(pdf);
  if (!books.receipts.some((r) => r.id === id)) {
    const filename = `${inv.date.replace(/-/g, '')}-${word.toLowerCase()}-${inv.number}.pdf`;
    const t = totals(inv.lines);
    const receipt: Receipt = {
      id,
      filename,
      originalFilename: filename,
      extractedText: [inv.sender.name, `${word} ${inv.number}`, inv.customer.name, ...inv.lines.map((l) => l.text), `Total ${inv.currency} ${t.gross.toFixed(2)}`].join('\n'),
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
}

/**
 * A payment the rules could not tie to a document by themselves, that could pay it: an incoming
 * one for an open invoice (its open amount, or a part of it with its number in the text), an
 * outgoing one for a credit note's refund (its amount, to the customer or naming its number);
 * same currency, on or after the document's date. One whose text names the document is proposed
 * also when it came before the document's date (a prepayment on the invoice) and when a person
 * booked it already (`booked`: the link keeps her booking), so the year end never counts its
 * revenue twice (r9c-3).
 */
export interface PaymentProposal {
  transactionRef: string;
  direction: BankTransaction['direction'];
  date: string;
  amount: number;
  currency: string;
  /** Who paid or was paid, as the bank names them; else the payment's text. */
  payer: string;
  invoiceId: string;
  number: string;
  customerName: string;
  /** The payer's name contains the customer's. */
  nameMatches: boolean;
  /** The payment's text names the document's number. */
  numberMatches: boolean;
  /** A person (or another module) booked the payment already: the link records the allocation and keeps that booking. */
  booked: boolean;
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export function paymentProposals(books: Books, book: InvoiceBook): PaymentProposal[] {
  const lock = periodLock(books);
  const invoices = liveInvoices(book);
  const open = invoices.filter((i): i is Issued => i.status === 'issued' && !i.cancelled && (i.kind === 'invoice' ? openAmount(i, invoices) > 0 : refundDue(i, invoices) > 0));
  const references = new Set(invoices.flatMap((i) => (i.status === 'issued' ? [i.reference] : [])));
  const allocated = new Set(invoices.flatMap((i) => (i.status === 'issued' ? i.payments.map((p) => p.transactionRef) : [])));
  const booked = new Set(books.journalEntries.filter((e) => e.origin !== 'classify').map((e) => e.transactionRef));
  const out: PaymentProposal[] = [];
  for (const tx of books.transactions) {
    if (lock.isClosed(tx.date) || allocated.has(tx.ref)) continue;
    const refs = [tx.reference, ...(tx.parts ?? []).map((p) => p.reference)].map((r) => (r ? parseReference(r)?.reference : undefined));
    if (tx.direction === 'CRDT' && refs.some((r) => r && references.has(r))) continue;
    const payer = tx.counterparty || (tx.parts ?? []).map((p) => p.counterparty).filter(Boolean).join(', ') || tx.description;
    const text = [tx.description, tx.reference, tx.counterparty, ...(tx.parts ?? []).flatMap((p) => [p.counterparty, p.reference])].filter(Boolean).join(' ');
    for (const inv of open) {
      if (directionOf(inv) !== tx.direction || inv.currency !== tx.currency) continue;
      const numberMatches = namesNumber(text, inv.number);
      // Before the document's date, or booked already: only a payment that names the document is offered.
      if (!numberMatches && (tx.date < inv.date || booked.has(tx.ref))) continue;
      const name = words(inv.customer.name);
      const nameMatches = name.length > 0 && name.some((w) => words(text).includes(w));
      const due = dueOf(inv, book);
      const fits = due.includes(tx.amount) || (numberMatches && tx.amount < due[0]);
      // Money out is everyday; only a refund to the customer, or one naming the credit note, is offered.
      if (!fits || (tx.direction === 'DBIT' && !nameMatches && !numberMatches)) continue;
      out.push({
        transactionRef: tx.ref, direction: tx.direction, date: tx.date, amount: tx.amount, currency: tx.currency, payer, invoiceId: inv.id, number: inv.number,
        customerName: inv.customer.name, nameMatches, numberMatches, booked: booked.has(tx.ref),
      });
    }
  }
  return out.sort((a, b) => Number(b.numberMatches) - Number(a.numberMatches) || Number(b.nameMatches) - Number(a.nameMatches) || a.date.localeCompare(b.date));
}

/**
 * A person confirms that `tx` pays `inv` (an incoming payment an invoice, an outgoing one a credit
 * note's refund): the allocation is recorded and booked from the document. Entries the classifier
 * wrote for the transaction are replaced. A payment a person booked already keeps her booking (it
 * is the revenue): the allocation is recorded and the document filed as its receipt (r9c-3).
 */
export function confirmPayment(books: Books, book: InvoiceBook, invoiceId: string, transactionRef: string, ctx: PaymentContext): PaymentOutcome {
  const out: PaymentOutcome = { paid: [], questions: [], files: [] };
  const tx = books.transactions.find((t) => t.ref === transactionRef);
  const inv = liveInvoices(book).find((i): i is Issued => i.id === invoiceId && i.status === 'issued');
  if (!inv) throw new PaymentError('Keine ausgestellte Rechnung mit dieser Id.');
  if (!tx || tx.direction !== directionOf(inv)) throw new PaymentError(inv.kind === 'credit-note' ? 'Keine ausgehende Zahlung mit dieser Referenz.' : 'Keine eingehende Zahlung mit dieser Referenz.');
  const what = `${inv.kind === 'credit-note' ? 'Gutschrift' : 'Rechnung'} ${inv.number}`;
  if (inv.cancelled) throw new PaymentError(`${what} ist storniert.`);
  if (inv.currency !== tx.currency) throw new PaymentError(`${what} ist in ${inv.currency}, die Zahlung in ${tx.currency}.`);
  if (inv.payments.some((p) => p.transactionRef === tx.ref)) throw new PaymentError(`Die Zahlung ist ${what} schon zugeordnet.`);
  const keep = books.journalEntries.some((e) => e.transactionRef === tx.ref && e.origin !== 'classify');
  const split = settle(inv, book, tx.amount, tx.date);
  if (split.surplus > 0) throw new PaymentError(`Die Zahlung ist ${tx.currency} ${split.surplus.toFixed(2)} höher als offen.`);
  const a: PaymentAllocation = { transactionRef: tx.ref, date: tx.date, amount: split.amount, ...(split.fee ? { fee: split.fee } : {}), by: 'confirmed' };
  replace(book, withPayment(inv, a));
  if (keep) attachInvoice(books, tx, inv, ctx, out);
  else {
    books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
    bookPayment(books, tx, inv, a, ctx, out);
  }
  out.paid.push({ transactionRef: tx.ref, number: inv.number, amount: a.amount, fee: a.fee ?? 0, booked: !keep });
  return out;
}

export class PaymentError extends Error {}
