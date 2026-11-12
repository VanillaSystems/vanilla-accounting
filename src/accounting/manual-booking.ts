/**
 * A bank payment booked by hand, without the AI (MISSION.md: an accountant without a subscription
 * books what the classifier would): the form's first lines, decided by rules only, and whether
 * the lines add up to the payment. The write is src/server/edits.ts bookPayment.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../types/index.js';
import { partsOf, partText } from './batch-parts.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import { paymentSides, type PaymentSide } from './payment-entries.js';
import { codeForRate, formTakes, lookupVatCode } from './vat-codes.js';
import { chart, withoutInputTax } from '../engines/index.js';
import { fromRappen, toRappen } from './rappen.js';
import { isManualRef } from '../books/refs.js';
import type { Tags } from '../books/tags.js';
import type { Invoice } from '../invoices/model.js';
import { namedInvoice } from '../invoices/rules.js';
import { saleProposal, saleVatCode } from './sales-without-vat.js';
import type { SaleChoice } from '../questions/model.js';

/** One line of the booking, in the payment's currency. */
export interface BookingLine { accountDebit: string; accountCredit: string; amount: number; vatCode?: string; description: string; tags?: Tags }

/**
 * Where a proposed account or VAT code of a line comes from, said beside it in a few words (#344):
 * a company rule, the business's last booking, the linked receipt, the firm's default account for
 * sales or purchases, the app's proposal for a sale without an invoice (saleProposal).
 */
export interface DraftSource {
  account?: { from: 'rule'; rule: string } | { from: 'precedent'; date: string } | { from: 'sales' | 'purchase' };
  vat?: { from: 'rule' | 'precedent' | 'receipt' } | { from: 'sale'; choice: SaleChoice };
}

/** What the form opens with. `vat` is as a person would type it: a code, or a receipt's rate («8.1») that becomes a code once the accounts are known. `source`: what of it is a proposal, and from where. */
export interface DraftLine { accountDebit: string; accountCredit: string; amount: number; vat: string; description: string; source?: DraftSource }

/** What code knows beside the books when the form opens: the firm's default accounts (the setup's), and the company rule that decides the payment with the lines it would book. */
export interface DraftKnowledge {
  defaults?: { sales?: string; purchase?: string };
  rule?: { id: string; lines: ReadonlyArray<{ account: string; vat?: string; amount: number; against?: string }> };
}

export interface BookingDraft {
  ref: string;
  /** The payment's: under cash basis every line carries it. */
  date: string;
  currency: string;
  /** The ledger account of the bank the payment moved, and the side it stands on (money out: Haben). */
  bank?: { account: string; side: 'accountDebit' | 'accountCredit' };
  /** The receipts linked now: the entries record them, so a later run keeps the booking. */
  receipts: string[];
  lines: DraftLine[];
  /** The earlier booking of the same vendor the account was taken from. */
  precedent?: Pick<JournalEntry, 'id' | 'transactionRef' | 'date'>;
  /** The payment names an invoice that was cancelled: no revenue, no precedent; the form says so (r8c-5). */
  cancelledInvoice?: { id: string; number: string };
}

type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts'>;

const vatRates = (r: Receipt) => (r.hasSwissVat ? (r.vatSummary ?? []).filter((g) => g.ratePercent > 0) : []);
const gross = (g: NonNullable<Receipt['vatSummary']>[number]) => g.gross ?? (g.net !== undefined ? g.net + g.vat : undefined);
const norm = (s: string | undefined) => s?.toLowerCase().replace(/[^a-z0-9äöü]/g, '') || undefined;

/** The VAT numbers and the vendors of a payment's receipts, each normalized: what names its other party for certain. */
export function receiptKeys(books: Pick<Books, 'mappings' | 'receipts'>, tx: Pick<BankTransaction, 'ref'>): { uids: Set<string>; vendors: Set<string> } {
  const ids = new Set(books.mappings.filter((m) => m.transactionRef === tx.ref).map((m) => m.receiptId));
  const receipts = books.receipts.filter((r) => ids.has(r.id));
  const set = (keys: Array<string | undefined>) => new Set(keys.filter((k): k is string => !!k));
  return { uids: set(receipts.map((r) => norm(r.vatId))), vendors: set(receipts.map((r) => norm(r.title?.vendor))) };
}

/** What names the other party of a payment: the VAT numbers and vendors of its receipts, the bank's counterparty. */
function vendorKeys(books: Books, tx: BankTransaction): Set<string> {
  const { uids, vendors } = receiptKeys(books, tx);
  return new Set([...uids, ...vendors, norm(tx.counterparty)].filter((k): k is string => !!k));
}

/** The account the newest booking of the same vendor used on the side opposite the bank, with that entry. */
function precedentOf(books: Books, tx: BankTransaction, bank: NonNullable<BookingDraft['bank']>, bankAccounts: Set<string>) {
  const mine = vendorKeys(books, tx);
  if (!mine.size) return undefined;
  const other = bank.side === 'accountDebit' ? 'accountCredit' : 'accountDebit';
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const same = new Map<string, boolean>();
  const isSame = (ref: string) => {
    if (!same.has(ref)) { const t = byRef.get(ref); same.set(ref, !!t && [...vendorKeys(books, t)].some((k) => mine.has(k))); }
    return same.get(ref)!;
  };
  // The newest payment's legs: an expense or revenue leg before an asset one (a ladder beside the paint, r6h-27), the larger first.
  const onResult = (e: JournalEntry) => { const t = chart().typeOf(e[other]!); return t === 'expense' || t === 'revenue' ? 1 : 0; };
  const hit = (books.journalEntries ?? [])
    .filter((e) => e.transactionRef !== tx.ref && e.origin !== 'year-close' && bankAccounts.has(e[bank.side]) && e[other] && !bankAccounts.has(e[other]) && isSame(e.transactionRef))
    .sort((a, b) => b.date.localeCompare(a.date) || onResult(b) - onResult(a) || Number(b.amount) - Number(a.amount))[0];
  return hit && { account: hit[other], vatCode: hit.vatCode, entry: { id: hit.id, transactionRef: hit.transactionRef, date: hit.date } };
}

/**
 * The code the app books for a payment without a receipt, from the vendor's last booking (r4c-5):
 * its code, but the zero code where that claimed input tax (no receipt, no input tax); nothing
 * where the firm's form takes no such code.
 */
function withoutReceipt(code: string | undefined): string {
  if (!code || !lookupVatCode(code)) return '';
  const zero = inputTaxWithoutReceipt(code) ?? code;
  return formTakes(zero) ? zero : '';
}

/**
 * The booking a person starts from, by rules only: the bank on its side, the amount of the payment,
 * the receipt's VAT rate as its code (codeForRate), a line per rate when the receipt states several
 * that add up to the payment, and the other side proposed from what code knows, in this order (#344):
 * the company rule that decides the payment (its lines as it would book them), the account of the
 * business's last booking, with a linked receipt on money out the firm's default purchase account,
 * on money in the firm's default revenue account with the code of a sale without an invoice
 * (saleProposal: the question the app asks about such a sale, never a second one). Each proposal
 * names its source (DraftLine.source); nothing is booked before the person's click. No input tax
 * without a receipt that shows it: a rate comes from the receipt alone. Undefined when no payment
 * has the ref.
 */
export function bookingDraft(books: Books, ref: string, accounts: readonly LedgerBankAccount[], invoices?: readonly Invoice[], known: DraftKnowledge = {}): BookingDraft | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) return undefined;
  const named = invoices && tx.direction === 'CRDT' ? namedInvoice(tx, invoices) : undefined;
  const cancelled = named?.cancelled ? { id: named.id, number: named.number } : undefined;
  // What is still open on the bank side: the whole payment, or the rest after lines booked already (one line of a split undone, r9k-2).
  const [side] = paymentSides(books, ref, accounts);
  const open = side ? fromRappen(toRappen(side.paid) - toRappen(side.booked)) : undefined;
  const bank = side && { account: side.account, side: (open ?? side.paid) < 0 ? 'accountCredit' as const : 'accountDebit' as const };
  const paid = open !== undefined ? Math.abs(open) : tx.amount;
  const receiptIds = [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  const receipts = books.receipts.filter((r) => receiptIds.includes(r.id));
  // Money for a cancelled invoice is the customer's, not a sale: the earlier sale's account and code would mislead.
  const precedent = !cancelled && bank ? precedentOf(books, tx, bank, new Set(accounts.map((a) => a.account))) : undefined;
  const text = receipts.find((r) => r.description)?.description ?? tx.description;
  const moneyIn = bank?.side === 'accountDebit';
  const known0 = (a: string | undefined) => (a && chart().typeOf(a) ? a : undefined);
  // The other side: the business's last booking, else the firm's default account (money in: revenue; money out with a receipt: purchases).
  const other: { account: string; source?: NonNullable<DraftSource['account']> } = precedent ? { account: precedent.account!, source: { from: 'precedent', date: precedent.entry.date } }
    : !bank || cancelled ? { account: '' }
      : moneyIn && known0(known.defaults?.sales) ? { account: known.defaults!.sales!, source: { from: 'sales' } }
        : !moneyIn && receipts.length && known0(known.defaults?.purchase) ? { account: known.defaults!.purchase!, source: { from: 'purchase' } }
          : { account: '' };
  const line = (amount: number, rate?: number): DraftLine => {
    const accountDebit = bank?.side === 'accountDebit' ? bank.account : other.account;
    const accountCredit = bank?.side === 'accountCredit' ? bank.account : other.account;
    // A firm without input tax has no code for a receipt's rate (r8f-50): the field stays empty instead of a rate nothing resolves.
    const fromReceipt = rate === undefined || withoutInputTax() ? undefined : codeForRate(rate, accountDebit, accountCredit) ?? String(rate);
    const fromPrecedent = rate === undefined && !receipts.length ? withoutReceipt(precedent?.vatCode) : '';
    // A sale on the default revenue account without a document: the code the app proposes for it (domestic at the normal rate, abroad the export code).
    const sale = rate === undefined && !receipts.length && other.source?.from === 'sales' && chart().typeOf(other.account) === 'revenue' ? saleProposal(tx) : undefined;
    const saleCode = sale && saleVatCode(sale.choice);
    const vat = fromReceipt ?? (fromPrecedent || (saleCode && formTakes(saleCode) ? saleCode : ''));
    const vatSource: DraftSource['vat'] = fromReceipt !== undefined ? { from: 'receipt' } : fromPrecedent ? { from: 'precedent' } : vat && sale ? { from: 'sale', choice: sale.choice } : undefined;
    const source: DraftSource = { ...(other.source && { account: other.source }), ...(vatSource && { vat: vatSource }) };
    return { accountDebit, accountCredit, amount, vat, description: text, ...(Object.keys(source).length ? { source } : {}) };
  };
  // A company rule decides the payment (it waits for its receipt, say): its lines as it would book them, when they add up to what is open.
  const ruled = !cancelled && bank && known.rule && toRappen(known.rule.lines.filter((l) => !l.against).reduce((s, l) => s + l.amount, 0)) === toRappen(paid)
    ? known.rule.lines.map((l): DraftLine => {
      const from = { from: 'rule' as const, rule: known.rule!.id };
      const side = (mine: string) => (l.against ? mine : bank.account);
      const [accountDebit, accountCredit] = moneyIn ? [side(l.against ?? ''), l.account] : [l.account, side(l.against ?? '')];
      return { accountDebit, accountCredit, amount: l.amount, vat: l.vat ?? '', description: text, source: { account: from, ...(l.vat && { vat: { from: 'rule' as const } }) } };
    }) : undefined;
  const groups = receipts.length === 1 && receipts[0].currency === tx.currency ? vatRates(receipts[0]) : [];
  const split = groups.length > 1 && groups.every((g) => gross(g) !== undefined) && toRappen(groups.reduce((s, g) => s + gross(g)!, 0)) === toRappen(paid);
  const rates = new Set(receipts.flatMap(vatRates).map((g) => g.ratePercent));
  // A collective payment (Sammelauftrag): one line per part, named by its payee and reference, when the parts add up to it (r9k-6).
  const parts = partsOf(tx, paid);
  const lines = ruled ?? (split ? groups.map((g) => line(gross(g)!, g.ratePercent))
    : parts ? parts.map((p) => ({ ...line(Math.abs(p.amount)), description: partText(p) }))
      : [line(paid, rates.size === 1 ? [...rates][0] : undefined)]);
  return { ref, date: tx.date, currency: tx.currency, ...(bank && { bank }), receipts: receiptIds, lines, ...(precedent && { precedent: precedent.entry }), ...(cancelled && { cancelledInvoice: cancelled }) };
}

/**
 * The draft the hand form opens with, once the invoices are known: while they load (`'loading'`)
 * there is no form yet, or a payment of a cancelled invoice would open with the earlier sale's
 * account and code and keep them when the invoices arrive (r9c-4). Without invoicing: undefined.
 */
export function formDraft(books: Books, ref: string, accounts: readonly LedgerBankAccount[], invoices: readonly Invoice[] | 'loading' | undefined, known?: DraftKnowledge): BookingDraft | undefined {
  return invoices === 'loading' ? undefined : bookingDraft(books, ref, accounts, invoices, known);
}

/** The payment's bank sides with these lines added to the entries it has (a payment booked in part keeps them, r9k-2). */
const sidesWith = (books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, lines: readonly BookingLine[], accounts: readonly LedgerBankAccount[]) =>
  paymentSides({ transactions: books.transactions, journalEntries: [...(books.journalEntries ?? []).filter((e) => e.transactionRef === ref), ...lines.map((l, i) => ({ id: String(i), transactionRef: ref, date: '', ...l }))] }, ref, accounts);

/** The first bank side these lines would leave off what the bank paid, or undefined when every side adds up. */
export const offSide = (books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, lines: readonly BookingLine[], accounts: readonly LedgerBankAccount[]): PaymentSide | undefined =>
  sidesWith(books, ref, lines, accounts).find((s) => s.booked !== s.paid);

/** What is still to book on the payment's first bank side, in its currency and as the bank paid it (out: positive). */
export function restOf(books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, lines: readonly BookingLine[], accounts: readonly LedgerBankAccount[]): number {
  const [side] = sidesWith(books, ref, lines, accounts);
  return side ? fromRappen((side.paid < 0 ? -1 : 1) * (toRappen(side.paid) - toRappen(side.booked))) : 0;
}

/** A person's booking made without a payment (Buchungen › N): its own ref and its entries. */
export interface Unattached { ref: string; entries: JournalEntry[]; days: number }

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Bookings typed in Buchungen without their payment that may be this unbooked payment's: entries
 * under a ref of their own (no transaction, no receipt linked to it) that move the payment's bank
 * account by exactly what the bank paid, dated within `days` of it. Nearest first. Tying one to the
 * payment marks the payment booked, so a later run does not book it twice.
 */
export function unattachedFor(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings'>, ref: string, accounts: readonly LedgerBankAccount[], days = 10): Unattached[] {
  const tx = books.transactions.find((t) => t.ref === ref);
  const entries = books.journalEntries ?? [];
  if (!tx || entries.some((e) => e.transactionRef === ref)) return [];
  const own = new Set([...books.transactions.map((t) => t.ref), ...books.mappings.map((m) => m.transactionRef)]);
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    if (!isManualRef(e.transactionRef) || own.has(e.transactionRef)) continue;
    groups.set(e.transactionRef, [...(groups.get(e.transactionRef) ?? []), e]);
  }
  return [...groups].flatMap(([own, es]): Unattached[] => {
    if (es.some((e) => e.corrects || e.origin === 'year-close' || (e.exchangeCurrency && e.exchangeCurrency !== tx.currency))) return [];
    const near = Math.max(...es.map((e) => dayDiff(e.date, tx.date)));
    const sides = paymentSides({ transactions: books.transactions, journalEntries: es.map((e) => ({ ...e, transactionRef: ref })) }, ref, accounts);
    if (near > days || !sides.length || sides.some((s) => s.booked !== s.paid)) return [];
    return [{ ref: own, entries: es, days: near }];
  }).sort((a, b) => a.days - b.days || a.ref.localeCompare(b.ref));
}

/**
 * Whether a code deducts input tax (I81, M81, M26-2, …): only a receipt that shows the Swiss VAT
 * allows that, so a payment without one is booked with the zero code of its family, which is returned.
 * Undefined for a firm without input tax: there the code itself is refused (formTakes).
 */
export function inputTaxWithoutReceipt(code: string | undefined): string | undefined {
  const found = code && !withoutInputTax() ? lookupVatCode(code) : null;
  if (!found || found.negative || (found.entry.kind !== 'material' && found.entry.kind !== 'investment')) return undefined;
  return `${found.entry.family}0`;
}
