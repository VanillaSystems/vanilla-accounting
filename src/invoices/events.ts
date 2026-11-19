/**
 * Issued documents as VAT events on the agreed basis (MWSTG Art. 40 Abs. 1 lit. a, Art. 41): an
 * invoice books its revenue with its sale codes on its date against the receivable, a credit note
 * takes revenue and VAT back on its date, a cancellation reverses the invoice on the day it is
 * cancelled. Each event has a ref of its own (eventRef), so booking them converges: an event the
 * books carry is never booked again. A payment of a document whose event the books carry settles
 * the receivable only (src/invoices/payments.ts bookPayment), whatever the basis is by then, so a
 * switch back to the cash basis never taxes it twice (MWSTV Art. 106 Abs. 2).
 *
 * An event of a day the books no longer take is booked on the first day they take (eventPlan): for
 * what was still open on the locked line when the document is an open item of the switch to the
 * agreed basis (MWSTV Art. 106 Abs. 1); whole, an invoice into its period's correction return, when
 * the firm reported on this basis then.
 */
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';
import { periodLock, type Books } from '../books/store.js';
import { agreedBasis, baseCurrency, filing, vat } from '../engines/index.js';
import { lockedTaxPoint, openDay, sideOf } from '../accounting/tax-point.js';
import { reversalOf } from '../accounting/reversal.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import type { Invoice, InvoiceBook, Issued, WriteOff, WriteOffReason } from './model.js';
import { creditNotesOf, liveInvoices, openOn, revenueLines, revenueSplit, totals, writeOffAccounts } from './rules.js';
import { TEXTS } from './texts.js';
import { idSource } from './store.js';
import { eventRef, writeOffRef, type EventKind } from '../books/refs.js';
import type { PaymentContext, PaymentOutcome } from './payments.js';

export { eventRef, hasEvent, type EventKind } from '../books/refs.js';

export interface EventOutcome {
  booked: Array<{ number: string; kind: EventKind; date: string }>;
  /** A foreign document whose day has no official rate yet (npm run fetch-rates): booked by a later run. */
  skipped: Array<{ number: string; reason: 'rate' }>;
  files: PaymentOutcome['files'];
}

const gross = (inv: Issued) => Math.abs(toRappen(totals(inv).gross));

/** What a credit note still owed back at the end of `date`: its part beyond what its invoice owed then, less the refunds made by then. */
function refundDueOn(cn: Issued, invoices: readonly Invoice[], date: string): number {
  if (cn.settlement === 'offset' || (cn.cancelled && cn.cancelled.date <= date)) return 0;
  const target = invoices.find((i): i is Issued => i.id === cn.creditFor && i.status === 'issued');
  if (!target) return 0;
  const earlier = creditNotesOf(target, invoices, date).filter((c) => c.id !== cn.id && (c.date < cn.date || (c.date === cn.date && c.issuedAt < cn.issuedAt)));
  const paid = target.payments.filter((p) => p.date <= date).reduce((s, p) => s + toRappen(p.amount), 0);
  const written = (target.writeOffs ?? []).filter((w) => w.date <= date).reduce((s, w) => s + toRappen(w.amount), 0);
  const owed = gross(target) - paid - written - earlier.reduce((s, c) => s + gross(c), 0);
  const back = Math.max(0, gross(cn) - Math.max(0, owed));
  const refunded = cn.payments.filter((p) => p.date <= date).reduce((s, p) => s + toRappen(p.amount), 0);
  return fromRappen(Math.max(0, back - refunded));
}

/** When a document's event is booked, for how much, and the period whose correction return declares it. */
interface EventPlan { day: string; amount: number; corrects?: string }

/**
 * A document's event on a day the books take: its whole amount less what its payments booked as
 * revenue themselves (cash style before the event existed, a prepayment, or a person's booking with
 * a sale code); an allocation whose booking only settles the receivable took no revenue and takes
 * none off. On a locked day, by where its tax belongs (lockedTaxPoint): an open item of the switch
 * books what was still open on the locked line on the first open day; a document of a period the
 * firm reported on this basis books the same as on its own day, an invoice into that period's
 * correction return (golden rule 1), a credit note on the first open day, when it is booked (MWSTG Art. 41).
 */
function eventPlan(books: Books, inv: Issued, invoices: readonly Invoice[], lock: ReturnType<typeof periodLock>): EventPlan {
  const day = openDay(lock, inv.date);
  const revenue = new Set(books.journalEntries.filter((e) => sideOf(e.vatCode) === 'sale').map((e) => e.transactionRef));
  const whole = fromRappen(gross(inv) - inv.payments.filter((p) => revenue.has(p.transactionRef)).reduce((s, p) => s + toRappen(p.amount), 0));
  if (day === inv.date) return { day, amount: whole };
  const point = lockedTaxPoint(lock, inv.date, filing().length);
  if (point === 'switch') {
    const line = lock.lockedThrough ?? inv.date;
    return { day, amount: inv.kind === 'credit-note' ? refundDueOn(inv, invoices, line) : openOn(inv, invoices, line) };
  }
  return { day, amount: whole, ...(inv.kind === 'invoice' ? { corrects: point.corrects } : {}) };
}

/**
 * The issued documents dated on or before `through` whose event the books lack and would book
 * (a foreign one whose day had no rate yet, EventOutcome.skipped): no return of the agreed basis
 * is written over them (src/workflows/filing.ts). Empty on the cash basis.
 */
export function eventsMissing(books: Books, book: InvoiceBook, through: string): string[] {
  if (!agreedBasis()) return [];
  const lock = periodLock(books);
  const invoices = liveInvoices(book);
  const refs = new Set(books.journalEntries.map((e) => e.transactionRef));
  return invoices.flatMap((inv) => (inv.status === 'issued' && !inv.cancelled && inv.date <= through && !refs.has(eventRef(inv, 'issue'))
    && eventPlan(books, inv, invoices, lock).amount > 0 ? [inv.number] : []));
}

/**
 * Books the events of every issued document the books do not carry yet, on the agreed basis only
 * (call inside the write door, update in src/books/store.ts), each for its eventAmount.
 */
export function bookInvoiceEvents(books: Books, book: InvoiceBook, ctx: PaymentContext): EventOutcome {
  const out: EventOutcome = { booked: [], skipped: [], files: [] };
  if (!agreedBasis()) return out;
  const lock = periodLock(books);
  const invoices = liveInvoices(book);
  const refs = new Set(books.journalEntries.map((e) => e.transactionRef));
  for (const inv of invoices) {
    if (inv.status !== 'issued') continue;
    const issueRef = eventRef(inv, 'issue');
    if (!refs.has(issueRef) && !inv.cancelled) {
      const { day, amount, corrects } = eventPlan(books, inv, invoices, lock);
      if (amount <= 0) continue;
      // A foreign document converts at the rate of its tax point (MWSTV Art. 45): its own day when it corrects its period.
      const rate = inv.currency === baseCurrency() ? undefined : ctx.fx.daily(inv.currency, corrects ? inv.date : day);
      if (inv.currency !== baseCurrency() && rate === undefined) { out.skipped.push({ number: inv.number, reason: 'rate' }); continue; }
      const receipt = invoiceReceipt(books, inv, ctx, out, { date: day });
      const credit = inv.kind === 'credit-note';
      const text = `${credit ? TEXTS.de.credit : TEXTS.de.invoice} ${inv.number} ${inv.customer.name}`;
      // A part below zero (revenueLines `minus`) books the other way with the minus code, as a credit note does.
      const entries = revenueLines(inv, amount, ctx.revenueAccount).map((l): JournalEntry => { const back = credit !== !!l.minus; return {
        id: idSource.bytes(8).toString('hex'),
        transactionRef: issueRef,
        date: day,
        accountDebit: back ? l.account : ctx.openItems.receivable,
        accountCredit: back ? ctx.openItems.receivable : l.account,
        amount: l.amount,
        ...(l.vatCode ? { vatCode: back ? vat().codes.negativePrefix + l.vatCode : l.vatCode } : {}),
        description: text,
        ...(rate !== undefined ? { exchangeCurrency: inv.currency, exchangeRate: rate } : {}),
        ...(corrects ? { corrects } : {}),
        origin: 'invoice',
        receipts: [receipt],
      }; });
      books.journalEntries.push(...entries);
      link(books, issueRef, receipt);
      refs.add(issueRef);
      out.booked.push({ number: inv.number, kind: 'issue', date: day });
    }
    // Write-offs recorded while the event was missing (a foreign document without its day's rate yet): booked with it.
    if (refs.has(issueRef)) {
      for (const w of inv.writeOffs ?? []) {
        if (refs.has(writeOffRef(inv, w.id))) continue;
        bookWriteOff(books, inv, w, ctx, out);
        refs.add(writeOffRef(inv, w.id));
      }
    }
    const stornoRef = eventRef(inv, 'storno');
    if (inv.cancelled && refs.has(issueRef) && !refs.has(stornoRef)) {
      const day = openDay(lock, inv.cancelled.date);
      // The write-offs go with the claim: the storno reverses them too, so the receivable nets to zero; so do the
      // reclassifications «Konten ändern» booked for it (`-kk-`), so no revenue account keeps a part of it.
      const issued = books.journalEntries.filter((e) => e.transactionRef === issueRef || e.transactionRef.startsWith(`${issueRef}-kk-`) || (inv.writeOffs ?? []).some((w) => e.transactionRef === writeOffRef(inv, w.id)));
      const text = `Storno ${TEXTS.de.invoice} ${inv.number} ${inv.customer.name}`;
      books.journalEntries.push(...issued.map((e): JournalEntry => ({
        ...reversalOf(e, day, text),
        id: idSource.bytes(8).toString('hex'),
        transactionRef: stornoRef,
        origin: 'invoice',
        ...(e.receipts ? { receipts: e.receipts } : {}),
      })));
      for (const r of new Set(issued.flatMap((e) => e.receipts ?? []))) link(books, stornoRef, r);
      refs.add(stornoRef);
      out.booked.push({ number: inv.number, kind: 'storno', date: day });
    }
  }
  return out;
}

/**
 * The entries of a write-off on a document whose event the books carry (the agreed basis):
 * `RE-<n>-wo-<k>` on its date, the Skonto account (Skonto, Rabatt, Spesen, Rundung) or the loss
 * account against the receivable, the invoice's mix of rates with the minus sale codes, one line
 * per code, at the rate the receivable holds; the account joins the chart when it lacks it.
 */
const REASON_WORDS: Record<WriteOffReason, string> = { skonto: 'Skonto', discount: 'Rabatt', loss: 'Verlust', fee: 'Spesen', rounding: 'Rundung' };

export function bookWriteOff(books: Books, inv: Issued, w: WriteOff, ctx: PaymentContext, out: Pick<PaymentOutcome, 'files'>): JournalEntry[] {
  const accounts = ctx.writeOffAccount ?? writeOffAccounts(undefined);
  if (!accounts) throw new Error('the jurisdiction names no write-off accounts (modules/<j>/invoicing.yaml writeOff)');
  const account = w.reason === 'loss' ? accounts.loss : accounts.skonto;
  ctx.ensureAccount?.(account);
  const ref = writeOffRef(inv, w.id);
  const rate = books.journalEntries.find((e) => e.transactionRef === eventRef(inv, 'issue'))?.exchangeRate;
  // A write-off recorded while the event waited for its rate is booked with the event, on the first day the books take.
  const day = openDay(periodLock(books), w.date);
  const receipt = invoiceReceipt(books, inv, ctx, out, { date: day });
  // One line per code: the invoice's accounts and rates, the revenue account no matter here.
  const byCode = new Map<string, number>();
  for (const l of revenueSplit(inv, w.amount, ctx.revenueAccount)) byCode.set(l.vatCode ?? '', (byCode.get(l.vatCode ?? '') ?? 0) + Math.round(l.amount * 100));
  const text = `${REASON_WORDS[w.reason]} ${TEXTS.de.invoice} ${inv.number} ${inv.customer.name}`;
  // A code below zero (a deduction's rate) takes the write-off the other way, with the plain code, never a negative amount.
  const entries = [...byCode].filter(([, rappen]) => rappen !== 0).map(([code, rappen]): JournalEntry => ({
    id: idSource.bytes(8).toString('hex'), transactionRef: ref, date: day,
    accountDebit: rappen > 0 ? account : ctx.openItems.receivable, accountCredit: rappen > 0 ? ctx.openItems.receivable : account, amount: Math.abs(rappen) / 100,
    ...(code ? { vatCode: rappen > 0 ? vat().codes.negativePrefix + code : code } : {}),
    description: text,
    ...(rate !== undefined ? { exchangeCurrency: inv.currency, exchangeRate: rate } : {}),
    origin: 'invoice', receipts: [receipt],
  }));
  books.journalEntries.push(...entries);
  if (!books.mappings.some((m) => m.transactionRef === ref && m.receiptId === receipt)) books.mappings.push({ transactionRef: ref, receiptId: receipt, by: 'rule', rule: 'invoice-issue' });
  return entries;
}

/** The document's PDF as a receipt of the books (a sales record), filed once; its id. */
export function invoiceReceipt(books: Books, inv: Issued, ctx: Pick<PaymentContext, 'pdfOf' | 'receiptId' | 'indexedAt'>, out: Pick<PaymentOutcome, 'files'>, at: Pick<BankTransaction, 'date'>): string {
  const word = inv.kind === 'credit-note' ? TEXTS.de.credit : TEXTS.de.invoice;
  const pdf = ctx.pdfOf(inv);
  const id = ctx.receiptId(pdf);
  if (books.receipts.some((r) => r.id === id)) return id;
  // Issued again after «Zurück zum Entwurf»: a name of its own, so the file of the replaced PDF's receipt is never taken for it.
  const filename = `${inv.date.replace(/-/g, '')}-${word.toLowerCase()}-${inv.number}${inv.replaced?.length ? `-${id.slice(0, 8)}` : ''}.pdf`;
  const t = totals(inv);
  const receipt: Receipt = {
    id,
    filename,
    originalFilename: filename,
    extractedText: [inv.sender.name, `${word} ${inv.number}`, inv.customer.name, ...inv.lines.flatMap((l) => (l.kind === 'pagebreak' ? [] : [l.text])), `Total ${inv.currency} ${t.gross.toFixed(2)}`].join('\n'),
    extractionMethod: 'pdftotext',
    fileSize: pdf.length,
    indexedAt: ctx.indexedAt(at),
    location: 'archived',
    date: inv.date,
    description: `${word} ${inv.number} ${inv.customer.name}`,
    amount: t.gross,
    currency: inv.currency,
    vatId: inv.sender.uid,
    hasSwissVat: t.vat > 0,
    vatSummary: t.byRate.map((r) => ({ ratePercent: r.rate, net: r.net, vat: r.vat, gross: r.gross })),
    kind: 'sales-record',
  };
  books.receipts.push(receipt);
  out.files.push({ filename, pdf });
  return id;
}

function link(books: Books, ref: string, receiptId: string): void {
  const m: Mapping = { transactionRef: ref, receiptId, by: 'rule', rule: 'invoice-issue' };
  if (!books.mappings.some((x) => x.transactionRef === ref && x.receiptId === receiptId)) books.mappings.push(m);
}
