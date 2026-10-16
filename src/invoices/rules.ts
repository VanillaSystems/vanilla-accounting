/**
 * The rules of invoicing as pure functions: totals, status, numbering, what an invoice needs
 * before it is issued (Art. 26 MWSTG), issuing, cancelling, credit notes, reminders and how a
 * payment is split. No file is read or written here (src/invoices/service.ts does that).
 */
import { fromRappen, roundCHF, toRappen } from '../accounting/rappen.js';
import { TEXTS, formatDate } from './texts.js';
import type {
  Comment, Customer, CustomerFields, Draft, Envelope, Exemption, Invoice, InvoiceBook, InvoiceContent, InvoiceLayout,
  InvoiceLine, Issued, PaymentAllocation, Reminder, Sender, VatRate,
} from './model.js';
import { chargesVat, invoiceRates, invoicing, vat, vatSetup } from '../engines/index.js';
import { parseReference, referenceFor } from '../providers/qr-bill/reference.js';
import type { BankTransaction } from '../types/index.js';

// ─── totals ──────────────────────────────────────────────────────────────────

export interface RateTotal { rate: VatRate; net: number; vat: number; gross: number }
export interface Totals { byRate: RateTotal[]; net: number; vat: number; gross: number }

export const lineAmount = (l: Pick<InvoiceLine, 'quantity' | 'price'>): number => roundCHF(l.quantity * l.price);

/**
 * Net per line to the Rappen, VAT per rate on the rate's net, to the Rappen. No 5-Rappen rounding:
 * a QR-bill is paid by transfer to the Rappen, and the books carry no rounding line.
 */
export function totals(lines: readonly InvoiceLine[]): Totals {
  const net = new Map<VatRate, number>();
  for (const l of lines) net.set(l.vatRate, (net.get(l.vatRate) ?? 0) + toRappen(lineAmount(l)));
  const byRate = [...net].sort(([a], [b]) => b - a).map(([rate, n]) => {
    const v = toRappen(fromRappen(n) * rate / 100);
    return { rate, net: fromRappen(n), vat: fromRappen(v), gross: fromRappen(n + v) };
  });
  const sum = (k: 'net' | 'vat' | 'gross') => fromRappen(byRate.reduce((s, r) => s + toRappen(r[k]), 0));
  return { byRate, net: sum('net'), vat: sum('vat'), gross: sum('gross') };
}

// ─── status ──────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'draft' | 'issued' | 'partly-paid' | 'paid' | 'cancelled';

const live = <T extends Envelope>(xs: readonly T[]) => xs.filter((x) => !x.deleted);

/** The credit notes issued for an invoice (by `asOf`, when given), cancelled ones left out. */
export function creditNotesOf(inv: Invoice, invoices: readonly Invoice[], asOf?: string): Issued[] {
  return live(invoices).filter((c): c is Issued => c.status === 'issued' && c.kind === 'credit-note' && c.creditFor === inv.id && !c.cancelled && (!asOf || c.date <= asOf));
}

export const paidAmount = (inv: Issued): number => fromRappen(inv.payments.reduce((s, p) => s + toRappen(p.amount), 0));

/**
 * What the customer still owes: the total, less payments and the credit notes issued for it
 * (by `asOf`: a credit note written after a payment does not make that payment too much). Never below 0.
 */
export function openAmount(inv: Invoice, invoices: readonly Invoice[], asOf?: string): number {
  if (inv.status !== 'issued' || inv.kind === 'credit-note' || inv.cancelled) return 0;
  const credited = creditNotesOf(inv, invoices, asOf).reduce((s, c) => s - toRappen(totals(c.lines).gross), 0);
  return fromRappen(Math.max(0, toRappen(totals(inv.lines).gross) - toRappen(paidAmount(inv)) - credited));
}

/**
 * What the customer owed at the end of `date`: an invoice issued by then and not cancelled by
 * then, less the payments and credit notes dated by then. The year-end's receivables (ADR 0010).
 */
export function openOn(inv: Invoice, invoices: readonly Invoice[], date: string): number {
  if (inv.status !== 'issued' || inv.kind === 'credit-note' || inv.date > date || (inv.cancelled && inv.cancelled.date <= date)) return 0;
  const credited = creditNotesOf(inv, invoices, date).reduce((s, c) => s - toRappen(totals(c.lines).gross), 0);
  const paid = inv.payments.filter((p) => p.date <= date).reduce((s, p) => s + toRappen(p.amount), 0);
  return fromRappen(Math.max(0, toRappen(totals(inv.lines).gross) - paid - credited));
}

/**
 * What a credit note still pays back: the part of it beyond what its invoice still owed when it
 * was issued (with `settlement: 'refund'`, the default), less the refunds made. 0 when it is set off
 * against the next invoice, cancelled, or a draft.
 */
export function refundDue(cn: Invoice, invoices: readonly Invoice[]): number {
  if (cn.status !== 'issued' || cn.kind !== 'credit-note' || cn.cancelled || cn.settlement === 'offset') return 0;
  const target = live(invoices).find((i) => i.id === cn.creditFor);
  if (!target || target.status !== 'issued') return 0;
  const earlier = creditNotesOf(target, invoices).filter((c) => c.id !== cn.id && (c.date < cn.date || (c.date === cn.date && c.issuedAt < cn.issuedAt)));
  const owed = toRappen(totals(target.lines).gross) - toRappen(paidAmount(target)) + earlier.reduce((s, c) => s + toRappen(totals(c.lines).gross), 0);
  const back = Math.max(0, -toRappen(totals(cn.lines).gross) - Math.max(0, owed));
  return fromRappen(Math.max(0, back - toRappen(paidAmount(cn))));
}

/** The text names the document's number, not as part of a longer number ("Rechnung 2026-005", "RE2026-005/Garage"). */
/**
 * The issued document a payment names: by its structured reference, else the one whose number its
 * text carries. A cancelled invoice too: the hand form then says so instead of booking revenue (r8c-5).
 */
export function namedInvoice(tx: Pick<BankTransaction, 'reference' | 'description' | 'counterparty' | 'parts'>, invoices: readonly Invoice[]): Issued | undefined {
  const issued = invoices.filter((i): i is Issued => i.status === 'issued' && !i.deleted);
  const refs = [tx.reference, ...(tx.parts ?? []).map((p) => p.reference)].flatMap((r) => (r ? [parseReference(r)?.reference] : []));
  const byRef = issued.find((i) => refs.includes(i.reference));
  if (byRef) return byRef;
  const text = [tx.description, tx.reference, tx.counterparty, ...(tx.parts ?? []).flatMap((p) => [p.reference, p.counterparty])].filter(Boolean).join(' ');
  const named = issued.filter((i) => namesNumber(text, i.number));
  return named.length === 1 ? named[0] : undefined;
}

export const namesNumber = (text: string, number: string): boolean => new RegExp(`(?<![0-9])${number.replace(/[^0-9A-Za-z]/g, (c) => `\\${c}`)}(?![0-9])`).test(text);

/** Reminder fees not paid yet. */
export function openFees(inv: Issued): number {
  const charged = inv.reminders.reduce((s, r) => s + toRappen(r.fee ?? 0), 0);
  const paid = inv.payments.reduce((s, p) => s + toRappen(p.fee ?? 0), 0);
  return fromRappen(Math.max(0, charged - paid));
}

export function status(inv: Invoice, invoices: readonly Invoice[]): InvoiceStatus {
  if (inv.status === 'draft') return 'draft';
  if (inv.cancelled) return 'cancelled';
  if (inv.kind === 'credit-note') return 'issued';
  if (openAmount(inv, invoices) === 0) return 'paid';
  return inv.payments.length ? 'partly-paid' : 'issued';
}

export function isOverdue(inv: Invoice, invoices: readonly Invoice[], today: string): boolean {
  return inv.status === 'issued' && openAmount(inv, invoices) > 0 && inv.dueDate < today;
}

// ─── numbering ───────────────────────────────────────────────────────────────

/**
 * The next number of the invoice date's year, YYYY-NNN: one more than the highest number that
 * year has given, cancelled invoices included, so no number is ever given twice. Drafts have none.
 */
export function nextNumber(invoices: readonly Invoice[], date: string): string {
  const year = date.slice(0, 4);
  const taken = invoices
    .filter((i): i is Issued => i.status === 'issued' && i.number.startsWith(`${year}-`))
    .map((i) => Number(i.number.slice(5)));
  return `${year}-${String(Math.max(0, ...taken) + 1).padStart(3, '0')}`;
}

// ─── issuing ─────────────────────────────────────────────────────────────────

export const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/** Why an invoice cannot be issued yet. `line` is the index of the line it concerns. */
export interface Missing { field: MissingField; line?: number }
export type MissingField =
  | 'sender.name' | 'sender.address' | 'sender.uid' | 'payTo'
  | 'customer' | 'customer.name' | 'customer.address'
  | 'date' | 'lines' | 'line.text' | 'line.quantity' | 'line.vatRate' | 'exemption'
  | 'credit.invoice' | 'credit.sign' | 'credit.exceeds';

const hasAddress = (a: { postcode?: string; town?: string; country?: string } | undefined) => !!(a?.postcode?.trim() && a.town?.trim() && a.country?.trim());

/**
 * What Art. 26 Abs. 2 MWSTG asks of an invoice, checked before issue: the supplier's name, address
 * and VAT number, the recipient's name and address, the date, the description of each supply, its
 * amount and VAT rate, and for a supply without Swiss VAT the reason. The date of supply is the
 * invoice date unless a line says otherwise. Plus what the QR-bill needs: an account to pay to.
 */
export function missingForIssue(draft: InvoiceContent, ctx: {
  customer: CustomerFields | undefined; sender: Partial<Omit<Sender, 'payTo'>> & { payTo?: Sender['payTo'] }; invoices: readonly Invoice[];
}): Missing[] {
  const out: Missing[] = [];
  const { customer, sender } = ctx;
  if (!sender.name?.trim()) out.push({ field: 'sender.name' });
  if (!sender.address || !sender.address.street?.trim() || !hasAddress(sender.address)) out.push({ field: 'sender.address' });
  if (!sender.uid?.trim()) out.push({ field: 'sender.uid' });
  if (!sender.payTo) out.push({ field: 'payTo' });
  if (!customer) out.push({ field: 'customer' });
  else {
    if (!customer.name.trim()) out.push({ field: 'customer.name' });
    if (!hasAddress(customer.address)) out.push({ field: 'customer.address' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) out.push({ field: 'date' });
  if (draft.lines.length === 0) out.push({ field: 'lines' });
  draft.lines.forEach((l, line) => {
    if (!l.text.trim()) out.push({ field: 'line.text', line });
    if (!Number.isFinite(l.quantity) || l.quantity === 0 || !Number.isFinite(l.price)) out.push({ field: 'line.quantity', line });
    if (!invoiceRates().includes(l.vatRate)) out.push({ field: 'line.vatRate', line });
  });
  // A firm not registered charges no VAT: a line at 0 % needs no reason.
  if (chargesVat() && draft.lines.some((l) => l.vatRate === 0) && !draft.exemption) out.push({ field: 'exemption' });
  if (draft.kind === 'credit-note') {
    const target = ctx.invoices.find((i) => i.id === draft.creditFor && !i.deleted);
    if (!target || target.status !== 'issued' || target.kind !== 'invoice' || target.cancelled) out.push({ field: 'credit.invoice' });
    const gross = totals(draft.lines).gross;
    if (gross >= 0) out.push({ field: 'credit.sign' });
    else if (target?.status === 'issued') {
      const already = creditNotesOf(target, ctx.invoices).reduce((s, c) => s - toRappen(totals(c.lines).gross), 0);
      if (-toRappen(gross) + already > toRappen(totals(target.lines).gross)) out.push({ field: 'credit.exceeds' });
    }
  }
  return out;
}

export class InvoiceRuleError extends Error {
  constructor(readonly code: InvoiceRefusal, message: string, readonly missing?: Missing[]) { super(message); }
}
export type InvoiceRefusal = 'incomplete' | 'notDraft' | 'notIssued' | 'cancelled' | 'paid' | 'creditNote' | 'nothingOpen' | 'notFound' | 'changed';

/**
 * The draft as an issued invoice: its number (the next of the year), its due date, its payment
 * reference, and a frozen copy of the customer, the sender and the layout. The PDF is added by
 * the caller once the issued invoice is rendered.
 */
export function issue(draft: Draft, ctx: {
  customer: Customer | undefined; sender: Sender | Omit<Sender, 'payTo'>; layout: InvoiceLayout; invoices: readonly Invoice[]; now: string;
}): Omit<Issued, 'pdf'> {
  if (draft.status !== 'draft' || draft.deleted) throw new InvoiceRuleError('notDraft', 'Nur ein Entwurf kann ausgestellt werden.');
  const missing = missingForIssue(draft, { ...ctx, sender: ctx.sender });
  if (missing.length || !ctx.customer || !('payTo' in ctx.sender)) {
    throw new InvoiceRuleError('incomplete', `Für eine MWST-konforme Rechnung fehlt: ${missing.map((m) => m.field + (m.line === undefined ? '' : ` (Position ${m.line + 1})`)).join(', ')}.`, missing);
  }
  const { comments, status: _, ...content } = draft;
  const number = nextNumber(ctx.invoices, draft.date);
  const { id: _id, createdAt: _c, origin: _o, deleted: _d, ...customer } = ctx.customer;
  return {
    ...content,
    status: 'issued',
    number,
    issuedAt: ctx.now,
    dueDate: draft.dueDate ?? addDays(draft.date, ctx.customer.paymentTermsDays),
    reference: referenceFor(number, ctx.sender.payTo),
    customer,
    sender: ctx.sender,
    layout: ctx.layout,
    payments: [],
    reminders: [],
    comments,
  };
}

/** A draft can be deleted (a flag, ADR 0004); an issued invoice never is. */
export function deleteDraft(inv: Invoice): Invoice {
  if (inv.status !== 'draft') throw new InvoiceRuleError('notDraft', 'Eine ausgestellte Rechnung wird storniert, nicht gelöscht.');
  return { ...inv, deleted: true };
}

/**
 * A cancellation (Storno) keeps the number and the invoice on file, with date and reason, and
 * takes it off the open invoices. A paid invoice is not cancelled: the money goes back through a
 * credit note for the full amount.
 */
export function cancel(inv: Invoice, c: { date: string; reason: string }): Issued {
  if (inv.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Ein Entwurf wird gelöscht, nicht storniert.');
  if (inv.cancelled) throw new InvoiceRuleError('cancelled', `Rechnung ${inv.number} ist schon storniert.`);
  if (inv.payments.length) throw new InvoiceRuleError('paid', `Rechnung ${inv.number} ist bezahlt: eine Gutschrift über den ganzen Betrag schreiben, nicht stornieren.`);
  return { ...inv, cancelled: { date: c.date, reason: c.reason.trim() } };
}

// ─── credit notes ────────────────────────────────────────────────────────────

export interface CreditRequest {
  /** The whole invoice, or a part: a gross amount (VAT included), split over the invoice's rates by their share. */
  amount?: number;
  /** A part of the total at one rate only (the lines it concerns); absent: split over every rate by its share. */
  vatRate?: VatRate;
  reason: string;
  settlement?: 'refund' | 'offset';
}

/** A credit note drafted from an invoice: its lines with negated prices (or a part of its total, one line per rate), the same customer, currency and language. */
export function creditNoteDraft(inv: Invoice, req: CreditRequest, envelope: Envelope, date: string): Draft {
  if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new InvoiceRuleError('notIssued', 'Eine Gutschrift bezieht sich auf eine ausgestellte Rechnung.');
  if (inv.cancelled) throw new InvoiceRuleError('cancelled', `Rechnung ${inv.number} ist storniert.`);
  const t = totals(inv.lines);
  const reason = req.reason.trim();
  let lines: InvoiceLine[];
  if (req.amount === undefined) {
    lines = inv.lines.map((l) => ({ ...l, text: reason ? `${l.text} (${reason})` : l.text, price: -l.price }));
  } else {
    const gross = toRappen(req.amount);
    if (gross <= 0 || gross > toRappen(t.gross)) throw new InvoiceRuleError('incomplete', 'Der Betrag einer Gutschrift liegt zwischen 0 und dem Total der Rechnung.');
    const text = reason || `${TEXTS[inv.language].credit} ${inv.number}`;
    const rates = req.vatRate === undefined ? t.byRate : t.byRate.filter((r) => r.rate === req.vatRate);
    if (rates.length === 0) throw new InvoiceRuleError('incomplete', `Rechnung ${inv.number} hat keine Position mit ${req.vatRate} %.`);
    const base = rates.reduce((s, r) => s + toRappen(r.gross), 0);
    let left = gross;
    lines = rates.map((r, k) => {
      const share = k === rates.length - 1 ? left : Math.round(gross * toRappen(r.gross) / base);
      left -= share;
      const net = fromRappen(Math.round(share * 100 / (100 + r.rate)));
      const account = inv.lines.find((l) => l.vatRate === r.rate)?.account;
      return { text: rates.length > 1 ? `${text} (${r.rate} %)` : text, quantity: 1, price: -net, vatRate: r.rate, ...(account ? { account } : {}) };
    }).filter((l) => l.price !== 0);
  }
  return {
    ...envelope,
    status: 'draft',
    kind: 'credit-note',
    customerId: inv.customerId,
    date,
    currency: inv.currency,
    language: inv.language,
    subject: `${TEXTS[inv.language].forInvoice} ${inv.number}`,
    lines,
    ...(inv.exemption ? { exemption: inv.exemption } : {}),
    creditFor: inv.id,
    ...(req.settlement ? { settlement: req.settlement } : {}),
    comments: [],
  };
}

// ─── reminders ───────────────────────────────────────────────────────────────

export const REMINDER_DAYS = 10;
export const MAX_REMINDER_LEVEL = 3;

/** The next reminder of an open invoice, drafted in the invoice's language: level, due date and texts the user may change before sending. */
export function reminderDraft(inv: Invoice, invoices: readonly Invoice[], date: string, fee?: number): Omit<Reminder, 'documentId'> {
  if (inv.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Nur eine ausgestellte Rechnung wird gemahnt.');
  if (inv.kind === 'credit-note') throw new InvoiceRuleError('creditNote', 'Eine Gutschrift wird nicht gemahnt.');
  if (inv.cancelled) throw new InvoiceRuleError('cancelled', `Rechnung ${inv.number} ist storniert.`);
  if (openAmount(inv, invoices) === 0) throw new InvoiceRuleError('nothingOpen', `Rechnung ${inv.number} ist bezahlt.`);
  const level = Math.min(MAX_REMINDER_LEVEL, (inv.reminders.at(-1)?.level ?? 0) + 1);
  const L = TEXTS[inv.language];
  const d = (iso: string) => formatDate(iso, inv.language);
  const previous = inv.reminders.filter((r) => r.level < level).at(-1);
  return {
    level,
    date,
    dueDate: addDays(date, REMINDER_DAYS),
    ...(fee ? { fee: roundCHF(fee) } : {}),
    intro: L.reminderIntro(level, inv.number, d(inv.date), d(inv.dueDate), previous && d(previous.date)),
    closing: L.reminderClosing,
  };
}

// ─── payments ────────────────────────────────────────────────────────────────

/**
 * How a payment of `amount` (the invoice's currency) on `date` settles an invoice: first what is open, then
 * unpaid reminder fees. `surplus` is money beyond both: a question for a person, never booked.
 */
export function allocate(inv: Issued, invoices: readonly Invoice[], amount: number, date?: string): { amount: number; fee: number; surplus: number } {
  const pay = toRappen(amount);
  const open = toRappen(openAmount(inv, invoices, date));
  const toInvoice = Math.min(pay, open);
  const fee = Math.min(pay - toInvoice, toRappen(openFees(inv)));
  return { amount: fromRappen(toInvoice), fee: fromRappen(fee), surplus: fromRappen(pay - toInvoice - fee) };
}

/**
 * The VAT code a rate books revenue with (cash basis: when the money arrives): the rate's sale
 * code, the firm's first net rate on the net tax rate method, none for a firm not registered.
 */
export function revenueVatCode(rate: VatRate, exemption: Exemption | undefined): string | undefined {
  if (!vatSetup().registered) return undefined;
  const code = rate === 0 ? vat().codes.deductedIn(invoicing().exemptions[exemption ?? 'export']) : vat().codes.saleAt(rate) ?? vat().codes.netRateCode(1);
  if (!code) throw new Error(`the jurisdiction has no code for a sale at ${rate} %${exemption ? ` (${exemption})` : ''}`);
  return code;
}

/**
 * The revenue a payment of `amount` books, split like the invoice's total over its accounts and
 * rates, so a part payment books the same mix as the whole. The parts add up to `amount` exactly.
 */
export function revenueSplit(inv: Pick<InvoiceContent, 'lines' | 'exemption'>, amount: number, revenueAccount: string): Array<{ account: string; vatCode: string | undefined; amount: number }> {
  const groups = new Map<string, { account: string; rate: VatRate; gross: number }>();
  for (const [rate, lines] of groupBy(inv.lines, (l) => l.vatRate)) {
    const rt = totals(lines);
    for (const [account, ls] of groupBy(lines, (l) => l.account ?? revenueAccount)) {
      // the rate's VAT goes to its accounts by their share of its net
      const net = toRappen(totals(ls).net);
      const share = toRappen(rt.net) === 0 ? 0 : Math.round(toRappen(rt.vat) * net / toRappen(rt.net));
      groups.set(`${account} ${rate}`, { account, rate, gross: net + share });
    }
  }
  const all = [...groups.values()];
  const whole = all.reduce((s, g) => s + g.gross, 0);
  const pay = toRappen(amount);
  let left = pay;
  return all.map((g, k) => {
    const part = k === all.length - 1 ? left : whole === 0 ? 0 : Math.round(pay * g.gross / whole);
    left -= part;
    return { account: g.account, vatCode: revenueVatCode(g.rate, inv.exemption), amount: fromRappen(part) };
  }).filter((p) => p.amount !== 0);
}

function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return out;
}

/** Records a payment on an invoice once: the same transaction is never counted twice. */
export function withPayment(inv: Issued, p: PaymentAllocation): Issued {
  if (inv.payments.some((x) => x.transactionRef === p.transactionRef)) return inv;
  return { ...inv, payments: [...inv.payments, p] };
}

/** The book without deleted records. */
export const liveInvoices = (book: InvoiceBook): Invoice[] => live(book.invoices);
export const liveCustomers = (book: InvoiceBook): Customer[] => live(book.customers);
