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
import { bookedInFiled } from '../books/twins.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';
import { periodLock, release, type Books } from '../books/store.js';
import { bankAccountFor, byStatement } from '../workspace/money-accounts.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { Invoice, InvoiceBook, Issued, PaymentAllocation, WriteOff, WriteOffReason } from './model.js';
import { parseReference } from '../providers/qr-bill/reference.js';
import { retentionOf,
  InvoiceRuleError, type PaymentRefusal, allocate, cashRevenue, liveInvoices, revenueLines, namesNumber, openAmount, openFees, refundDue, revenueSplit, skontoOf, withPayment, withWriteOff, withoutPayment, withoutWriteOff, writeOffAccounts,
} from './rules.js';
import { TEXTS } from './texts.js';
import { idSource } from './store.js';
import { agreedBasis, baseCurrency, vat } from '../engines/index.js';
import { settlementLines, sideOf, type OpenItemAccounts } from '../accounting/tax-point.js';
import { roundCHF } from '../accounting/rappen.js';
import { bookInvoiceEvents, bookWriteOff, invoiceReceipt } from './events.js';
import { eventRef, hasEvent, isPersonsLink, writeOffRef } from '../books/refs.js';
import { nextManualRef } from '../books/next-ref.js';

export interface PaymentContext {
  bankAccounts: readonly LedgerBankAccount[];
  revenueAccount: string;
  feeAccount?: string;
  /** Where paid default interest is booked (a financial income account); absent: feeAccount, else revenueAccount. */
  interestAccount?: string;
  /** Where an open item lives on the agreed basis (src/accounting/tax-point.ts): the receivable of an invoice with its event. */
  openItems: OpenItemAccounts;
  fx: Pick<FxResolver, 'daily'>;
  /** The invoice PDF's bytes (from its stored file). */
  pdfOf(inv: Issued): Buffer;
  receiptId(pdf: Buffer): string;
  /** When the invoice PDF of a payment is indexed as its receipt (ISO): now, on import. */
  indexedAt(at: Pick<BankTransaction, 'date'>): string;
  /** The movements of an account's reconciliation that waits (#254, src/books/reconcile.ts heldByReconciliation): they pay no invoice. */
  held(books: Books): ReadonlySet<string>;
  /** Where a rest is written off on the agreed basis (invoicing.writeOffAccount); absent: the jurisdiction's. */
  writeOffAccount?: { skonto: string; loss: string };
  /** The fee and write-off accounts valid on a day (spec 4.12): a payment's fee reads its date, a write-off its own; absent: the fields above. */
  accountsOn?(day: string): { feeAccount?: string; writeOffAccount?: { skonto: string; loss: string } };
  /** Puts an account a booking needs into the chart when it lacks it, under the jurisdiction chart's name (a write-off account). */
  ensureAccount?(number: string): void;
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
  paid: Array<{ transactionRef: string; number: string; amount: number; fee: number; interest: number; booked: boolean }>;
  questions: PaymentQuestion[];
  /** receipts/<filename> to write with these bytes (the invoice PDF), when not there yet. */
  files: Array<{ filename: string; pdf: Buffer }>;
  /** The classifier's entries a confirmed link replaced: kept beside the books so that «Lösen» puts them back (r10c-3). */
  replaced?: JournalEntry[];
}

interface Hit { inv: Issued; amount: number; by: 'reference' | 'number' }

/** The direction money moves for a document: in for an invoice, out for a credit note's refund. */
const directionOf = (inv: Issued): BankTransaction['direction'] => (inv.kind === 'credit-note' ? 'DBIT' : 'CRDT');

/** What a document is still owed or owes back, reminder fees included: what a payment naming it must match. */
const dueOf = (inv: Issued, book: InvoiceBook): number[] => {
  const invoices = liveInvoices(book);
  if (inv.kind === 'credit-note') return [refundDue(inv, invoices)];
  const open = openAmount(inv, invoices);
  // A retention held back (spec 4.4.9): the QR-bill asked for the rest, so a payment of the rest is the Rechnung's.
  const held = retentionOf(inv);
  return [open, r2(open + openFees(inv)), ...(held > 0 && open > held ? [r2(open - held)] : [])];
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
    // The number and what is due, or what is due less the Skonto its printed terms offer (spec 4.4.6).
    const fits = named.filter((i) => namesNumber(p.text, i.number) && (dueOf(current(book, i.id), book).some((due) => due > 0 && due === p.amount) || skontoOf(current(book, i.id), liveInvoices(book), p.amount, tx.date) !== undefined));
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
  // A movement of a reconciliation that waits, or one booked in a filed quarter as a movement read from a PDF (#254): it pays nothing twice.
  const held = ctx.held(books);

  for (const tx of books.transactions) {
    if (held.has(tx.ref) || bookedInFiled(tx)) continue;
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
      const skonto = inv.kind === 'invoice' ? skontoOf(inv, liveInvoices(book), split.amount, tx.date) : undefined;
      const a: PaymentAllocation = { transactionRef: tx.ref, date: tx.date, amount: split.amount, ...(split.fee ? { fee: split.fee } : {}), ...(split.interest ? { interest: split.interest } : {}), by: h.by };
      replace(book, withPayment(inv, a));
      // A Skonto within the printed days: the rest is written off by code, with the payment (spec 4.4.6).
      if (skonto !== undefined) writeOffRest(books, book, inv.id, { date: tx.date, amount: skonto, reason: 'skonto', by: 'code', transactionRef: tx.ref }, ctx, out);
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
      for (const { inv, a } of allocations) bookPayment(books, tx, inv, a, ctx, out, liveInvoices(book));
    }
    for (const { inv, a, known } of allocations) {
      if (!known || toBook) out.paid.push({ transactionRef: tx.ref, number: inv.number, amount: a.amount, fee: a.fee ?? 0, interest: a.interest ?? 0, booked: toBook });
    }
  }
  rebookEvents(books, book, ctx, out);
  return out;
}

/** How a payment of `amount` settles a document: an invoice's open amount and fees, a credit note's refund. */
function settle(inv: Issued, book: InvoiceBook, amount: number, date: string): { amount: number; fee: number; interest: number; surplus: number } {
  if (inv.kind === 'invoice') return allocate(inv, liveInvoices(book), amount, date);
  const due = refundDue(inv, liveInvoices(book));
  return { amount: Math.min(amount, due), fee: 0, interest: 0, surplus: r2(Math.max(0, amount - due)) };
}

const current = (book: InvoiceBook, id: string) => book.invoices.find((i) => i.id === id) as Issued;
function replace(book: InvoiceBook, inv: Issued): void {
  book.invoices[book.invoices.findIndex((i) => i.id === inv.id)] = inv;
}

/**
 * One allocation as journal entries, the document's PDF as their receipt. On the cash basis an
 * invoice's payment credits revenue with the sale codes, a credit note's refund debits it with the
 * minus codes (the revenue and its VAT go down by what was paid back). A document whose event the
 * books carry (src/invoices/events.ts, the agreed basis) declared its VAT on its own date: the
 * payment only settles the receivable, at the payment's rate, the exchange difference to the
 * Kursdifferenzen account; a prepayment before the invoice's date books its revenue itself, and the
 * event comes off to be booked again for the rest (prepaidEvent). A paid reminder fee is revenue
 * without VAT either way, paid default interest a financial income without VAT.
 */
export function bookPayment(books: Books, tx: BankTransaction, inv: Issued, a: PaymentAllocation, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>, invoices: readonly Invoice[] = [inv]): JournalEntry[] {
  dropEvent(books, prepaidEvent(books, tx, inv));
  const bank = bankAccountFor(tx, ctx.bankAccounts);
  const rate = tx.currency === baseCurrency() ? undefined : ctx.fx.daily(tx.currency, tx.date);
  if (tx.currency !== baseCurrency() && rate === undefined) throw new Error(`Kein ESTV-Kurs ${tx.currency} für ${tx.date}: npm run fetch-rates`);
  const refund = inv.kind === 'credit-note';
  const word = refund ? TEXTS.de.credit : TEXTS.de.invoice;
  const text = `${word} ${inv.number} ${inv.customer.name}`;
  const fx = rate !== undefined ? { exchangeCurrency: tx.currency, exchangeRate: rate } : {};
  const stamp = (l: Omit<JournalEntry, 'id' | 'transactionRef' | 'date' | 'origin'>): JournalEntry => ({ id: idSource.bytes(8).toString('hex'), transactionRef: tx.ref, date: tx.date, ...l, origin: 'invoice' });
  // A Mahnung's fee and default interest, paid with it: revenue without a code, on either basis (no consideration for a supply).
  // The fee account valid on the payment's date (spec 4.12).
  const feeAccount = ctx.accountsOn ? ctx.accountsOn(tx.date).feeAccount : ctx.feeAccount;
  const fee = [
    ...(a.fee ? [stamp({ accountDebit: bank, accountCredit: feeAccount ?? ctx.revenueAccount, amount: a.fee, description: `${text}, ${TEXTS.de.fee}`, ...fx })] : []),
    ...(a.interest ? [stamp({ accountDebit: bank, accountCredit: ctx.interestAccount ?? feeAccount ?? ctx.revenueAccount, amount: a.interest, description: `${text}, ${TEXTS.de.interestWord}`, ...fx })] : []),
  ];
  const entries: JournalEntry[] = hasEvent(books, inv)
    ? [...settlementLines({
      account: ctx.openItems.receivable, bank, amount: refund ? -a.amount : a.amount, currency: tx.currency, rate,
      booked: (refund ? -1 : 1) * heldFor(books, inv, a.amount), fxDifference: ctx.openItems.fxDifference,
    }).map(({ fx: diff, ...l }) => stamp({ ...l, description: diff ? `Kursdifferenz ${text}` : text })), ...fee]
    // An invoice's payment books its share of the invoice and, with the minus codes, of the credit notes applied to it (Verrechnung).
    : [...(refund ? revenueLines(inv, a.amount, ctx.revenueAccount).map((l) => ({ ...l, minus: l.minus ? undefined : (true as const) })) : cashRevenue(inv, invoices, a, ctx.revenueAccount)).map((l) => stamp({
      accountDebit: l.minus ? l.account : bank,
      accountCredit: l.minus ? bank : l.account,
      amount: l.amount,
      ...(l.vatCode ? { vatCode: l.minus ? vat().codes.negativePrefix + l.vatCode : l.vatCode } : {}),
      description: text,
      ...fx,
    })), ...fee];
  books.journalEntries.push(...entries);
  attachInvoice(books, tx, inv, ctx, out);
  return entries;
}

/**
 * The entries of an invoice's event that `tx` prepaid: a payment before the invoice's date, on the
 * agreed basis, while the event lies in an open period. The tax on a prepayment arises when it is
 * received (MWSTG Art. 40 Abs. 1 lit. c), so the event comes off, the payment books its part with
 * the sale codes on its own date, and the event is booked again for the rest (bookInvoiceEvents
 * takes off what the payments booked as revenue).
 */
function prepaidEvent(books: Books, tx: Pick<BankTransaction, 'date'>, inv: Issued): JournalEntry[] {
  if (!agreedBasis() || inv.kind !== 'invoice' || tx.date >= inv.date) return [];
  const ref = eventRef(inv, 'issue');
  const lock = periodLock(books);
  const event = books.journalEntries.filter((e) => e.transactionRef === ref);
  return event.some((e) => lock.isClosed(e.date)) ? [] : event;
}

function dropEvent(books: Books, event: readonly JournalEntry[]): void {
  if (event.length) books.journalEntries = books.journalEntries.filter((e) => !event.includes(e));
}

/** The events the books lack after a payment changed what they book (a prepayment, «Lösen»), booked again: the PDFs to file go to `out`. */
function rebookEvents(books: Books, book: InvoiceBook, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>): void {
  if (!agreedBasis()) return;
  out.files.push(...bookInvoiceEvents(books, book, ctx).files);
  // An event its payments took over whole (a prepayment of the whole invoice) is gone: a receipt a person or the AI linked to it
  // goes with it, so no link hangs on a booking that is gone (#524); the receipt is open again to be linked where it belongs.
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const events = new Set(liveInvoices(book).flatMap((i) => (i.status === 'issued' ? [eventRef(i, 'issue')] : [])));
  books.mappings = books.mappings.filter((m) => !(events.has(m.transactionRef) && !booked.has(m.transactionRef) && isPersonsLink(m)));
}

/** What the receivable holds in the books' currency for `amount` of the document: at its event's rate (MWSTV Art. 45), the amount itself in the books' currency. */
function heldFor(books: Books, inv: Issued, amount: number): number {
  const ref = eventRef(inv, 'issue');
  const rate = books.journalEntries.find((e) => e.transactionRef === ref)?.exchangeRate;
  return rate === undefined ? amount : roundCHF(amount * rate);
}

/** The document's PDF as the payment's receipt, filed and linked once: the payment shows which invoice it paid. */
function attachInvoice(books: Books, tx: BankTransaction, inv: Issued, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>): void {
  const id = invoiceReceipt(books, inv, ctx, out, tx);
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

/**
 * A salutation a person's printed name starts with (src/invoices/contacts.ts printedName), in the four
 * document languages: no bank row names it, and a refund that says «Frau» must not match every woman.
 */
const SALUTATIONS = new Set(['herr', 'herrn', 'frau', 'familie', 'fam', 'monsieur', 'madame', 'mme', 'mlle', 'mademoiselle', 'famille', 'signor', 'signore', 'signora', 'sig', 'famiglia', 'mrs', 'miss', 'family']);
/** The words of a customer's name that identify it in a payment's text: without its salutation. */
const nameWords = (name: string) => words(name).filter((w) => !SALUTATIONS.has(w));

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
      const name = nameWords(inv.customer.name);
      const nameMatches = name.length > 0 && name.some((w) => words(text).includes(w));
      const due = dueOf(inv, book);
      // On the agreed basis a part paid by the customer (every word of its name in the payment) is offered too: its revenue is booked with the invoice.
      const fromCustomer = agreedBasis() && tx.direction === 'CRDT' && name.length > 0 && name.every((w) => words(text).includes(w));
      const fits = due.includes(tx.amount) || ((numberMatches || fromCustomer) && tx.amount < due[0]);
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
 * is the revenue): the allocation is recorded and the document filed as its receipt (r9c-3). On the
 * agreed basis the document's event is the revenue: a kept booking with a sale code is refused, one
 * that settles the receivable is kept.
 */
export function confirmPayment(books: Books, book: InvoiceBook, invoiceId: string, transactionRef: string, ctx: PaymentContext): PaymentOutcome {
  const out: PaymentOutcome = { paid: [], questions: [], files: [] };
  const tx = books.transactions.find((t) => t.ref === transactionRef);
  const inv = liveInvoices(book).find((i): i is Issued => i.id === invoiceId && i.status === 'issued');
  if (!inv) throw new PaymentError('notFound', 'Keine ausgestellte Rechnung mit dieser Id.');
  if (!tx || tx.direction !== directionOf(inv)) throw new PaymentError('noPayment', inv.kind === 'credit-note' ? 'Keine ausgehende Zahlung mit dieser Referenz.' : 'Keine eingehende Zahlung mit dieser Referenz.');
  const what = `${inv.kind === 'credit-note' ? 'Gutschrift' : 'Rechnung'} ${inv.number}`;
  if (inv.cancelled) throw new PaymentError('cancelled', `${what} ist storniert.`);
  if (inv.currency !== tx.currency) throw new PaymentError('currency', `${what} ist in ${inv.currency}, die Zahlung in ${tx.currency}.`);
  if (inv.payments.some((p) => p.transactionRef === tx.ref)) throw new PaymentError('allocated', `Die Zahlung ist ${what} schon zugeordnet.`);
  refuseHeld(books, tx, ctx);
  const keep = books.journalEntries.some((e) => e.transactionRef === tx.ref && e.origin !== 'classify');
  // A document with its event carries its revenue on the receivable already: a kept booking of the payment with a sale code would count it twice.
  // Not so for a prepayment: its revenue is the payment's, the event is booked again for the rest.
  const prepaid = prepaidEvent(books, tx, inv);
  const event = prepaid.length ? undefined : books.journalEntries.find((e) => e.transactionRef === eventRef(inv, 'issue'));
  if (keep && event && books.journalEntries.some((e) => e.transactionRef === tx.ref && sideOf(e.vatCode) === 'sale')) {
    throw new PaymentError('doubleRevenue', `${what} ist am ${event.date} mit Umsatz und MWST auf ${ctx.openItems.receivable} gebucht (${event.transactionRef}), die Zahlung ist mit Umsatz gebucht: zugeordnet zählte der Umsatz doppelt. Die Buchung der Zahlung auf ${ctx.openItems.receivable} ändern oder löschen, dann zuordnen.`);
  }
  const split = settle(inv, book, tx.amount, tx.date);
  if (split.surplus > 0) throw new PaymentError('surplus', `Die Zahlung ist ${tx.currency} ${split.surplus.toFixed(2)} höher als offen.`);
  const a: PaymentAllocation = { transactionRef: tx.ref, date: tx.date, amount: split.amount, ...(split.fee ? { fee: split.fee } : {}), ...(split.interest ? { interest: split.interest } : {}), by: 'confirmed' };
  replace(book, withPayment(inv, a));
  dropEvent(books, prepaid);
  if (keep) attachInvoice(books, tx, inv, ctx, out);
  else {
    out.replaced = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
    books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
    bookPayment(books, tx, inv, a, ctx, out, liveInvoices(book));
  }
  rebookEvents(books, book, ctx, out);
  out.paid.push({ transactionRef: tx.ref, number: inv.number, amount: a.amount, fee: a.fee ?? 0, interest: a.interest ?? 0, booked: !keep });
  return out;
}

/**
 * Whether a payment's entry was booked for `doc`: every entry bookPayment writes names the
 * document's number in its text (the revenue, the minus lines of a Verrechnung, the fee, the
 * exchange difference), and invoices and credit notes share one series, so the number tells
 * the parts of one payment over several documents apart.
 */
export const bookedFor = (e: Pick<JournalEntry, 'origin' | 'description'>, doc: Pick<Issued, 'number'>): boolean =>
  e.origin === 'invoice' && namesNumber(e.description ?? '', doc.number);

/** What «Lösen» did: the allocation that left the document, the entries the link had booked, and what is booked in their place. */
export interface PaymentReleased {
  allocation: PaymentAllocation; removed: JournalEntry[]; restored: JournalEntry[];
  /** The invoice PDFs an event booked again needs as receipts (a prepayment released). */
  files: PaymentOutcome['files'];
}

/**
 * «Lösen» (r10c-3): the payment leaves the document, so it is open (or owes its refund) again; the
 * entries the link booked from the document (origin invoice) and the link to the document's PDF
 * go; `restore` (what the link replaced, src/server/link-history.ts) is booked again. A booking a
 * person made stays, as the link had kept it.
 */
export function releasePayment(books: Books, book: InvoiceBook, invoiceId: string, transactionRef: string, ctx: PaymentContext, restore: readonly JournalEntry[] = []): PaymentReleased {
  const inv = liveInvoices(book).find((i): i is Issued => i.id === invoiceId && i.status === 'issued');
  const allocation = inv?.payments.find((p) => p.transactionRef === transactionRef);
  if (!inv || !allocation) throw new PaymentError('notAllocated', 'Die Zahlung ist dieser Rechnung nicht zugeordnet.');
  replace(book, withoutPayment(inv, transactionRef));
  // The Skonto code wrote off with the payment goes with it; on a cancelled invoice it stays, reversed with the claim by its Storno.
  if (!inv.cancelled) for (const w of (inv.writeOffs ?? []).filter((x) => x.by === 'code' && x.transactionRef === transactionRef)) removeWriteOff(books, book, inv.id, w.id);
  // Only this document's part: a payment allocated over several (Ausziffern) keeps the others' entries.
  const removed = books.journalEntries.filter((e) => e.transactionRef === transactionRef && bookedFor(e, inv));
  books.journalEntries = books.journalEntries.filter((e) => !removed.includes(e));
  // A prepayment's revenue leaves with it: the event, booked for the rest, is booked again for what is now the invoice's.
  if (removed.some((e) => sideOf(e.vatCode) === 'sale')) dropEvent(books, prepaidEvent(books, allocation, inv));
  const receipt = ctx.receiptId(ctx.pdfOf(inv));
  // The payment taken off its invoice: its link goes on purpose (the write door, #405).
  if (receipt) release(books, { mappings: [{ transactionRef, receiptId: receipt }] });
  books.mappings = books.mappings.filter((m) => !(m.transactionRef === transactionRef && m.receiptId === receipt));
  const restored = books.journalEntries.some((e) => e.transactionRef === transactionRef) ? [] : restore.filter((e) => !books.journalEntries.some((x) => x.id === e.id));
  books.journalEntries.push(...restored);
  const files: PaymentOutcome['files'] = [];
  rebookEvents(books, book, ctx, { files });
  return { allocation, removed, restored, files };
}

export type { PaymentRefusal };
/**
 * A payment no document may take: one a waiting reconciliation holds (its movement may still be the
 * PDF's twin of the bank file's) or one the books carry in a filed period already (`filedTwin`).
 * Code's matching skips them (matchPayments); a person's link and Ausziffern are refused the same.
 */
export function refuseHeld(books: Books, tx: BankTransaction, ctx: Pick<PaymentContext, 'held'>): void {
  if (ctx.held(books).has(tx.ref)) throw new PaymentError('held', 'Die Zahlung wartet auf den Abgleich ihres Kontos mit der Datei der Bank: erst dort bestätigen.');
  if (bookedInFiled(tx)) throw new PaymentError('filedTwin', 'Die Zahlung ist schon in einer eingereichten Periode gebucht.');
}

export class PaymentError extends Error {
  constructor(readonly code: PaymentRefusal, message: string) { super(message); }
}

// ─── write-offs (Ausbuchung) ────────────────────────────────────────────────────

/**
 * The rest of an invoice written off (spec 4.4.6, 4.5): recorded on the invoice; on the cash basis
 * that is all (decision 3: what was never received was never taxed). A document whose event the
 * books carry (the agreed basis) books `RE-<n>-wo-<k>` on its date: the write-off account (the Skonto
 * one for Skonto, Rabatt, Spesen and Rundung, the loss one for a loss) against the receivable, split
 * like the invoice over its rates with the minus sale codes (MWSTG Art. 41 Abs. 1: the tax goes down
 * when the correction is booked), at the rate the receivable holds. Its date lies in an open period:
 * a write-off of an invoice of a filed period is dated in the open one, the filed entry stays (golden
 * rule 1). `confirmed`: the person's «Trotzdem ausbuchen» over more than is open.
 */
export function writeOffRest(books: Books, book: InvoiceBook, invoiceId: string, w: Omit<WriteOff, 'id'>, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>, confirmed = false): { writeOff: WriteOff; entries: JournalEntry[] } {
  if (periodLock(books).isClosed(w.date)) throw new PaymentError('closed', `Der ${w.date} liegt in einer abgeschlossenen Periode: eine Ausbuchung wird in der offenen Periode datiert.`);
  const inv = liveInvoices(book).find((i) => i.id === invoiceId) ?? notFound();
  const { invoice, writeOff } = withWriteOff(inv, liveInvoices(book), w, confirmed);
  replace(book, invoice);
  return { writeOff, entries: hasEvent(books, invoice) ? bookWriteOff(books, invoice, writeOff, ctx, out) : [] };
}

/** «Rückgängig» on a write-off: it leaves the invoice and its entries go; only in an open period (golden rule 1). */
export function removeWriteOff(books: Books, book: InvoiceBook, invoiceId: string, id: string): WriteOff {
  const inv = liveInvoices(book).find((i): i is Issued => i.id === invoiceId && i.status === 'issued') ?? notFound();
  const w = (inv.writeOffs ?? []).find((x) => x.id === id);
  if (!w) throw new PaymentError('noWriteOff', 'Diese Ausbuchung hat die Rechnung nicht.');
  const ref = writeOffRef(inv, id);
  const lock = periodLock(books);
  if (lock.isClosed(w.date) || books.journalEntries.some((e) => e.transactionRef === ref && lock.isClosed(e.date))) throw new PaymentError('closed', `Die Ausbuchung vom ${w.date} liegt in einer abgeschlossenen Periode und bleibt.`);
  // The invoice without it first: a cancelled one refuses, and nothing is taken off the books then.
  const without = withoutWriteOff(inv, id);
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== ref);
  books.mappings = books.mappings.filter((m) => m.transactionRef !== ref);
  replace(book, without);
  return w;
}

const notFound = (): never => { throw new PaymentError('notFound', 'Keine ausgestellte Rechnung mit dieser Id.'); };

// ─── Zahlungseingang by hand ──────────────────────────────────────────────────

/**
 * A Zahlungseingang a person enters on an invoice (spec 4.4.6, P1.7): cash at the door, or money
 * on an account whose statement is not imported yet. It is a hand movement of the books on that
 * money account (a bank or the cash box, in the invoice's currency), allocated to the invoice
 * (`source: 'hand'`) and booked like a statement's payment (bookPayment). When a statement imported
 * later carries the same movement, the import confirms the hand movement (src/books/bank-import.ts
 * matchStatementRows: `statement` on it) and books nothing again; a cash payment stays a hand movement.
 */
export function recordHandPayment(books: Books, book: InvoiceBook, invoiceId: string, req: { date: string; account: string; amount: number }, ctx: PaymentContext): { transaction: BankTransaction; allocation: PaymentAllocation; files: PaymentOutcome['files'] } {
  const inv = liveInvoices(book).find((i): i is Issued => i.id === invoiceId && i.status === 'issued' && i.kind === 'invoice');
  if (!inv) throw new PaymentError('notFound', 'Keine ausgestellte Rechnung mit dieser Id.');
  if (inv.cancelled) throw new PaymentError('cancelled', `Rechnung ${inv.number} ist storniert.`);
  if (periodLock(books).isClosed(req.date)) throw new PaymentError('closed', `Der ${req.date} liegt in einer abgeschlossenen Periode.`);
  const money = ctx.bankAccounts.find((a) => a.account === req.account && a.currency === inv.currency && (a.role === 'bank' || a.role === 'cash'));
  if (!money) throw new PaymentError('moneyAccount', `Konto ${req.account} ist kein Bank- oder Kassenkonto in ${inv.currency} der Firma.`);
  const split = settle(inv, book, req.amount, req.date);
  if (!(req.amount > 0)) throw new PaymentError('amount', 'Der Betrag ist grösser als 0.');
  if (split.surplus > 0) throw new InvoiceRuleError('surplus', `Die Zahlung ist ${inv.currency} ${split.surplus.toFixed(2)} höher als offen: der Überschuss bliebe unzugeordnet.`);
  const ref = nextManualRef(books, req.date.slice(0, 4));
  const transaction: BankTransaction = {
    ref, bank: money.bank, source: 'manual', date: req.date, amount: req.amount, currency: inv.currency, direction: 'CRDT',
    // No counterparty: whoever's statement row brings it (the customer's Treuhänder, a parent firm) confirms it all the same.
    description: `${TEXTS.de.invoice} ${inv.number} ${inv.customer.name}`,
  };
  books.transactions.push(transaction);
  const allocation: PaymentAllocation = { transactionRef: ref, date: req.date, amount: split.amount, ...(split.fee ? { fee: split.fee } : {}), ...(split.interest ? { interest: split.interest } : {}), by: 'confirmed', source: 'hand' };
  replace(book, withPayment(inv, allocation));
  const out: Pick<PaymentOutcome, 'files'> = { files: [] };
  bookPayment(books, transaction, current(book, inv.id), allocation, ctx, out, liveInvoices(book));
  rebookEvents(books, book, ctx, out);
  return { transaction, allocation, files: out.files };
}

/**
 * «Rückgängig» on a Zahlungseingang by hand: its movement, its bookings and its allocation go
 * (open period only). One a statement confirmed is the bank's row now: it is released («Lösen»), not removed.
 */
export function removeHandPayment(books: Books, book: InvoiceBook, invoiceId: string, ref: string, ctx: PaymentContext): PaymentReleased {
  const tx = books.transactions.find((t) => t.ref === ref);
  const inv = liveInvoices(book).find((i): i is Issued => i.id === invoiceId && i.status === 'issued');
  if (!tx || !inv?.payments.some((p) => p.transactionRef === ref && p.source === 'hand')) throw new PaymentError('noHandPayment', 'Kein Zahlungseingang von Hand auf dieser Rechnung.');
  if (byStatement(tx)) throw new PaymentError('confirmed', 'Ein Kontoauszug bestätigt diese Zahlung: sie ist eine Bankzeile und wird gelöst, nicht entfernt.');
  const released = releasePayment(books, book, invoiceId, ref, ctx);
  books.transactions = books.transactions.filter((t) => t.ref !== ref);
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== ref);
  books.mappings = books.mappings.filter((m) => m.transactionRef !== ref);
  return released;
}

// ─── Ausziffern ───────────────────────────────────────────────────────────────

/** A part of an incoming payment for one invoice, and what becomes of that invoice's rest: it stays open (absent), or is written off. */
export interface AllocationPart { invoiceId: string; amount: number; rest?: WriteOffReason }

/** An invoice the Ausziffern dialog offers, with what code proposes to allocate to it. */
export interface AllocationItem { invoiceId: string; number: string; customerId: string; customerName: string; date: string; dueDate: string; open: number; named: boolean; proposed: number }

/** How the contact of a payment was found: the person gave it, the text names its invoice's number, the IBAN paid its invoices before, the text names it. */
export type AllocationBy = 'given' | 'number' | 'iban' | 'name';

/** A contact the Ausziffern dialog can be switched to: one with open Rechnungen in the payment's currency. */
export interface AllocationContact { id: string; name: string; open: number; n: number }

export interface AllocationView {
  transaction: BankTransaction;
  items: AllocationItem[];
  left: number;
  /** The contact whose open items are shown (absent: every contact's) and how it was found. */
  customerId?: string;
  by?: AllocationBy;
  /** Every contact with open Rechnungen in the payment's currency, by name: the person can pick another. */
  customers: AllocationContact[];
  /** Why no contact is proposed although two point to it (the IBAN one, the name another): both, for the person to pick. */
  hints: Array<AllocationHint & { name: string }>;
}

export interface AllocationHint { id: string; by: 'iban' | 'name' }

const bareIban = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').toUpperCase();

/**
 * What the Ausziffern dialog shows for an incoming payment (spec 4.8): the open invoices of its
 * contact in its currency, and code's proposal. The contact is the one given (`''`: none, every
 * contact's), else the one whose invoice number the text names, else the one alone whose earlier
 * invoices the payment's IBAN paid, else the one whose every name word the text names; none found:
 * every open invoice in the currency, nothing proposed but what the text names. The proposal: the
 * invoices the text names first, then the oldest by due date, each up to what is open, until the
 * payment is used up. `left`: what the proposal leaves of the payment.
 */
export function allocationProposal(books: Books, book: InvoiceBook, transactionRef: string, customerId?: string): AllocationView {
  const tx = books.transactions.find((t) => t.ref === transactionRef && t.direction === 'CRDT');
  if (!tx) throw new PaymentError('noPayment', 'Keine eingehende Zahlung mit dieser Referenz.');
  const invoices = liveInvoices(book);
  const text = [tx.description, tx.reference, tx.counterparty, ...(tx.parts ?? []).flatMap((p) => [p.counterparty, p.reference])].filter(Boolean).join(' ');
  const open = invoices.filter((i): i is Issued => i.status === 'issued' && i.kind === 'invoice' && !i.cancelled && i.currency === tx.currency && openAmount(i, invoices) > 0);
  const proposal = customerId !== undefined ? { found: customerId ? { id: customerId, by: 'given' as AllocationBy } : undefined, hints: [] } : proposeContact(books, invoices, open, tx, text);
  const found = proposal.found;
  const who = found?.id;
  const mine = (who ? open.filter((i) => i.customerId === who) : open)
    .sort((a, b) => Number(namesNumber(text, b.number)) - Number(namesNumber(text, a.number)) || a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number));
  let left = Math.round(tx.amount * 100);
  const items = mine.map((i): AllocationItem => {
    const due = Math.round(openAmount(i, invoices) * 100);
    const named = namesNumber(text, i.number);
    const proposed = who || named ? Math.min(due, left) : 0;
    left -= proposed;
    return { invoiceId: i.id, number: i.number, customerId: i.customerId, customerName: i.customer.name, date: i.date, dueDate: i.dueDate, open: due / 100, named, proposed: proposed / 100 };
  });
  const customers = new Map<string, AllocationContact>();
  for (const i of open) {
    const c = customers.get(i.customerId) ?? { id: i.customerId, name: book.contacts.find((x) => x.id === i.customerId)?.name ?? i.customer.name, open: 0, n: 0 };
    customers.set(i.customerId, { ...c, open: Math.round((c.open + openAmount(i, invoices)) * 100) / 100, n: c.n + 1 });
  }
  return { transaction: tx, items, left: left / 100, ...(found ? { customerId: found.id, by: found.by } : {}), customers: [...customers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    hints: proposal.hints.map((h) => ({ ...h, name: book.contacts.find((c) => c.id === h.id)?.name ?? invoices.find((i): i is Issued => i.customerId === h.id && i.status === 'issued')?.customer.name ?? h.id })) };
}

/**
 * The contact code proposes for an incoming payment, among those with open Rechnungen: by the number
 * its text names; else by the IBAN when exactly one contact's invoices, of all issued ones, were paid
 * from it before and that one has something open; else by the name its text names. An IBAN and a name
 * that point to two contacts propose no one: both are named as hints, the person picks.
 */
function proposeContact(books: Books, invoices: readonly Invoice[], open: readonly Issued[], tx: BankTransaction, text: string): { found?: { id: string; by: AllocationBy }; hints: AllocationHint[] } {
  const byNumber = open.find((i) => namesNumber(text, i.number))?.customerId;
  if (byNumber) return { found: { id: byNumber, by: 'number' }, hints: [] };
  const candidates = new Set(open.map((i) => i.customerId));
  const iban = bareIban(tx.counterpartyIban);
  let byIban: string | undefined;
  if (iban) {
    const paidFrom = new Map(books.transactions.flatMap((t) => (t.ref !== tx.ref && t.counterpartyIban ? [[t.ref, bareIban(t.counterpartyIban)] as const] : [])));
    // Every contact ever paid from it, open or not: a shared account (a family, a holding) proposes no one.
    const payers = new Set(invoices.flatMap((i) => (i.status === 'issued' && i.payments.some((p) => paidFrom.get(p.transactionRef) === iban) ? [i.customerId] : [])));
    if (payers.size === 1) byIban = [...payers][0];
  }
  const byName = open.find((i) => { const n = nameWords(i.customer.name); return n.length > 0 && n.every((w) => words(text).includes(w)); })?.customerId;
  if (byIban && byName && byIban !== byName) return { hints: [{ id: byIban, by: 'iban' }, { id: byName, by: 'name' }] };
  if (byIban && candidates.has(byIban)) return { found: { id: byIban, by: 'iban' }, hints: [] };
  return byName ? { found: { id: byName, by: 'name' }, hints: [] } : { hints: [] };
}

/**
 * «Buchen» of the Ausziffern dialog: one incoming payment over one or more invoices, each part its
 * own allocation (the same transaction, its part) booked as that invoice's payment (4.5: cash basis
 * revenue split like each invoice, agreed basis bank / receivable), and each rest the person chose
 * written off on the payment's day. The parts add up to the payment: a surplus stays unallocated in
 * phase 1 and is refused (`surplus`), so the payment remains a question; a part beyond what an
 * invoice has open is refused the same way. A booking a person made of the payment stays (as
 * confirmPayment keeps it); the classifier's gives way.
 */
export function allocatePayment(books: Books, book: InvoiceBook, transactionRef: string, parts: readonly AllocationPart[], ctx: PaymentContext): PaymentOutcome {
  const out: PaymentOutcome = { paid: [], questions: [], files: [] };
  const tx = books.transactions.find((t) => t.ref === transactionRef);
  if (!tx || tx.direction !== 'CRDT') throw new PaymentError('noPayment', 'Keine eingehende Zahlung mit dieser Referenz.');
  if (periodLock(books).isClosed(tx.date)) throw new PaymentError('closed', `Die Zahlung vom ${tx.date} liegt in einer abgeschlossenen Periode.`);
  refuseHeld(books, tx, ctx);
  if (!parts.length) throw new PaymentError('noParts', 'Keine Rechnung gewählt.');
  const invoices = liveInvoices(book);
  if (invoices.some((i) => i.status === 'issued' && i.payments.some((p) => p.transactionRef === tx.ref))) throw new PaymentError('allocated', 'Die Zahlung ist schon zugeordnet: erst lösen.');
  const sum = parts.reduce((s, p) => s + Math.round(p.amount * 100), 0);
  const pay = Math.round(tx.amount * 100);
  if (sum > pay) throw new PaymentError('overAllocated', `Die Teile ergeben ${tx.currency} ${(sum / 100).toFixed(2)}, die Zahlung ist ${tx.currency} ${tx.amount.toFixed(2)}.`);
  if (sum < pay) throw new InvoiceRuleError('surplus', `${tx.currency} ${((pay - sum) / 100).toFixed(2)} der Zahlung bleiben ohne Rechnung: ein Guthaben des Kunden kommt erst später; so bleibt die Zahlung eine offene Frage.`);
  const keep = books.journalEntries.some((e) => e.transactionRef === tx.ref && e.origin !== 'classify');
  const seen = new Set<string>();
  const allocations: Array<{ id: string; a: PaymentAllocation }> = [];
  for (const part of parts) {
    const inv = invoices.find((i): i is Issued => i.id === part.invoiceId && i.status === 'issued' && i.kind === 'invoice');
    if (!inv) throw new PaymentError('notFound', 'Keine ausgestellte Rechnung mit dieser Id.');
    if (seen.has(inv.id)) throw new PaymentError('twice', `Rechnung ${inv.number} ist zweimal gewählt.`);
    seen.add(inv.id);
    if (inv.cancelled) throw new PaymentError('cancelled', `Rechnung ${inv.number} ist storniert.`);
    if (inv.currency !== tx.currency) throw new PaymentError('currency', `Rechnung ${inv.number} ist in ${inv.currency}, die Zahlung in ${tx.currency}.`);
    if (!(part.amount > 0)) throw new PaymentError('amount', `Der Teil für Rechnung ${inv.number} ist grösser als 0.`);
    const open = Math.round(openAmount(current(book, inv.id), liveInvoices(book)) * 100);
    if (Math.round(part.amount * 100) > open) throw new InvoiceRuleError('surplus', `Rechnung ${inv.number} hat ${inv.currency} ${(open / 100).toFixed(2)} offen, nicht ${part.amount.toFixed(2)}: der Überschuss bliebe unzugeordnet.`);
    const event = books.journalEntries.find((e) => e.transactionRef === eventRef(inv, 'issue'));
    if (keep && event && !prepaidEvent(books, tx, inv).length && books.journalEntries.some((e) => e.transactionRef === tx.ref && sideOf(e.vatCode) === 'sale')) {
      throw new PaymentError('doubleRevenue', `Rechnung ${inv.number} ist mit Umsatz auf ${ctx.openItems.receivable} gebucht (${event.transactionRef}), die Zahlung ist mit Umsatz gebucht: zugeordnet zählte der Umsatz doppelt.`);
    }
    const a: PaymentAllocation = { transactionRef: tx.ref, date: tx.date, amount: Math.round(part.amount * 100) / 100, by: 'confirmed' };
    replace(book, withPayment(current(book, inv.id), a));
    allocations.push({ id: inv.id, a });
    const rest = Math.round(openAmount(current(book, inv.id), liveInvoices(book)) * 100);
    if (part.rest && rest > 0) writeOffRest(books, book, inv.id, { date: tx.date, amount: rest / 100, reason: part.rest, by: 'person', transactionRef: tx.ref }, ctx, out);
  }
  if (!keep) {
    out.replaced = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
    books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
  }
  for (const { id, a } of allocations) {
    const inv = current(book, id);
    if (keep) { dropEvent(books, prepaidEvent(books, tx, inv)); attachInvoice(books, tx, inv, ctx, out); }
    else bookPayment(books, tx, inv, a, ctx, out, liveInvoices(book));
    out.paid.push({ transactionRef: tx.ref, number: inv.number, amount: a.amount, fee: 0, interest: 0, booked: !keep });
  }
  rebookEvents(books, book, ctx, out);
  return out;
}
