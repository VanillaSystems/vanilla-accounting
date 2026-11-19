/**
 * The rules of invoicing as pure functions: totals, status, numbering, what an invoice needs
 * before it is issued (Art. 26 MWSTG), issuing, cancelling, credit notes, reminders and how a
 * payment is split. No file is read or written here (src/invoices/service.ts does that).
 */
import { fromRappen, roundCHF, toRappen } from '../accounting/rappen.js';
import { TEXTS, formatDate } from './texts.js';
import type {
  Comment, Customer, CustomerFields, Draft, Envelope, Exemption, Invoice, InvoiceBook, InvoiceContent, InvoiceLayout,
  InvoiceLine, InvoicingSettings, Issued, ItemLine, PaymentAllocation, Prices, Reminder, Sender, UnitDef, VatRate,
} from './model.js';
import { isItem } from './model.js';
import { chargesVat, invoiceActivities, invoiceRates, invoicing, vat, vatSetup } from '../engines/index.js';
import { parseReference, referenceFor } from '../providers/qr-bill/reference.js';
import type { BankTransaction } from '../types/index.js';

// ─── totals ──────────────────────────────────────────────────────────────────

export interface RateTotal { rate: VatRate; net: number; vat: number; gross: number }
export interface Totals { byRate: RateTotal[]; net: number; vat: number; gross: number }

/** What a document's totals are computed from: its positions and whether their prices are net or gross. */
export type Priced = { readonly lines: readonly InvoiceLine[]; readonly prices?: Prices };

/** An item position's amount: quantity × price to the Rappen, less its discount (to the Rappen). */
export function lineAmount(l: Pick<ItemLine, 'quantity' | 'price' | 'discount'>): number {
  const base = toRappen(l.quantity * l.price);
  return fromRappen(l.discount ? base - toRappen(fromRappen(base) * l.discount / 100) : base);
}

/** Whether an item position's price has the VAT in it: its own legacy flag, else its document's prices. */
export const pricedGross = (l: ItemLine, prices: Prices | undefined): boolean => l.vatIncluded ?? prices === 'gross';

/**
 * A priced part of a document, in Rappen: an item position, or a Rabatt's share of one group of the
 * positions above it. `line` is the item position whose rate, account and pricing the part carries.
 */
export interface Part { line: ItemLine; gross: boolean; rappen: number }

/**
 * The attributes a Rabatt is split by and the revenue is grouped by: rate, pricing, account and the
 * net-rate activity (a part per group of them). A new attribute of a position that books apart joins here.
 */
const splitKey = (p: Part): string => `${p.line.vatRate}|${p.gross}|${p.line.account ?? ''}|${p.line.activity ?? 1}`;

/** `total` (Rappen) over `weights` in proportion, by largest remainder: the parts add up to `total` exactly. */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((x) => Math.trunc(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [Math.abs(x - out[i]), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const step = Math.sign(left);
  for (let k = 0; left !== 0; k++) { out[order[k % order.length][1]] += step; left -= step; }
  return out;
}

/**
 * The document's parts and each position's printed amount. An item is one part. A Rabatt takes its
 * percent of (or its amount off) the running total above it, the earlier Rabatte included, and
 * splits it over the groups of that total (splitKey) in proportion, to the Rappen, so the rates,
 * the VAT and the gross add up exactly; a minus percent or amount is a surcharge. On a credit note
 * (negative positions) a Rabatt reduces the credit the same way. A Zwischentotal prints the item
 * positions since the last one or the start; a text and a page break have no amount.
 */
export function priced(doc: Priced): { parts: Part[]; amounts: Array<number | undefined> } {
  const parts: Part[] = [];
  let since = 0;
  const amounts = doc.lines.map((l): number | undefined => {
    if (isItem(l)) {
      const rappen = toRappen(lineAmount(l));
      parts.push({ line: l, gross: l.vatRate > 0 && pricedGross(l, doc.prices), rappen });
      since += rappen;
      return fromRappen(rappen);
    }
    if (l.kind === 'subtotal') { const sum = since; since = 0; return fromRappen(sum); }
    if (l.kind !== 'discount') return undefined;
    const groups = new Map<string, Part>();
    for (const p of parts) {
      const g = groups.get(splitKey(p));
      groups.set(splitKey(p), { ...(g ?? p), rappen: (g?.rappen ?? 0) + p.rappen });
    }
    const base = [...groups.values()];
    const sum = base.reduce((s, p) => s + p.rappen, 0);
    const total = l.percent !== undefined ? -toRappen(fromRappen(sum) * l.percent / 100) : -toRappen(l.amount ?? 0) * Math.sign(sum);
    const shares = apportion(total, base.map((p) => p.rappen));
    base.forEach((p, k) => { if (shares[k]) parts.push({ ...p, rappen: shares[k] }); });
    return fromRappen(shares.reduce((s, x) => s + x, 0));
  });
  return { parts, amounts };
}

/** Each position's printed amount, by index: an item's, a Rabatt's, a Zwischentotal's; undefined for a text or a page break. */
export const lineAmounts = (doc: Priced): Array<number | undefined> => priced(doc).amounts;

/**
 * Per rate, the VAT on the net of its net-priced parts plus the VAT in the total of its parts priced
 * with the VAT in it, each to the Rappen, so such a part keeps its amount exactly. No 5-Rappen
 * rounding: a QR-bill is paid by transfer to the Rappen, and the books carry no rounding line.
 */
function totalsOf(parts: readonly Part[]): Totals {
  const by = new Map<VatRate, { net: number; incl: number }>();
  for (const p of parts) {
    const g = by.get(p.line.vatRate) ?? { net: 0, incl: 0 };
    g[p.gross ? 'incl' : 'net'] += p.rappen;
    by.set(p.line.vatRate, g);
  }
  const byRate = [...by].sort(([a], [b]) => b - a).map(([rate, { net, incl }]) => {
    const onNet = toRappen(fromRappen(net) * rate / 100);
    const inIncl = toRappen(fromRappen(incl) * rate / (100 + rate));
    return { rate, net: fromRappen(net + incl - inIncl), vat: fromRappen(onNet + inIncl), gross: fromRappen(net + onNet + incl) };
  });
  const sum = (k: 'net' | 'vat' | 'gross') => fromRappen(byRate.reduce((s, r) => s + toRappen(r[k]), 0));
  return { byRate, net: sum('net'), vat: sum('vat'), gross: sum('gross') };
}

/** A document's totals per rate and in all: its items and Rabatte, each to the Rappen (totalsOf). */
export const totals = (doc: Priced): Totals => totalsOf(priced(doc).parts);

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
  const credited = creditNotesOf(inv, invoices, asOf).reduce((s, c) => s - toRappen(totals(c).gross), 0);
  return fromRappen(Math.max(0, toRappen(totals(inv).gross) - toRappen(paidAmount(inv)) - credited));
}

/**
 * What the customer owed at the end of `date`: an invoice issued by then and not cancelled by
 * then, less the payments and credit notes dated by then. The year-end's receivables (ADR 0010).
 */
/** What a credit note may still take off an invoice: its total less the credit notes issued before (r8c-14); 0 for a draft, a credit note or a cancelled invoice. */
export function creditable(inv: Invoice, invoices: readonly Invoice[]): number {
  if (inv.status !== 'issued' || inv.kind === 'credit-note' || inv.cancelled) return 0;
  const credited = creditNotesOf(inv, invoices).reduce((s, c) => s - toRappen(totals(c).gross), 0);
  return fromRappen(Math.max(0, toRappen(totals(inv).gross) - credited));
}

export function openOn(inv: Invoice, invoices: readonly Invoice[], date: string): number {
  if (inv.status !== 'issued' || inv.kind === 'credit-note' || inv.date > date || (inv.cancelled && inv.cancelled.date <= date)) return 0;
  const credited = creditNotesOf(inv, invoices, date).reduce((s, c) => s - toRappen(totals(c).gross), 0);
  const paid = inv.payments.filter((p) => p.date <= date).reduce((s, p) => s + toRappen(p.amount), 0);
  return fromRappen(Math.max(0, toRappen(totals(inv).gross) - paid - credited));
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
  const owed = toRappen(totals(target).gross) - toRappen(paidAmount(target)) + earlier.reduce((s, c) => s + toRappen(totals(c).gross), 0);
  const back = Math.max(0, -toRappen(totals(cn).gross) - Math.max(0, owed));
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

/** A payment naming an open invoice without being allocated to it (r9c-3): the year end's Debitoren would count its revenue twice. */
export interface UnlinkedNaming { transactionRef: string; date: string; number: string; currency: string; amount: number }

/**
 * The incoming payments up to `end` whose text names the number of an invoice open on `end` in
 * their currency, while no live document holds them as a payment (r9c-3). Pure over the
 * transactions: the proposals of src/invoices/payments.ts are the richer, interactive view.
 */
export function paymentsNamingOpen(transactions: readonly BankTransaction[], invoices: readonly Invoice[], end: string): UnlinkedNaming[] {
  const alive = live(invoices);
  const allocated = new Set(alive.flatMap((i) => (i.status === 'issued' ? i.payments.map((p) => p.transactionRef) : [])));
  const open = alive.filter((i): i is Issued => i.status === 'issued' && i.kind === 'invoice' && openOn(i, alive, end) > 0);
  const out: UnlinkedNaming[] = [];
  for (const tx of transactions) {
    if (tx.direction !== 'CRDT' || tx.date > end || allocated.has(tx.ref)) continue;
    const text = [tx.description, tx.reference, tx.counterparty, ...(tx.parts ?? []).flatMap((p) => [p.counterparty, p.reference])].filter(Boolean).join(' ');
    for (const inv of open) {
      if (inv.currency === tx.currency && namesNumber(text, inv.number)) out.push({ transactionRef: tx.ref, date: tx.date, number: inv.number, currency: tx.currency, amount: tx.amount });
    }
  }
  return out;
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
  | 'date' | 'lines' | 'line.text' | 'line.quantity' | 'line.price' | 'line.vatRate' | 'line.activity' | 'line.discount' | 'line.discountBase' | 'exemption'
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
  // The VAT number on an invoice with VAT (MWSTG Art. 26 Abs. 2 lit. a); the setup does not ask it (#452), so the first such invoice does.
  if (chargesVat() && !sender.uid?.trim()) out.push({ field: 'sender.uid' });
  if (!sender.payTo) out.push({ field: 'payTo' });
  if (!customer) out.push({ field: 'customer' });
  else {
    if (!customer.name.trim()) out.push({ field: 'customer.name' });
    if (!hasAddress(customer.address)) out.push({ field: 'customer.address' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) out.push({ field: 'date' });
  const items = draft.lines.filter(isItem);
  if (items.length === 0) out.push({ field: 'lines' });
  draft.lines.forEach((l, line) => {
    if (l.kind === 'discount') {
      const value = l.percent ?? l.amount;
      if (value === undefined || !Number.isFinite(value) || value === 0 || (l.percent !== undefined && l.amount !== undefined)) out.push({ field: 'line.discount', line });
      return;
    }
    if (!isItem(l)) return;
    if (!Number.isFinite(l.quantity) || !Number.isFinite(l.price) || (l.discount !== undefined && !Number.isFinite(l.discount))) out.push({ field: 'line.quantity', line });
    if (!invoiceRates().includes(l.vatRate)) out.push({ field: 'line.vatRate', line });
  });
  // A firm not registered charges no VAT: a line at 0 % needs no reason.
  if (chargesVat() && items.some((l) => l.vatRate === 0) && !draft.exemption) out.push({ field: 'exemption' });
  if (draft.kind === 'credit-note') {
    const target = ctx.invoices.find((i) => i.id === draft.creditFor && !i.deleted);
    if (!target || target.status !== 'issued' || target.kind !== 'invoice' || target.cancelled) out.push({ field: 'credit.invoice' });
    const gross = totals(draft).gross;
    if (gross >= 0) out.push({ field: 'credit.sign' });
    else if (target?.status === 'issued') {
      const already = creditNotesOf(target, ctx.invoices).reduce((s, c) => s - toRappen(totals(c).gross), 0);
      if (-toRappen(gross) + already > toRappen(totals(target).gross)) out.push({ field: 'credit.exceeds' });
    }
  }
  return out;
}

/**
 * What issuing warns of and the person may issue with all the same («Trotzdem ausstellen», spec
 * 4.11): an item position without a text (Art. 26 Abs. 2 lit. d MWSTG), or without an amount (lit.
 * e: it prints as 0.00), and a Rabatt with nothing above it to take off.
 */
export function warningsForIssue(draft: Pick<InvoiceContent, 'lines' | 'prices'>): Missing[] {
  const amounts = priced(draft).amounts;
  return draft.lines.flatMap((l, line): Missing[] => {
    // A Rabatt with its value that takes nothing: no position above it.
    if (l.kind === 'discount') return (l.percent || l.amount) && amounts[line] === 0 ? [{ field: 'line.discountBase', line }] : [];
    if (!isItem(l)) return [];
    return [
      ...(!l.text.trim() ? [{ field: 'line.text' as const, line }] : []),
      ...(l.quantity === 0 || l.price === 0 ? [{ field: 'line.price' as const, line }] : []),
    ];
  });
}

export class InvoiceRuleError extends Error {
  constructor(readonly code: InvoiceRefusal, message: string, readonly missing?: Missing[]) { super(message); }
}
/** `unconfirmed`: issuing warns (warningsForIssue) and the request did not carry the person's «Trotzdem ausstellen». */
export type InvoiceRefusal = 'incomplete' | 'unconfirmed' | 'notDraft' | 'notIssued' | 'cancelled' | 'paid' | 'creditNote' | 'nothingOpen' | 'notFound' | 'changed' | 'uid';

/**
 * The draft as an issued invoice: its number (the next of the year), its due date, its payment
 * reference, and a frozen copy of the customer, the sender and the layout. The PDF is added by
 * the caller once the issued invoice is rendered.
 */
export function issue(draft: Draft, ctx: {
  customer: Customer | undefined; sender: Sender | Omit<Sender, 'payTo'>; layout: InvoiceLayout; invoices: readonly Invoice[]; now: string;
  /** The firm's units; those the positions name are frozen with the document. */
  units?: readonly UnitDef[];
  /** The person's «Trotzdem ausstellen» over what warningsForIssue names. */
  confirmed?: boolean;
}): Omit<Issued, 'pdf'> {
  if (draft.status !== 'draft' || draft.deleted) throw new InvoiceRuleError('notDraft', 'Nur ein Entwurf kann ausgestellt werden.');
  const missing = missingForIssue(draft, { ...ctx, sender: ctx.sender });
  const where = (ms: Missing[]) => ms.map((m) => m.field + (m.line === undefined ? '' : ` (Position ${m.line + 1})`)).join(', ');
  if (missing.length || !ctx.customer || !('payTo' in ctx.sender)) {
    throw new InvoiceRuleError('incomplete', `Für eine MWST-konforme Rechnung fehlt: ${where(missing)}.`, missing);
  }
  const warnings = warningsForIssue(draft);
  if (warnings.length && !ctx.confirmed) throw new InvoiceRuleError('unconfirmed', `Eine Position ohne Text oder Betrag: ${where(warnings)}. Sie wird so gedruckt; nur mit «Trotzdem ausstellen».`, warnings);
  const { comments, status: _, ...content } = draft;
  const number = nextNumber(ctx.invoices, draft.date);
  const { id: _id, createdAt: _c, origin: _o, deleted: _d, ...customer } = ctx.customer;
  const named = new Set(draft.lines.flatMap((l) => (isItem(l) && l.unit ? [l.unit] : [])));
  const units = (ctx.units ?? []).filter((u) => named.has(u.id));
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
    ...(units.length ? { units: units.map((u) => ({ ...u })) } : {}),
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

/** A credit note drafted from an invoice: its lines with negated prices (or a part of its total, one line per rate at its share, VAT included), the same customer, currency and language. */
export function creditNoteDraft(inv: Invoice, req: CreditRequest, envelope: Envelope, date: string): Draft {
  if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new InvoiceRuleError('notIssued', 'Eine Gutschrift bezieht sich auf eine ausgestellte Rechnung.');
  if (inv.cancelled) throw new InvoiceRuleError('cancelled', `Rechnung ${inv.number} ist storniert.`);
  const t = totals(inv);
  const reason = req.reason.trim();
  let lines: InvoiceLine[];
  // The whole invoice: every position as it stood, the items' prices negated; a Rabatt then reduces the credit as it reduced the invoice.
  let prices = inv.prices;
  if (req.amount === undefined) {
    lines = inv.lines.map((l) => (isItem(l) ? { ...l, text: reason ? `${l.text} (${reason})` : l.text, price: -l.price } : { ...l }));
  } else {
    // A part of the total: gross amounts per rate, so the document is priced gross.
    prices = 'gross';
    const gross = toRappen(req.amount);
    if (gross <= 0 || gross > toRappen(t.gross)) throw new InvoiceRuleError('incomplete', 'Der Betrag einer Gutschrift liegt zwischen 0 und dem Total der Rechnung.');
    const text = reason || `${TEXTS[inv.language].credit} ${inv.number}`;
    const rates = req.vatRate === undefined ? t.byRate : t.byRate.filter((r) => r.rate === req.vatRate);
    if (rates.length === 0) throw new InvoiceRuleError('incomplete', `Rechnung ${inv.number} hat keine Position mit ${req.vatRate} %.`);
    // A rate whose lines belong to both activities of a firm with two net rates is credited in both, by their
    // share (#504), each line named by the first position of its activity; on any other firm, and at 0 %, one line per rate.
    const split = invoiceActivities().length > 0;
    // By the invoice's parts, so a Rabatt lowers each activity's share as it lowered the invoice.
    const priceds = priced(inv).parts;
    const parts = rates.flatMap((r) => [...groupBy(priceds.filter((p) => p.line.vatRate === r.rate), (p) => (split && r.rate > 0 ? p.line.activity ?? 1 : 1))]
      .map(([activity, ps], _i, all) => ({ rate: r.rate, activity, account: ps[0].line.account, gross: totalsOf(ps).gross, of: all.length > 1 ? ps[0].line.text : undefined })));
    const base = parts.reduce((s, r) => s + toRappen(r.gross), 0);
    let left = gross;
    lines = parts.map((r, k) => {
      const share = k === parts.length - 1 ? left : Math.round(gross * toRappen(r.gross) / base);
      left -= share;
      const named = [rates.length > 1 ? `${r.rate} %` : '', r.of ?? ''].filter(Boolean).join(', ');
      return { text: named ? `${text} (${named})` : text, quantity: 1, price: -fromRappen(share), vatRate: r.rate, ...(r.account ? { account: r.account } : {}), ...(r.activity === 2 ? { activity: 2 as const } : {}) };
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
    ...(prices ? { prices } : {}),
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
 * The VAT code a rate books revenue with (on either basis): the rate's sale code; on the net tax
 * rate method the code of the line's activity, its first or second approved rate (#504), the first
 * when the firm has no second (a line of 2 kept from before it went back to one rate: never a throw
 * in a statement import); none for a firm not registered.
 */
export function revenueVatCode(rate: VatRate, exemption: Exemption | undefined, activity: 1 | 2 = 1): string | undefined {
  if (!vatSetup().registered) return undefined;
  const code = rate === 0 ? vat().codes.deductedIn(invoicing().exemptions[exemption ?? 'export']) : vat().codes.saleAt(rate) ?? vat().codes.netRateCode(activity) ?? vat().codes.netRateCode(1);
  if (!code) throw new Error(`the jurisdiction has no code for a sale at ${rate} %${exemption ? ` (${exemption})` : ''}`);
  return code;
}

/**
 * The revenue a payment of `amount` books, split like the invoice's total over its accounts and
 * rates, so a part payment books the same mix as the whole; a Rabatt lowers each rate and account by
 * its share (`priced`). The parts add up to `amount` exactly.
 */
export function revenueSplit(inv: Pick<InvoiceContent, 'lines' | 'exemption' | 'prices'>, amount: number, revenueAccount: string): Array<{ account: string; vatCode: string | undefined; amount: number }> {
  const groups = new Map<string, { account: string; rate: VatRate; activity: 1 | 2; gross: number }>();
  for (const [rate, parts] of groupBy(priced(inv).parts, (p) => p.line.vatRate)) {
    const rt = totalsOf(parts);
    for (const [key, ps] of groupBy(parts, (p) => `${p.line.account ?? revenueAccount} ${p.line.activity ?? 1}`)) {
      // the rate's VAT goes to its accounts and activities by their share of its net
      const net = toRappen(totalsOf(ps).net);
      const share = toRappen(rt.net) === 0 ? 0 : Math.round(toRappen(rt.vat) * net / toRappen(rt.net));
      groups.set(`${key} ${rate}`, { account: ps[0].line.account ?? revenueAccount, rate, activity: ps[0].line.activity ?? 1, gross: net + share });
    }
  }
  const all = [...groups.values()];
  const whole = all.reduce((s, g) => s + g.gross, 0);
  const pay = toRappen(amount);
  let left = pay;
  return all.map((g, k) => {
    const part = k === all.length - 1 ? left : whole === 0 ? 0 : Math.round(pay * g.gross / whole);
    left -= part;
    return { account: g.account, vatCode: revenueVatCode(g.rate, inv.exemption, g.activity), amount: fromRappen(part) };
  }).filter((p) => p.amount !== 0);
}

function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return out;
}

/** Where the rest of an invoice is written off: the firm's accounts, else the jurisdiction's (modules/<j>/invoicing.yaml writeOff). */
export function writeOffAccounts(settings: Pick<InvoicingSettings, 'writeOffAccount'> | undefined): { skonto: string; loss: string } | undefined {
  return settings?.writeOffAccount ?? invoicing().writeOff;
}

/** Records a payment on an invoice once: the same transaction is never counted twice. */
export function withPayment(inv: Issued, p: PaymentAllocation): Issued {
  if (inv.payments.some((x) => x.transactionRef === p.transactionRef)) return inv;
  return { ...inv, payments: [...inv.payments, p] };
}

/** The document without the payment `transactionRef` («Lösen», r10c-3). */
export const withoutPayment = (inv: Issued, transactionRef: string): Issued => ({ ...inv, payments: inv.payments.filter((p) => p.transactionRef !== transactionRef) });

/** The book without deleted records. */
export const liveInvoices = (book: InvoiceBook): Invoice[] => live(book.invoices);
export const liveCustomers = (book: InvoiceBook): Customer[] => live(book.customers);
