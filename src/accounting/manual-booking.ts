/**
 * A bank payment booked by hand, without the AI (MISSION.md: an accountant without a subscription
 * books what the classifier would): the form's first lines, decided by rules only, and whether
 * the lines add up to the payment. The write is src/server/edits.ts bookPayment.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../types/index.js';
import { partsOf, partText } from './batch-parts.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import { paymentSides, type PaymentSide } from './payment-entries.js';
import { codeOnAccount, formTakes, lookupVatCode } from './vat-codes.js';
import { agreedBasis, chart, filing, vatSetup, withoutInputTax } from '../engines/index.js';
import { fromRappen, toRappen } from './rappen.js';
import { hasEvent, isManualRef } from '../books/refs.js';
import type { Tags } from '../books/tags.js';
import type { Invoice } from '../invoices/model.js';
import { namedInvoice, namesNumber, openAmount, revenueSplit } from '../invoices/rules.js';
import { saleCodeOf, saleProposal, saleVatCode } from './sales-without-vat.js';
import type { SaleChoice } from '../questions/model.js';
import { isPurchaseDocument } from './evidence-check.js';
import { openItemAccounts, sideOf } from './tax-point.js';
import { filingKeyOf } from './periods.js';

/** One line of the booking, in the payment's currency. */
export interface BookingLine { accountDebit: string; accountCredit: string; amount: number; vatCode?: string; description: string; tags?: Tags }

/**
 * Where a proposed account or VAT code of a line comes from, said beside it in a few words (#344):
 * a company rule, the business's last booking, the business's own account (its file), the linked
 * receipt, the issued invoice the payment names, the firm's default account for sales, the owner's
 * account, the app's proposal for a sale without an invoice (saleProposal), a supplier's refund.
 */
export interface DraftSource {
  account?: { from: 'rule'; rule: string } | { from: 'precedent' | 'refund'; date: string } | { from: 'sales' | 'owner' | 'business' | 'bankFee' } | { from: 'invoice' | 'receivable'; number: string };
  vat?: { from: 'rule' | 'precedent' | 'receipt' | 'invoice' | 'netRate' | 'refund' } | { from: 'sale'; choice: SaleChoice };
}

/**
 * What a line's `vat` is as a person would type it: a code, or a receipt's rate («8.1») that the
 * form turns into the code of whatever account stands in the field (vatCodeOf). A receipt gives the
 * rate, never a code, so the code follows the account she chooses (#344). `source`: what of it is a
 * proposal, and from where; `tags`: the dimensions a rule puts on its lines.
 */
export interface DraftLine { accountDebit: string; accountCredit: string; amount: number; vat: string; description: string; source?: DraftSource; tags?: Tags }

/**
 * What a payment is, as the server knows it from the firm's files (src/saving/hand-rule.ts
 * handStart): money between the firm's own accounts, money from the owner (her name in the
 * payment, receipt-wait.ts paysOwner), money from an authority (a business of that role), or a
 * provider's payout that waits for the person (payoutWaitOf, with the words of its reason). None
 * of them is a sale.
 */
export type PaymentNature =
  | { kind: 'ownTransfer' }
  | { kind: 'owner'; account: string }
  | { kind: 'authority'; name: string }
  | { kind: 'payoutWaits'; key: string; params: Record<string, string> }
  /** The bank's own fee row (src/booking/bank-fee.ts): its account, or the one the firm's chart lacks. */
  | { kind: 'bankFee'; account: string } | { kind: 'bankFee'; missing: { account: string; name: string } };

/** What code knows beside the books when the form opens. */
export interface DraftKnowledge {
  /** The firm's default accounts (the setup's): `sales` is proposed for a sale. */
  defaults?: { sales?: string; purchase?: string };
  /** The company rule that decides the payment, with the lines it would book; `ask`: its question, when the rule asks first. */
  rule?: { id: string; lines: ReadonlyArray<{ account: string; vat?: string; amount: number; against?: string }>; ask?: string; tags?: Tags };
  /** What the payment is, beside a sale or a purchase (PaymentNature). */
  nature?: PaymentNature;
  /** The one account the business's file allows (Counterparty.accounts). */
  account?: string;
  /** The account an issued invoice's revenue goes on (invoicing.revenueAccount). */
  invoiceRevenue?: string;
  /** The chart's account numbers: the open-item account (Debitoren) is the first candidate it has. */
  chart?: readonly string[];
  /** The firm's own UID: a linked document with another is a business's, not the firm's own invoice. */
  ownUid?: string;
}

/**
 * A fact the form says under the lines, in plain words: the payment is taken for a sale, it moves
 * money between own accounts, comes from an authority, a supplier's document is linked, a payout
 * waits, the account is hers to choose, the sale's VAT is not read off its document, a rule asks
 * first, or (agreed basis) the receipt is dated in another period than the payment.
 */
export type DraftNote =
  | { kind: 'sale' }
  | { kind: 'refund' }
  | { kind: 'owner' }
  | { kind: 'invoicePaid'; number: string; surplus: number }
  | { kind: 'prepayment'; number: string }
  | { kind: 'unloaded' }
  | { kind: 'ownTransfer' }
  | { kind: 'authority'; name: string }
  | { kind: 'supplierDocument' }
  | { kind: 'payoutWaits'; key: string; params: Record<string, string> }
  | { kind: 'bankChargesMissing'; account: string; name: string }
  | { kind: 'chooseAccount' }
  | { kind: 'saleVat'; why: 'notRead' | 'noVat' }
  | { kind: 'ask'; question: string }
  | { kind: 'taxPoint'; date: string };

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
  /**
   * The payment names an issued invoice: its payment is confirmed on the invoice, which links it.
   * `settles`: the books carry the invoice's event (agreed basis), so its revenue is booked and the
   * payment only settles the receivable; else the invoice's own lines and codes are the proposal.
   */
  invoice?: { id: string; number: string; settles: boolean };
  notes: DraftNote[];
}

type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts'>;

const vatRates = (r: Receipt) => (r.hasSwissVat ? (r.vatSummary ?? []).filter((g) => g.ratePercent > 0) : []);
const gross = (g: NonNullable<Receipt['vatSummary']>[number]) => g.gross ?? (g.net !== undefined ? g.net + g.vat : undefined);
const norm = (s: string | undefined) => s?.toLowerCase().replace(/[^a-z0-9äöü]/g, '') || undefined;
/** A document a sale's VAT may be read off: an invoice or a sales record, never a delivery note, a statement or noise. */
const isSaleDocument = (r: Pick<Receipt, 'kind'>) => r.kind === undefined || r.kind === 'invoice' || r.kind === 'sales-record';

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

/**
 * The newest booking of the same vendor's other payments whose bank stands on `side` and whose other
 * account is not a bank (`only`: of that class), with that entry. Its account on the side opposite
 * the bank is the precedent.
 */
function newestOf(books: Books, tx: BankTransaction, side: 'accountDebit' | 'accountCredit', bankAccounts: Set<string>, only?: string) {
  const mine = vendorKeys(books, tx);
  if (!mine.size) return undefined;
  const other = side === 'accountDebit' ? 'accountCredit' : 'accountDebit';
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const same = new Map<string, boolean>();
  const isSame = (ref: string) => {
    if (!same.has(ref)) { const t = byRef.get(ref); same.set(ref, !!t && [...vendorKeys(books, t)].some((k) => mine.has(k))); }
    return same.get(ref)!;
  };
  // The newest payment's legs: an expense or revenue leg before an asset one (a ladder beside the paint, r6h-27), the larger first.
  const onResult = (e: JournalEntry) => { const t = chart().typeOf(e[other]!); return t === 'expense' || t === 'revenue' ? 1 : 0; };
  const hit = (books.journalEntries ?? [])
    .filter((e) => e.transactionRef !== tx.ref && e.origin !== 'year-close' && bankAccounts.has(e[side]) && e[other] && !bankAccounts.has(e[other]) && (!only || chart().typeOf(e[other]!) === only) && isSame(e.transactionRef))
    .sort((a, b) => b.date.localeCompare(a.date) || onResult(b) - onResult(a) || Number(b.amount) - Number(a.amount))[0];
  return hit && { account: hit[other], vatCode: hit.vatCode, entry: { id: hit.id, transactionRef: hit.transactionRef, date: hit.date } };
}

/**
 * The purchase a payment in from a business the firm buys from would refund: its newest one on an
 * expense, when the payment is no more than the firm paid that business and its text names none of
 * the firm's own invoices. Else undefined: a business that is also a customer pays for a sale.
 */
function refundOf(books: Books, tx: BankTransaction, bankAccounts: Set<string>, amount: number, invoices: readonly Invoice[] | undefined) {
  const bought = newestOf(books, tx, 'accountCredit', bankAccounts, 'expense');
  if (!bought) return undefined;
  const mine = vendorKeys(books, tx);
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const spent = (books.journalEntries ?? []).filter((e) => e.transactionRef !== tx.ref && bankAccounts.has(e.accountCredit) && chart().typeOf(e.accountDebit) === 'expense'
    && [...vendorKeys(books, byRef.get(e.transactionRef) ?? ({ ref: e.transactionRef } as BankTransaction))].some((k) => mine.has(k)))
    .reduce((s, e) => s + toRappen(Number(e.amount)), 0);
  const text = [tx.description, tx.reference ?? ''].join(' ');
  const ours = (invoices ?? []).some((i) => i.status === 'issued' && namesNumber(text, i.number));
  return toRappen(amount) <= spent && !ours ? bought : undefined;
}

/**
 * The draft without any proposal, for a form whose knowledge from the server did not come (a
 * failed or slow request): the bank side and the amounts only, and a note that says so. A client
 * guess would book an owner's deposit or a transfer as revenue.
 */
export function withoutProposal(d: BookingDraft): BookingDraft {
  const lines = d.lines.map((l) => ({
    accountDebit: d.bank?.side === 'accountDebit' ? d.bank.account : '', accountCredit: d.bank?.side === 'accountCredit' ? d.bank.account : '',
    amount: l.amount, vat: '', description: l.description,
  }));
  const { precedent: _p, invoice: _i, ...rest } = d;
  return { ...rest, lines, notes: [{ kind: 'unloaded' }] };
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

/** A code the firm's form takes, else nothing: a proposal never offers a code the booking would refuse. */
const taken = (code: string | null | undefined): string => (code && formTakes(code) ? code : '');

/**
 * The VAT of a sale on the revenue account `account`, as the classifier sets it (saleCodeOf): none
 * for a firm not registered; on the net tax rate method the firm's approved rate's code (abroad by
 * the document); without a document the app's proposal (saleProposal); with one that shows the VAT
 * its rate, which the form turns into the code; with one whose VAT is not read, or that shows none,
 * no code, and the form says why.
 */
function saleVat(tx: BankTransaction, account: string, docs: readonly Receipt[]): { vat: string; source?: DraftSource['vat']; note?: DraftNote } {
  const setup = vatSetup();
  if (!setup.registered) return { vat: '' };
  if (!docs.length) {
    const sale = saleProposal(tx);
    const code = taken(saleVatCode(sale.choice));
    return code ? { vat: code, source: { from: 'sale', choice: sale.choice } } : { vat: '' };
  }
  const decided = saleCodeOf(saleVatCode('saleDomestic') ?? undefined, account, tx, docs, setup);
  if (decided) { const code = taken(decided.code); return code ? { vat: code, source: { from: decided.why === 'netRate' ? 'netRate' : 'receipt' } } : { vat: '' }; }
  const rates = new Set(docs.flatMap(vatRates).map((g) => g.ratePercent));
  // Several rates on one document are a line each (the caller splits them).
  if (rates.size) return { vat: rates.size === 1 ? String([...rates][0]) : '', source: { from: 'receipt' } };
  return { vat: '', note: { kind: 'saleVat', why: docs.some((d) => d.hasSwissVat !== undefined || d.vatSummary?.length) ? 'noVat' : 'notRead' } };
}

/**
 * The booking a person starts from, by rules only (#344): the bank on its side, the amount of the
 * payment, and the other side proposed from what code knows, each proposal naming its source
 * (DraftLine.source) and nothing booked before her click. In this order:
 * - a provider's payout that waits for the person: no proposal, the form says what it waits for;
 * - a payment naming an issued invoice: with its event booked (agreed basis) bank / the receivable
 *   without a code (its revenue is booked), else the invoice's own accounts and codes; the form
 *   names the invoice and the way to confirm the payment on it;
 * - the company rule that decides the payment (also one that asks first, with its question);
 * - the account of the business's last booking;
 * - money from the owner: her account without a code; between own accounts, from an authority, or
 *   with a business's document linked: no account and no code, and the form says what it is;
 * - money back from a business the firm buys from: the account of its last purchase, with the rate
 *   of a linked document that shows it (the code inverts on that account), else the zero code inverted;
 * - other money in: the firm's default revenue account with the sale's VAT (saleVat), and the form
 *   says it took the payment for a sale;
 * - money out: the business's own account (its file), else none, with the receipt's rate filled.
 * A rate comes from a purchase document alone (isPurchaseDocument): no input tax without a receipt
 * that shows it. On the agreed basis a document dated in another period than the payment proposes
 * no account: the hand form books on the payment's day, which its tax point is not (the form says so).
 * Undefined when no payment has the ref.
 */
export function bookingDraft(books: Books, ref: string, accounts: readonly LedgerBankAccount[], invoices?: readonly Invoice[], known: DraftKnowledge = {}): BookingDraft | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) return undefined;
  const named = invoices && tx.direction === 'CRDT' ? namedInvoice(tx, invoices) : undefined;
  const cancelled = named?.cancelled ? { id: named.id, number: named.number } : undefined;
  const issued = named && !cancelled ? named : undefined;
  // What is still open on the bank side: the whole payment, or the rest after lines booked already (one line of a split undone, r9k-2).
  const [side] = paymentSides(books, ref, accounts);
  const open = side ? fromRappen(toRappen(side.paid) - toRappen(side.booked)) : undefined;
  const bank = side && { account: side.account, side: (open ?? side.paid) < 0 ? 'accountCredit' as const : 'accountDebit' as const };
  const paid = open !== undefined ? Math.abs(open) : tx.amount;
  const receiptIds = [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  const receipts = books.receipts.filter((r) => receiptIds.includes(r.id));
  const moneyIn = bank?.side === 'accountDebit';
  // The documents a rate may be read off: on money out a purchase document only (never a delivery note or the firm's own credit note, #81).
  const docs = receipts.filter(moneyIn ? isSaleDocument : isPurchaseDocument);
  const bankAccounts = new Set(accounts.map((a) => a.account));
  const text = receipts.find((r) => r.description)?.description ?? tx.description;
  const notes: DraftNote[] = [];
  const result = (lines: DraftLine[], extra: Partial<BookingDraft> = {}): BookingDraft =>
    ({ ref, date: tx.date, currency: tx.currency, ...(bank && { bank }), receipts: receiptIds, lines, ...(cancelled && { cancelledInvoice: cancelled }), ...extra, notes });
  const place = (account: string, amount: number, vat: string, source?: DraftSource, description = text): DraftLine => ({
    accountDebit: bank?.side === 'accountDebit' ? bank.account : account,
    accountCredit: bank?.side === 'accountCredit' ? bank.account : account,
    amount, vat, description, ...(source && (source.account || source.vat) ? { source } : {}),
  });

  const nature = known.nature;
  // A provider's payout that waits: the person settles what it waits for first; the form proposes nothing.
  if (nature?.kind === 'payoutWaits') { notes.push(nature); return result([place('', paid, '')]); }

  // An issued invoice the payment names: its revenue is the invoice's, booked with it or now.
  if (issued && bank) {
    const invoice = { id: issued.id, number: issued.number };
    const event = hasEvent({ journalEntries: books.journalEntries ?? [] }, issued);
    // A payment before the invoice's date on the agreed basis is a prepayment, taxed on its own day: confirmed on the invoice, which books it so (prepaidEvent).
    if (event && agreedBasis() && tx.date < issued.date) {
      notes.push({ kind: 'prepayment', number: issued.number });
      return result([place('', paid, '')], { invoice: { ...invoice, settles: false } });
    }
    // Only what is still open is the invoice's: the rest (a double payment, say) is the customer's, and the form says so.
    const open = issued.currency === tx.currency ? openAmount(issued, invoices ?? []) : paid;
    const due = Math.min(paid, open);
    const surplus = fromRappen(toRappen(paid) - toRappen(due));
    if (surplus > 0) notes.push({ kind: 'invoicePaid', number: issued.number, surplus });
    const rest = surplus > 0 ? [place('', surplus, '')] : [];
    if (event) {
      const receivable = openItemAccounts(known.chart ?? []).receivable;
      return result([...(due > 0 ? [place(receivable, due, '', { account: { from: 'receivable', number: issued.number } })] : []), ...rest], { invoice: { ...invoice, settles: true } });
    }
    const revenue = known.invoiceRevenue ?? known.defaults?.sales ?? '';
    let split: ReturnType<typeof revenueSplit> = [];
    try { split = revenue && due > 0 ? revenueSplit(issued, due, revenue) : []; } catch { split = []; }
    const lines = split.map((l) => { const code = taken(l.vatCode); return place(l.account, l.amount, code, { account: { from: 'invoice', number: issued.number }, ...(code && { vat: { from: 'invoice' as const } }) }); });
    return result(lines.length || rest.length ? [...lines, ...rest] : [place('', paid, '')], { invoice: { ...invoice, settles: false } });
  }

  // On the agreed basis a coded line of a document is dated by the document (atTaxPoint); the hand form books on the payment's day.
  const length = filing().length;
  const elsewhere = agreedBasis() ? docs.find((r) => r.date && filingKeyOf(r.date, length) !== filingKeyOf(tx.date, length)) : undefined;
  if (elsewhere?.date) notes.push({ kind: 'taxPoint', date: elsewhere.date });
  const proposes = !elsewhere && !cancelled && !!bank;

  // A company rule decides the payment (it waits for its receipt, or asks first): its lines as it would book them, when they add up to what is open.
  const rule = known.rule;
  if (proposes && rule && toRappen(rule.lines.filter((l) => !l.against).reduce((s, l) => s + l.amount, 0)) === toRappen(paid)) {
    if (rule.ask) notes.push({ kind: 'ask', question: rule.ask });
    return result(rule.lines.map((l): DraftLine => {
      const from = { from: 'rule' as const, rule: rule.id };
      const own = (mine: string) => (l.against ? mine : bank!.account);
      const [accountDebit, accountCredit] = moneyIn ? [own(l.against ?? ''), l.account] : [l.account, own(l.against ?? '')];
      return { accountDebit, accountCredit, amount: l.amount, vat: l.vat ?? '', description: text, source: { account: from, ...(l.vat && { vat: { from: 'rule' as const } }) }, ...(rule.tags && { tags: rule.tags }) };
    }));
  }

  // The bank's own fee row: the account code books it on, without a VAT code (#359); or no account, and the form says which one the chart lacks.
  if (proposes && nature?.kind === 'bankFee') {
    if ('missing' in nature) { notes.push({ kind: 'bankChargesMissing', ...nature.missing }); return result([place('', paid, '')]); }
    return result([place(nature.account, paid, '', { account: { from: 'bankFee' } })]);
  }

  // Money for a cancelled invoice is the customer's, not a sale: the earlier sale's account and code would mislead.
  const precedent = proposes ? newestOf(books, tx, bank!.side, bankAccounts) : undefined;
  const extra = precedent ? { precedent: precedent.entry } : {};
  // A firm without input tax has no code for a receipt's rate (r8f-50): no rate is filled that nothing resolves.
  const claims = !withoutInputTax();
  const rates = new Set(docs.flatMap(vatRates).map((g) => g.ratePercent));
  const rate = claims && rates.size === 1 ? String([...rates][0]) : '';
  // The other side and its VAT for a line without a rate of its own.
  let other: { account: string; vat: string; source?: DraftSource } = { account: '', vat: rate, ...(rate && { source: { vat: { from: 'receipt' } } }) };
  const fromReceipt = (vat: string): DraftSource['vat'] | undefined => (vat && vat === rate ? { from: 'receipt' } : undefined);
  if (precedent) {
    const vat = rate || (receipts.length ? '' : withoutReceipt(precedent.vatCode));
    other = { account: precedent.account!, vat, source: { account: { from: 'precedent', date: precedent.entry.date }, ...(vat && { vat: fromReceipt(vat) ?? { from: 'precedent' } }) } };
  } else if (proposes && nature?.kind === 'owner') {
    notes.push({ kind: 'owner' });
    other = { account: nature.account, vat: '', source: { account: { from: 'owner' } } };
  } else if (proposes && (nature?.kind === 'ownTransfer' || nature?.kind === 'authority')) {
    notes.push(nature);
    other = { account: '', vat: '' };
  } else if (proposes && moneyIn) {
    // Money back from a business the firm buys from: a refund on the account of its last purchase, the code inverted on it.
    // Plausible only when it is no more than the firm paid that business, and the text names no invoice of the firm's own.
    const bought = refundOf(books, tx, bankAccounts, paid, invoices);
    const foreign = known.ownUid ? docs.some((d) => d.vatId && norm(d.vatId) !== norm(known.ownUid)) : false;
    if (bought) {
      const refundRate = new Set(claims ? receipts.filter(isPurchaseDocument).flatMap(vatRates).map((g) => g.ratePercent) : []);
      // The purchase's zero code (its own when it was booked without input tax, AGENTS.md: I0 back is -I0), with the minus.
      const booked = bought.vatCode && !bought.vatCode.startsWith('-') ? lookupVatCode(bought.vatCode) : null;
      const zero = inputTaxWithoutReceipt(bought.vatCode) ?? (booked?.entry.kind === 'inputNoVat' ? bought.vatCode : undefined);
      // A rate stays a rate: on the expense's credit side the form makes it the refund's code (-M81).
      const vat = refundRate.size === 1 ? String([...refundRate][0]) : zero ? taken(`-${zero}`) : '';
      notes.push({ kind: 'refund' });
      other = { account: bought.account!, vat, source: { account: { from: 'refund', date: bought.entry.date }, ...(vat && { vat: { from: refundRate.size === 1 ? 'receipt' as const : 'refund' as const } }) } };
    } else if (foreign) {
      notes.push({ kind: 'supplierDocument' });
      other = { account: '', vat: '' };
    } else if (known.defaults?.sales && chart().typeOf(known.defaults.sales) === 'revenue') {
      const sale = saleVat(tx, known.defaults.sales, docs);
      notes.push({ kind: 'sale' });
      if (sale.note) notes.push(sale.note);
      other = { account: known.defaults.sales, vat: sale.vat, source: { account: { from: 'sales' }, ...(sale.source && { vat: sale.source }) } };
    }
  } else if (proposes && known.account && chart().typeOf(known.account)) {
    other = { account: known.account, vat: rate, source: { account: { from: 'business' }, ...(rate && { vat: { from: 'receipt' } }) } };
  }
  if (!moneyIn && rate && !other.account) notes.push({ kind: 'chooseAccount' });

  // A receipt that states several rates adding up to the payment: a line per rate, each with its rate.
  const groups = docs.length === 1 && docs[0].currency === tx.currency && claims && other.vat === rate ? vatRates(docs[0]) : [];
  const split = groups.length > 1 && groups.every((g) => gross(g) !== undefined) && toRappen(groups.reduce((s, g) => s + gross(g)!, 0)) === toRappen(paid);
  const sourced = (vat: string): DraftSource | undefined => {
    const s = { ...(other.source?.account && { account: other.source.account }), ...(vat && other.source?.vat && { vat: other.source.vat }) };
    return s.account || s.vat ? s : undefined;
  };
  // A collective payment (Sammelauftrag): one line per part, named by its payee and reference, when the parts add up to it (r9k-6).
  const parts = partsOf(tx, paid);
  const lines = split ? groups.map((g) => place(other.account, gross(g)!, String(g.ratePercent), { ...(other.source?.account && { account: other.source.account }), vat: { from: 'receipt' } }))
    : parts ? parts.map((p) => place(other.account, Math.abs(p.amount), other.vat, sourced(other.vat), partText(p)))
      : [place(other.account, paid, other.vat, sourced(other.vat))];
  return result(lines, extra);
}

/**
 * The code in the VAT field while she has not touched it, for the accounts in the fields now (#344):
 * a receipt's rate stays a rate, whose code the account gives (vatCodeOf); a sale's code goes when
 * neither account is a revenue account any more; a purchase code takes the family of the account
 * (codeOnAccount), and goes where the account takes none. The proposal's accounts keep its code.
 */
export function followedVat(init: Pick<DraftLine, 'accountDebit' | 'accountCredit' | 'vat'>, accountDebit: string, accountCredit: string): string {
  const code = init.vat;
  if (!code || !lookupVatCode(code) || (accountDebit === init.accountDebit && accountCredit === init.accountCredit)) return code;
  if (sideOf(code) === 'sale' && !/^-?[MI]\d/.test(code)) return [accountDebit, accountCredit].some((a) => a && chart().typeOf(a) === 'revenue') ? code : '';
  if (/^-?[MI]\d/.test(code)) return codeOnAccount(code, accountDebit, accountCredit) ?? '';
  return code;
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
